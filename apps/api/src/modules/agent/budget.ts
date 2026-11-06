import { LlmError, type LlmPurpose } from "./llm.js";

// The LLM budget guard (#26, ARCHITECTURE.md §6.5 and §9 "LLM cost runaway"). Before every model
// call: is today's spend under the daily budget, and is this session under its model-time and
// token limits? If not, the call fails as "unavailable" and the session drops to L1, where cancel
// works as always. After every call, its usage is recorded.

/** Cost is kept in whole nano-dollars (1e-9 USD): every price below is an integer per token. */
export type NanoUsd = number;

/** Nano-dollars per token: USD per million tokens × 1000. 5-minute cache writes cost 1.25× input. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  // $0.10 / $0.50 per MTok (prompts up to 100K tokens; ours are a few thousand)
  "claude-haiku-5-5": { input: 100, output: 500, cacheRead: 10, cacheWrite: 125 },
  // $2 / $10 per MTok, cache reads 0.05× input = $0.10 (platform.claude.com pricing page, checked 2026-11-06).
  // Not used by the agent; the copilot (M5) runs on it through this client.
  "claude-sonnet-5-5": { input: 2_000, output: 10_000, cacheRead: 100, cacheWrite: 2_500 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function costOf(model: string, usage: TokenUsage): NanoUsd {
  const price = PRICES[model];
  // An unknown model is a code change that forgot this table; fail loudly rather than count 0.
  if (!price) throw new Error(`No price for model ${model}`);
  return (
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * price.cacheRead +
    usage.cacheWriteTokens * price.cacheWrite
  );
}

/**
 * The most a call can cost before we know its real usage: every input byte priced as a token at the
 * dearest input rate (a cache write), plus a full `maxOutputTokens` of output. Bytes ≥ tokens, so
 * this over-estimates. Throws for a model with no price: an unknown model is not free.
 */
export function worstCaseOf(model: string, inputBytes: number, maxOutputTokens: number): NanoUsd {
  const price = PRICES[model];
  if (!price) throw new Error(`No price for model ${model}`);
  return inputBytes * Math.max(price.input, price.cacheWrite) + maxOutputTokens * price.output;
}

export interface LlmUsageEntry extends TokenUsage {
  at: string;
  /** null for calls outside a session (none yet; insights and recovery copy later). */
  sessionId: string | null;
  purpose: LlmPurpose;
  model: string;
  costNanoUsd: NanoUsd;
  durationMs: number;
}

/** Where usage is kept. M1 backs it with the llm_usage table; the in-memory one is for tests and dev. */
export interface LlmUsageStore {
  /** Total spend on one UTC day ("2026-11-01"). */
  spentOn(day: string): Promise<NanoUsd>;
  sessionTotals(sessionId: string): Promise<{ durationMs: number; tokens: number }>;
  record(entry: LlmUsageEntry): Promise<void>;
}

export class InMemoryLlmUsageStore implements LlmUsageStore {
  readonly entries: LlmUsageEntry[] = [];

  spentOn(day: string): Promise<NanoUsd> {
    const total = this.entries.filter((e) => e.at.startsWith(day)).reduce((sum, e) => sum + e.costNanoUsd, 0);
    return Promise.resolve(total);
  }

  sessionTotals(sessionId: string): Promise<{ durationMs: number; tokens: number }> {
    const mine = this.entries.filter((e) => e.sessionId === sessionId);
    return Promise.resolve({
      durationMs: mine.reduce((sum, e) => sum + e.durationMs, 0),
      tokens: mine.reduce((sum, e) => sum + tokensOf(e), 0),
    });
  }

