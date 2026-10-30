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
  // $2 / $10 per MTok
  "claude-sonnet-5-5": { input: 2_000, output: 10_000, cacheRead: 200, cacheWrite: 2_500 },
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

export class LlmBudget {
  private readonly store: LlmUsageStore;
  private readonly dailyNanoUsd: NanoUsd;
  private readonly sessionModelMs: number;
  private readonly sessionTokens: number;
  private readonly clock: () => Date;

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

  /** Throws LlmError("unavailable") when a call must not be made. */
  async assertCanSpend(sessionId: string | null): Promise<void> {
    const day = this.clock().toISOString().slice(0, 10);
    if ((await this.store.spentOn(day)) >= this.dailyNanoUsd) {
      throw new LlmError("unavailable", `Daily LLM budget reached for ${day}`);
    }
    if (sessionId === null) return;
    const used = await this.store.sessionTotals(sessionId);
    if (used.durationMs >= this.sessionModelMs) {
      throw new LlmError("unavailable", `Session used its ${this.sessionModelMs} ms of model time`);
    }
    if (used.tokens >= this.sessionTokens) {
      throw new LlmError("unavailable", `Session used its ${this.sessionTokens} tokens`);
    }
  }

  async record(entry: Omit<LlmUsageEntry, "at" | "costNanoUsd">): Promise<LlmUsageEntry> {
    const full: LlmUsageEntry = {
      ...entry,
      at: this.clock().toISOString(),
      costNanoUsd: costOf(entry.model, entry),
    };
    await this.store.record(full);
    return full;
  }
}

function tokensOf(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}
