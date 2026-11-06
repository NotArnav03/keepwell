import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, llmUsage, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { LlmBudget, type LlmUsageEntry } from "./budget.js";
import { LlmError } from "./llm.js";
import { PgLlmUsageStore } from "./pg-usage-store.js";

// The budget guard's usage store against a real Postgres: per-UTC-day spend, per-session totals,
// and recorded spend that the app role can't rewrite.

const S1 = "0195d6a4-0000-7000-8000-000000000001";
const S2 = "0195d6a4-0000-7000-8000-000000000002";

/** Postgres's SQLSTATE for a refused statement; drizzle wraps the driver error, so look at its cause. */
async function errorCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    for (let e: unknown = err; e instanceof Error; e = e.cause) {
      if ("code" in e && typeof e.code === "string") return e.code;
    }
    throw err;
  }
}

let testDb: TestDatabase;
let db: Db;
let store: PgLlmUsageStore;

const entry = (over: Partial<LlmUsageEntry>): LlmUsageEntry => ({
  at: "2026-11-03T12:00:00.000Z",
  sessionId: S1,
  purpose: "converse",
  model: "claude-haiku-5-5",
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 3000,
  cacheWriteTokens: 0,
  costNanoUsd: 230_000,
  durationMs: 900,
  ...over,
});

describe.skipIf(TEST_DATABASE_URL === undefined)("PgLlmUsageStore", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    store = new PgLlmUsageStore(db);
  }, 120_000);

  afterAll(async () => {
    await testDb.drop();
  }, 60_000);

  beforeEach(async () => {
    // The owner can still clear it between tests; the app role can't (last test).
    await testDb.ownerPool.query("DELETE FROM llm_usage");
  });

  it("sums one UTC day's spend, from its first millisecond up to, not including, the next day", async () => {
    await store.record(entry({ at: "2026-11-02T23:59:59.999Z", costNanoUsd: 1 }));
    await store.record(entry({ at: "2026-11-03T00:00:00.000Z", costNanoUsd: 10 }));
    await store.record(entry({ at: "2026-11-03T23:59:59.999Z", costNanoUsd: 100, sessionId: null }));
    await store.record(entry({ at: "2026-11-04T00:00:00.000Z", costNanoUsd: 1000 }));
    expect(await store.spentOn("2026-11-03")).toBe(110);
    expect(await store.spentOn("2026-11-02")).toBe(1);
    expect(await store.spentOn("2026-11-05")).toBe(0);
    await expect(store.spentOn("3 Nov")).rejects.toThrow(/UTC day/);
  });

  it("totals a session's model time and all four token counts, and nobody else's", async () => {
    await store.record(entry({ durationMs: 900 }));
    await store.record(
      entry({
        durationMs: 1100,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
      }),
    );
    await store.record(entry({ sessionId: S2, durationMs: 5000 }));
    await store.record(entry({ sessionId: null, durationMs: 7000 }));
    expect(await store.sessionTotals(S1)).toEqual({ durationMs: 2000, tokens: 4200 + 100 });
    expect(await store.sessionTotals("0195d6a4-0000-7000-8000-00000000ffff")).toEqual({
      durationMs: 0,
      tokens: 0,
    });
  });

  it("keeps the daily cap across restarts: a new store and budget see what was spent before", async () => {
    const clock = () => new Date("2026-11-03T15:00:00.000Z");
    const before = new LlmBudget({ store, dailyBudgetUsd: 0.000001, clock });
    await before.record({ ...entry({}), sessionId: null });
    // A fresh process: nothing in memory, the spend is still in Postgres.
    const after = new LlmBudget({ store: new PgLlmUsageStore(db), dailyBudgetUsd: 0.000001, clock });
    await expect(after.assertCanSpend(null)).rejects.toBeInstanceOf(LlmError);
  });

  it("is append-only for the app role, so spend can't be reset by rewriting it", async () => {
    await store.record(entry({}));
    const { rows } = await testDb.ownerPool.query<{ insert: boolean; update: boolean; del: boolean }>(
      `SELECT has_table_privilege('keepwell_app', 'llm_usage', 'INSERT') AS insert,
              has_table_privilege('keepwell_app', 'llm_usage', 'UPDATE') AS update,
              has_table_privilege('keepwell_app', 'llm_usage', 'DELETE') AS del`,
    );
    expect(rows[0]).toEqual({ insert: true, update: false, del: false });
    expect([
      await errorCode(() => db.acrossMerchants((tx) => tx.update(llmUsage).set({ costNanoUsd: 0 }))),
      await errorCode(() => db.acrossMerchants((tx) => tx.delete(llmUsage))),
    ]).toEqual(["42501", "42501"]);
    expect(await store.spentOn("2026-11-03")).toBe(230_000);
  });
});
