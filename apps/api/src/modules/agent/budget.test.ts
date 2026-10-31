import { describe, expect, it } from "vitest";
import { costOf, InMemoryLlmUsageStore, LlmBudget, type LlmUsageEntry } from "./budget.js";
import { LlmError } from "./llm.js";

const entry = (over: Partial<LlmUsageEntry>): LlmUsageEntry => ({
  at: "2026-11-01T10:00:00.000Z",
  sessionId: "s1",
  purpose: "classify",
  model: "claude-haiku-5-5",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costNanoUsd: 0,
  durationMs: 0,
  ...over,
});

describe("costOf", () => {
  it("prices Haiku and Sonnet per token, in whole nano-dollars", () => {
    // A million tokens of each at list price.
    const million = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 };
    expect(costOf("claude-haiku-5-5", million)).toBe((0.1 + 0.5 + 0.01 + 0.125) * 1e9);
    expect(costOf("claude-sonnet-5-5", million)).toBe((2 + 10 + 0.2 + 2.5) * 1e9);
    expect(Number.isInteger(costOf("claude-haiku-5-5", { ...million, inputTokens: 7 }))).toBe(true);
  });

  it("refuses to price a model it doesn't know, rather than count it as free", () => {
    expect(() =>
      costOf("claude-opus-5-5", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ).toThrow("No price for model claude-opus-5-5");
  });
});

describe("LlmBudget", () => {
  it("counts spend per UTC day, so each day starts at zero", async () => {
    const store = new InMemoryLlmUsageStore();
    await store.record(entry({ at: "2026-10-31T23:59:59.000Z", costNanoUsd: 2e9 }));
    await store.record(entry({ at: "2026-11-01T00:00:01.000Z", costNanoUsd: 1e9 }));
    const budget = new LlmBudget({ store, dailyBudgetUsd: 2, clock: () => new Date("2026-11-01T10:00:00Z") });
    await expect(budget.assertCanSpend(null)).resolves.toBeUndefined();
    await store.record(entry({ at: "2026-11-01T09:00:00.000Z", costNanoUsd: 1e9 }));
    await expect(budget.assertCanSpend(null)).rejects.toBeInstanceOf(LlmError);
  });

  it("a zero budget means no model calls at all", async () => {
    const budget = new LlmBudget({ store: new InMemoryLlmUsageStore(), dailyBudgetUsd: 0 });
    await expect(budget.assertCanSpend("s1")).rejects.toMatchObject({ failure: "unavailable" });
  });

  it("rejects a budget that isn't a number", () => {
    expect(() => new LlmBudget({ store: new InMemoryLlmUsageStore(), dailyBudgetUsd: Number.NaN })).toThrow();
    expect(() => new LlmBudget({ store: new InMemoryLlmUsageStore(), dailyBudgetUsd: -1 })).toThrow();
  });
});
