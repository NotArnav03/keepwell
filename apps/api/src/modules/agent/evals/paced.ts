import type { z } from "zod";
import { LlmError, type LlmClient, type LlmPurpose, type StructuredCall } from "../llm.js";

// Evals only. A free plan (Groq's) caps requests and tokens per minute, and a run makes hundreds
// of calls back to back. This slows the run down by making the eval's own roles (the simulated
// subscriber and the judge) wait until minIntervalMs after the last call of any kind started, and
// lets them wait out a rate limit and try again.
//
// The agent's calls never wait and are never retried here. The runtime's 8 s deadline covers a
// whole respond(), so a wait inside it would turn queueing into L1 fallbacks and into latency that
// production doesn't have. Since every agent turn sits between two of the eval's own calls, holding
// those back is enough to pace the agent. An agent call that still fails (a 429 included) drops
// that session to L1 and counts in fallbackRate, exactly as in production.

export interface PacedLlmClientOptions {
  /** How long the eval's own calls wait after the start of the previous call, whatever it was. */
  minIntervalMs: number;
  /** Purposes whose `unavailable` failures are retried after a wait. Never the agent's own. */
  retryPurposes: ReadonlySet<LlmPurpose>;
  /** Waits before each retry; one retry per entry. */
  retryWaitsMs: readonly number[];
  /** A fresh deadline for each retried call, since the caller's has mostly run out by then. */
  retryDeadlineMs: number;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const AGENT_PURPOSES: ReadonlySet<LlmPurpose> = new Set(["classify", "converse"]);

export class PacedLlmClient implements LlmClient {
  private lastStart = Number.NEGATIVE_INFINITY;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly inner: LlmClient,
    private readonly options: PacedLlmClientOptions,
  ) {
    for (const purpose of options.retryPurposes) {
      if (AGENT_PURPOSES.has(purpose)) throw new Error(`the agent's ${purpose} calls must not be retried`);
    }
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  async structured<S extends z.ZodType>(call: StructuredCall<S>): Promise<z.infer<S>> {
    if (AGENT_PURPOSES.has(call.purpose)) {
      this.lastStart = this.now();
      return this.inner.structured(call);
    }
    await this.turn();
    if (!this.options.retryPurposes.has(call.purpose)) return this.inner.structured(call);
    for (let attempt = 0; ; attempt++) {
      try {
        return await (attempt === 0
          ? this.inner.structured(call)
          : this.inner.structured({ ...call, signal: AbortSignal.timeout(this.options.retryDeadlineMs) }));
      } catch (err) {
        const wait = this.options.retryWaitsMs[attempt];
        if (!(err instanceof LlmError) || err.failure !== "unavailable" || wait === undefined) throw err;
        await this.sleep(wait);
        await this.turn();
      }
    }
  }

  /** Waits until minIntervalMs after the last call started. The eval runs one call at a time. */
  private async turn(): Promise<void> {
    const wait = this.lastStart + this.options.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastStart = this.now();
  }
}