  record(entry: LlmUsageEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

export interface LlmBudgetOptions {
  store: LlmUsageStore;
  /** LLM_DAILY_BUDGET_USD. A whole UTC day; there's nothing to reset, each day starts at 0. */
  dailyBudgetUsd: number;
  /** §6.5: 20 s of model time per session. */
  sessionModelMs?: number;
  /** §6.5 "a token budget": generous for 3 messages of a few thousand cached tokens each. */
  sessionTokens?: number;
  clock?: () => Date;
}

export const DEFAULT_SESSION_MODEL_MS = 20_000;
export const DEFAULT_SESSION_TOKENS = 60_000;

/** What a call is about to ask of the budget; see `LlmBudget.reserve`. */
export interface SpendRequest {
  sessionId: string | null;
  model: string;
  /** UTF-8 bytes of everything sent: system prompt, input and output schema. */
  inputBytes: number;
  maxOutputTokens: number;
}

/** Held from before the model call until its real usage is recorded. Releasing twice is harmless. */
export interface Reservation {
  release(): void;
}

export class LlmBudget {
  private readonly store: LlmUsageStore;
  private readonly dailyNanoUsd: NanoUsd;
  private readonly sessionModelMs: number;
  private readonly sessionTokens: number;
  private readonly clock: () => Date;

  // The budget lives in one process (one Render instance), so these in-process totals close the
  // gaps the store can't: calls still in flight, and calls the store failed to take.
  private inFlightNanoUsd: NanoUsd = 0;
  private readonly inFlightTokens = new Map<string, number>();
  /** Calls that happened but that the store refused. They still count, and are retried. */
  private readonly unrecorded: LlmUsageEntry[] = [];
  private flushing: Promise<void> | null = null;

  constructor(options: LlmBudgetOptions) {
    if (!Number.isFinite(options.dailyBudgetUsd) || options.dailyBudgetUsd < 0) {
      throw new Error("dailyBudgetUsd must be a non-negative number");
    }
    this.store = options.store;
    this.dailyNanoUsd = Math.round(options.dailyBudgetUsd * 1e9);
    this.sessionModelMs = options.sessionModelMs ?? DEFAULT_SESSION_MODEL_MS;
    this.sessionTokens = options.sessionTokens ?? DEFAULT_SESSION_TOKENS;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Throws LlmError("unavailable") when a call must not be made. Doesn't hold anything. */
  async assertCanSpend(sessionId: string | null): Promise<void> {
    await this.check({ sessionId, estimateNanoUsd: 0, estimateTokens: 0, reserving: false });
  }

  /**
   * Checks the budget and, in the same synchronous step, holds the call's worst-case cost, so
   * calls that overlap can't all pass the same check and overshoot the cap. Call `release()` once
   * the call's real usage has been recorded (or the call failed). Throws LlmError("unavailable")
   * when the call must not be made, including for a model with no price.
   */
  async reserve(request: SpendRequest): Promise<Reservation> {
    let estimateNanoUsd: NanoUsd;
    try {
      estimateNanoUsd = worstCaseOf(request.model, request.inputBytes, request.maxOutputTokens);
    } catch (err) {
      throw new LlmError("unavailable", `No price for model ${request.model}`, { cause: err });
    }
    const estimateTokens = request.inputBytes + request.maxOutputTokens;
    return this.check({ sessionId: request.sessionId, estimateNanoUsd, estimateTokens, reserving: true });
  }

  async record(entry: Omit<LlmUsageEntry, "at" | "costNanoUsd">): Promise<LlmUsageEntry> {
    const full: LlmUsageEntry = {
      ...entry,
      at: this.clock().toISOString(),
      costNanoUsd: costOf(entry.model, entry),
    };
    try {
      await this.store.record(full);
    } catch (err) {
      // The money is spent whether or not the store heard about it: keep counting it.
      this.unrecorded.push(full);
      throw err;
    }
    await this.flushUnrecorded().catch(() => undefined);
    return full;
  }

  /** Unrecorded calls waiting for the store; for logs and tests. */
  get unrecordedCount(): number {
    return this.unrecorded.length;
  }

  /**
   * The store reads are awaited first; everything after them, including taking the hold, is one
   * synchronous step, so no other call can read the in-flight totals between our check and our hold.
   */
  private async check(ask: {
    sessionId: string | null;
    estimateNanoUsd: NanoUsd;
    estimateTokens: number;
    reserving: boolean;
  }): Promise<Reservation> {
    await this.flushUnrecorded().catch(() => undefined);
    const day = this.clock().toISOString().slice(0, 10);
    const stored = await this.store.spentOn(day);
    const session = ask.sessionId === null ? null : await this.store.sessionTotals(ask.sessionId);

    const spent =
      stored +
      this.unrecorded.filter((e) => e.at.startsWith(day)).reduce((sum, e) => sum + e.costNanoUsd, 0) +
      this.inFlightNanoUsd;
    // A reservation refuses a call that *could* take the day past the cap; a bare check refuses
    // only once the cap is already reached.
    if (ask.reserving ? spent + ask.estimateNanoUsd > this.dailyNanoUsd : spent >= this.dailyNanoUsd) {
      throw new LlmError("unavailable", `Daily LLM budget reached for ${day}`);
    }
    if (ask.sessionId === null || session === null) return this.hold(ask);
    const mine = this.unrecorded.filter((e) => e.sessionId === ask.sessionId);
    const durationMs = session.durationMs + mine.reduce((sum, e) => sum + e.durationMs, 0);
    // Model time can't be estimated before a call, so only finished calls count toward it.
    if (durationMs >= this.sessionModelMs) {
      throw new LlmError("unavailable", `Session used its ${this.sessionModelMs} ms of model time`);
    }
    const tokens =
      session.tokens +
      mine.reduce((sum, e) => sum + tokensOf(e), 0) +
      (this.inFlightTokens.get(ask.sessionId) ?? 0);
    if (ask.reserving ? tokens + ask.estimateTokens > this.sessionTokens : tokens >= this.sessionTokens) {
      throw new LlmError("unavailable", `Session used its ${this.sessionTokens} tokens`);
    }
    return this.hold(ask);
  }

  private hold(ask: {
    sessionId: string | null;
    estimateNanoUsd: NanoUsd;
    estimateTokens: number;
    reserving: boolean;
  }): Reservation {
    const { sessionId, estimateNanoUsd: nanoUsd, estimateTokens: tokens } = ask;
    if (!ask.reserving) return { release: () => undefined };
    this.inFlightNanoUsd += nanoUsd;
    if (sessionId !== null)
      this.inFlightTokens.set(sessionId, (this.inFlightTokens.get(sessionId) ?? 0) + tokens);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.inFlightNanoUsd -= nanoUsd;
        if (sessionId === null) return;
        const left = (this.inFlightTokens.get(sessionId) ?? 0) - tokens;
        if (left > 0) this.inFlightTokens.set(sessionId, left);
        else this.inFlightTokens.delete(sessionId);
      },
    };
  }

  /** One drain at a time, so two callers can't both send the same entry. Rejects if the store is still down. */
  private flushUnrecorded(): Promise<void> {
    if (this.unrecorded.length === 0) return Promise.resolve();
    this.flushing ??= this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    for (let next = this.unrecorded[0]; next !== undefined; next = this.unrecorded[0]) {
      await this.store.record(next);
      this.unrecorded.shift();
    }
  }
}

function tokensOf(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}
