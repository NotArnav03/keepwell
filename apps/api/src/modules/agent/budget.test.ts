import { describe, expect, it } from "vitest";
import {
  costOf,
  InMemoryLlmUsageStore,
  LlmBudget,
  worstCaseOf,
  type LlmUsageEntry,
  type LlmUsageStore,
} from "./budget.js";
import { LlmError, MODEL_FOR } from "./llm.js";

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
    expect(costOf("claude-sonnet-5-5", million)).toBe((2 + 10 + 0.1 + 2.5) * 1e9);
    expect(Number.isInteger(costOf("claude-haiku-5-5", { ...million, inputTokens: 7 }))).toBe(true);
  });

  it("has a price for every model a purpose maps to, so no purpose can cost 'nothing'", () => {
    for (const model of new Set(Object.values(MODEL_FOR))) {
      expect(() => worstCaseOf(model, 1, 1), model).not.toThrow();
    }
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

describe("LlmBudget reservations", () => {
  const NOW = () => new Date("2026-11-01T10:00:00Z");
  const ask = (over: Partial<Parameters<LlmBudget["reserve"]>[0]> = {}) => ({
    sessionId: "s1",
    model: "claude-haiku-5-5",
    inputBytes: 1000,
    maxOutputTokens: 1000,
    ...over,
  });
  // 1000 bytes × 125 (a cache write, Haiku's dearest input rate) + 1000 × 500 = 625,000 nano-dollars.
  const ESTIMATE = 625_000;

  it("prices a call at its worst case: every byte as a cache write, and the full output allowance", () => {
    expect(worstCaseOf("claude-haiku-5-5", 1000, 1000)).toBe(ESTIMATE);
    expect(worstCaseOf("claude-sonnet-5-5", 1000, 1000)).toBe(1000 * 2_500 + 1000 * 10_000);
  });

  it("refuses the second of two overlapping calls when only one fits under the cap", async () => {
    const budget = new LlmBudget({
      store: new InMemoryLlmUsageStore(),
      dailyBudgetUsd: (ESTIMATE * 1.5) / 1e9,
      clock: NOW,
    });
    const results = await Promise.allSettled([
      budget.reserve(ask()),
      budget.reserve(ask({ sessionId: "s2" })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((r) => r.status === "rejected");
    expect(refused).toMatchObject({ reason: { failure: "unavailable" } });
  });

  it("lets the next call through once the first is released", async () => {
    const budget = new LlmBudget({
      store: new InMemoryLlmUsageStore(),
      dailyBudgetUsd: (ESTIMATE * 1.5) / 1e9,
      clock: NOW,
    });
    const first = await budget.reserve(ask());
    await expect(budget.reserve(ask())).rejects.toBeInstanceOf(LlmError);
    first.release();
    first.release(); // releasing twice must not free more than it held
    const second = await budget.reserve(ask());
    await expect(budget.reserve(ask())).rejects.toBeInstanceOf(LlmError);
    second.release();
  });

  it("counts a session's in-flight tokens toward its token limit", async () => {
    const budget = new LlmBudget({
      store: new InMemoryLlmUsageStore(),
      dailyBudgetUsd: 5,
      sessionTokens: 3000,
      clock: NOW,
    });
    await budget.reserve(ask()); // 2,000 estimated tokens in flight
    await expect(budget.reserve(ask())).rejects.toMatchObject({ failure: "unavailable" });
    await expect(budget.reserve(ask({ sessionId: "s2" }))).resolves.toBeDefined();
  });

  it("refuses a model with no price, before any call", async () => {
    const budget = new LlmBudget({ store: new InMemoryLlmUsageStore(), dailyBudgetUsd: 5, clock: NOW });
    await expect(budget.reserve(ask({ model: "claude-opus-5-5" }))).rejects.toMatchObject({
      failure: "unavailable",
      message: "No price for model claude-opus-5-5",
    });
  });

  describe("when the store refuses a record", () => {
    const usage = {
      sessionId: "s1",
      purpose: "classify" as const,
      model: "claude-haiku-5-5",
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 300,
    };
    // 1000 × 100 + 100 × 500 = 150,000 nano-dollars.
    function flakyStore() {
      const inner = new InMemoryLlmUsageStore();
      const state = { down: true, attempts: 0 };
      const store: LlmUsageStore = {
        spentOn: (day) => inner.spentOn(day),
        sessionTotals: (id) => inner.sessionTotals(id),
        record: (entry) => {
          state.attempts += 1;
          return state.down ? Promise.reject(new Error("db down")) : inner.record(entry);
        },
      };
      return { store, inner, state };
    }

    it("keeps counting that spend, so later calls are still held to the cap", async () => {
      const { store } = flakyStore();
      const budget = new LlmBudget({ store, dailyBudgetUsd: 0.0002, clock: NOW });
      await expect(budget.record(usage)).rejects.toThrow("db down");
      expect(budget.unrecordedCount).toBe(1);
      // 150,000 unrecorded + a 625,000 estimate is over the 200,000 cap.
      await expect(budget.reserve(ask())).rejects.toMatchObject({ failure: "unavailable" });
    });

    it("counts unrecorded model time and tokens toward the session's limits", async () => {
      const { store } = flakyStore();
      const budget = new LlmBudget({ store, dailyBudgetUsd: 5, sessionModelMs: 300, clock: NOW });
      await expect(budget.record(usage)).rejects.toThrow();
      await expect(budget.assertCanSpend("s1")).rejects.toMatchObject({ failure: "unavailable" });
      await expect(budget.assertCanSpend("s2")).resolves.toBeUndefined();
    });

    it("writes it to the store, once, as soon as the store is back", async () => {
      const { store, inner, state } = flakyStore();
      const budget = new LlmBudget({ store, dailyBudgetUsd: 5, clock: NOW });
      await expect(budget.record(usage)).rejects.toThrow();
      state.down = false;
      await budget.record({ ...usage, sessionId: "s2" });
      expect(budget.unrecordedCount).toBe(0);
      expect(inner.entries.map((e) => e.sessionId).sort()).toEqual(["s1", "s2"]);
      // Counted once, in the store: not also as unrecorded.
      await budget.assertCanSpend("s1");
      expect(await inner.spentOn("2026-11-01")).toBe(300_000);
    });
  });
});
