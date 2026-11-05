import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { ActionState } from "@keepwell/contracts";
import { uuidv7 } from "@keepwell/contracts/fakes";
import { actions, createDb, insights, merchants, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import type { Pool, PoolClient } from "pg";
import { SqlEstimateInputs } from "./sql-inputs.js";
import { DbInsightActionStore } from "./store.js";

// The store against a real Postgres, where row-level security does the merchant scoping. Runs in
// CI's database job, or locally with KEEPWELL_TEST_DATABASE_URL (skipped without it).

const M1 = "0199a1b2-c3d4-7e5f-8a6b-0000000000a1";
const M2 = "0199a1b2-c3d4-7e5f-8a6b-0000000000a2";
const NOW = new Date("2026-11-01T10:00:00.000Z");
const base = {
  kind: "create_plan" as const,
  params: { name: "Basics" },
  rationale: "why",
  estimate: { monthlyRevenueImpact: { value: "3.60", currency: "USD" }, basis: "basis" },
  proposedBy: "copilot" as const,
};

let testDb: TestDatabase;
let db: Db;
let store: DbInsightActionStore;

// CI's database job sets KEEPWELL_REQUIRE_DATABASE_TESTS, so a missing URL fails there instead of
// silently skipping these tests.
it.runIf(process.env.KEEPWELL_REQUIRE_DATABASE_TESTS === "1" && TEST_DATABASE_URL === undefined)(
  "has a test database when the database tests are required",
  () => {
    expect.fail("KEEPWELL_REQUIRE_DATABASE_TESTS is set but KEEPWELL_TEST_DATABASE_URL is not");
  },
);

describe.skipIf(TEST_DATABASE_URL === undefined)("DbInsightActionStore", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    for (const [id, slug] of [
      [M1, "one"],
      [M2, "two"],
    ] as const) {
      await db.forMerchant(id, (tx) => tx.insert(merchants).values({ id, slug, name: slug }));
    }
    store = new DbInsightActionStore(db, () => NOW);
  });
  afterAll(async () => {
    await testDb?.drop();
  });

  it("creates a proposed row and reads it back through the contract shape", async () => {
    const row = await store.create({ merchantId: M1, ...base });
    expect(row).toMatchObject({ state: "proposed", actionId: null, decidedAt: null, error: null, ...base });
    expect(row.execution).toEqual({ status: "not_applicable" });
    expect(await store.get(M1, row.id)).toEqual(row);
    expect((await store.list(M1, "proposed")).map((r) => r.id)).toContain(row.id);
  });

  it("hides rows from other merchants", async () => {
    const row = await store.create({ merchantId: M1, ...base });
    expect(await store.get(M2, row.id)).toBeNull();
    expect((await store.list(M2)).map((r) => r.id)).not.toContain(row.id);
    expect(await store.transition(M2, row.id, "proposed", "approved")).toBeNull();
    expect((await store.get(M1, row.id))?.state).toBe("proposed");
  });

  it("lets only one of two concurrent approvals win", async () => {
    const row = await store.create({ merchantId: M1, ...base });
    const results = await Promise.all([
      store.transition(M1, row.id, "proposed", "approved"),
      store.transition(M1, row.id, "proposed", "approved"),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("walks proposed -> approved -> failed with decidedAt and the error", async () => {
    const row = await store.create({ merchantId: M1, ...base });
    const approved = await store.transition(M1, row.id, "proposed", "approved");
    expect(approved?.decidedAt).toBe(NOW.toISOString());
    const failed = await store.transition(M1, row.id, "approved", "failed", { error: "boom" });
    expect(failed).toMatchObject({ state: "failed", error: "boom" });
    expect(await store.transition(M1, row.id, "proposed", "rejected")).toBeNull();
  });

  it("counts only this merchant's recent price insights for the estimate", async () => {
    await db.forMerchant(M1, (tx) =>
      tx.insert(insights).values([
        { merchantId: M1, reason: "price", createdAt: new Date(NOW.getTime() - 86_400_000) },
        { merchantId: M1, reason: "price", createdAt: new Date(NOW.getTime() - 40 * 86_400_000) },
        { merchantId: M1, reason: "other", createdAt: NOW },
      ]),
    );
    await db.forMerchant(M2, (tx) =>
      tx.insert(insights).values({ merchantId: M2, reason: "price", createdAt: NOW }),
    );
    const inputs = new SqlEstimateInputs(db, () => NOW);
    expect(await inputs.priceCancellations(M1, 30)).toBe(1);
    expect(await inputs.priceCancellations(M2, 30)).toBe(1);
    expect(await inputs.planFootprints(M1, "USD")).toEqual([]);
  });

  it("reads execution from the linked engine Action as that Action moves", async () => {
    const actionId = uuidv7();
    const paypalError = { code: "PLAN_REJECTED", message: "PayPal rejected the plan" };
    await insertAction(M1, actionId, "PENDING", null);
    const row = await store.create({ merchantId: M1, ...base });
    await store.transition(M1, row.id, "proposed", "approved");
    const executed = await store.transition(M1, row.id, "approved", "executed", { actionId });
    expect(executed).toMatchObject({ state: "executed", actionId, execution: { status: "pending" } });

    for (const state of ["PENDING", "EXECUTING", "RETRY_WAIT", "AWAITING_BUYER", "APPLIED"] as const) {
      await setAction(M1, actionId, state, null);
      expect((await store.get(M1, row.id))?.execution).toEqual({ status: "pending" });
    }

    // A leftover error on a confirmed Action is not a failure.
    await setAction(M1, actionId, "CONFIRMED", { code: "STALE", message: "should not surface" });
    expect((await store.get(M1, row.id))?.execution).toEqual({ status: "confirmed" });
    expect((await store.list(M1)).find((item) => item.id === row.id)?.execution).toEqual({
      status: "confirmed",
    });

    await setAction(M1, actionId, "FAILED", paypalError);
    const failed = { status: "failed" as const, error: paypalError };
    expect((await store.get(M1, row.id))?.execution).toEqual(failed);
    expect((await store.list(M1)).find((item) => item.id === row.id)?.execution).toEqual(failed);

    for (const state of ["ABANDONED", "SUPERSEDED"] as const) {
      await setAction(M1, actionId, state, paypalError);
      expect((await store.get(M1, row.id))?.execution).toEqual(failed);
    }

    await setAction(M1, actionId, "FAILED", null);
    expect((await store.get(M1, row.id))?.execution).toEqual({ status: "failed" });
  });

  it("loads every linked execution in one query", async () => {
    const specs = Array.from({ length: 20 }, (_, i) => {
      const state: ActionState = i < 7 ? "PENDING" : i < 14 ? "CONFIRMED" : "FAILED";
      return {
        actionId: uuidv7(),
        insightId: "",
        state,
        error: state === "FAILED" ? { code: "PLAN_REJECTED", message: `rejected ${i}` } : null,
      };
    });
    await db.forMerchant(M1, (tx) =>
      tx.insert(actions).values(
        specs.map((spec) => ({
          id: spec.actionId,
          merchantId: M1,
          type: "create_plan" as const,
          params: {},
          origin: "insight" as const,
          state: spec.state,
          error: spec.error,
        })),
      ),
    );
    for (const spec of specs) {
      const created = await store.create({ merchantId: M1, ...base });
      spec.insightId = created.id;
      await store.transition(M1, created.id, "proposed", "approved");
      await store.transition(M1, created.id, "approved", "executed", { actionId: spec.actionId });
    }

    const capture = captureQueries(testDb.appPool);
    try {
      const listed = await store.list(M1);
      const mine = listed.filter((item) => specs.some((spec) => spec.insightId === item.id));
      expect(mine).toHaveLength(20);
      for (const spec of specs) {
        const item = mine.find((row) => row.id === spec.insightId);
        const status =
          spec.state === "CONFIRMED" ? "confirmed" : spec.state === "FAILED" ? "failed" : "pending";
        expect(item?.execution.status).toBe(status);
        if (spec.error) expect(item?.execution.error).toEqual(spec.error);
        expect(item?.actionId).toBe(spec.actionId);
      }
      const selects = capture.queries.filter((query) => /\bfrom\b/i.test(query));
      expect(selects).toHaveLength(1);
      expect(selects[0]?.toLowerCase()).toContain("insight_actions");
      expect(selects[0]?.toLowerCase()).toContain("join");
    } finally {
      capture.stop();
    }
  });

  it("does not reveal another merchant's Action through the join", async () => {
    const secret = { code: "LEAKED", message: "other-merchant-paypal-failure" };
    const foreignId = uuidv7();
    await insertAction(M2, foreignId, "FAILED", secret);

    const row = await store.create({ merchantId: M1, ...base, rationale: "mine" });
    await store.transition(M1, row.id, "proposed", "approved");
    const hidden = await store.transition(M1, row.id, "approved", "executed", { actionId: foreignId });
    expect(hidden?.actionId).toBe(foreignId);
    expect(hidden?.execution).toEqual({ status: "not_applicable" });
    expect(JSON.stringify(hidden)).not.toContain("other-merchant-paypal-failure");

    const own = await store.create({ merchantId: M2, ...base, rationale: "secret-m2-rationale" });
    await store.transition(M2, own.id, "proposed", "approved");
    const visible = await store.transition(M2, own.id, "approved", "executed", { actionId: foreignId });
    expect(visible?.execution).toEqual({ status: "failed", error: secret });

    expect(await store.get(M1, own.id)).toBeNull();
    const m1List = JSON.stringify(await store.list(M1));
    expect(m1List).not.toContain("other-merchant-paypal-failure");
    expect(m1List).not.toContain("secret-m2-rationale");
    expect((await store.list(M1)).find((item) => item.id === row.id)?.execution).toEqual({
      status: "not_applicable",
    });
  });
});

async function insertAction(
  merchantId: string,
  id: string,
  state: ActionState,
  error: { code: string; message: string } | null,
): Promise<void> {
  await db.forMerchant(merchantId, (tx) =>
    tx.insert(actions).values({
      id,
      merchantId,
      type: "create_plan",
      params: {},
      origin: "insight",
      state,
      error,
    }),
  );
}

async function setAction(
  merchantId: string,
  id: string,
  state: ActionState,
  error: { code: string; message: string } | null,
): Promise<void> {
  await db.forMerchant(merchantId, (tx) =>
    tx.update(actions).set({ state, error }).where(eq(actions.id, id)),
  );
}

/** Counts SQL on connections checked out while listening. The test pool has no query counter. */
function captureQueries(pool: Pool): { queries: string[]; stop: () => void } {
  const queries: string[] = [];
  const onAcquire = (client: PoolClient): void => {
    const spied = client as PoolClient & { __queries?: string[]; __wrapped?: true };
    spied.__queries = queries;
    if (spied.__wrapped === true) return;
    spied.__wrapped = true;
    const inner = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      const first: unknown = args[0];
      if (typeof first === "string") spied.__queries?.push(first);
      else if (isQueryText(first)) spied.__queries?.push(first.text);
      return (inner as (...innerArgs: unknown[]) => unknown)(...args);
    }) as PoolClient["query"];
  };
  pool.on("acquire", onAcquire);
  return {
    queries,
    stop() {
      pool.removeListener("acquire", onAcquire);
    },
  };
}

function isQueryText(value: unknown): value is { text: string } {
  return typeof value === "object" && value !== null && "text" in value && typeof value.text === "string";
}
