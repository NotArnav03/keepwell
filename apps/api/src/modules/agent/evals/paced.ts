import type { z } from "zod";
import { LlmError, type LlmClient, type LlmPurpose, type StructuredCall } from "../llm.js";

// Evals only. A free plan (Groq's) caps requests and tokens per minute, and a full run makes
// thousands of calls back to back. This spaces calls out, and lets the eval's own roles (the
// simulated subscriber and the judge) wait out a rate limit and try again.
//
// The agent's calls are never retried here: an agent call that fails still drops that session to
// L1 and counts in fallbackRate, exactly as in production. Waiting for a call's turn does come out
// of the agent's 8 s deadline, so keep minIntervalMs well under it.

export interface PacedLlmClientOptions {
  /** The least time between the starts of two calls. */
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
  private nextSlot = 0;
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

  /** Waits for this call's slot; slots are handed out in order, minIntervalMs apart. */
  private async turn(): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.options.minIntervalMs;
    if (slot > now) await this.sleep(slot - now);
  }
}
