import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, merchants, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { AtRiskItem, listAtRisk, signalsFromRow, type RiskRow } from "./query.js";

const A = "0199c000-0000-7000-8000-00000000000a";
const B = "0199c000-0000-7000-8000-00000000000b";
const S_RISKY = "0199c000-0000-7000-8000-0000000000a1";
const S_CALM = "0199c000-0000-7000-8000-0000000000a2";
const S_OTHER = "0199c000-0000-7000-8000-0000000000b1";
const NOW = new Date("2026-11-01T12:00:00.000Z");

describe("signalsFromRow", () => {
  it("turns timestamps into day gaps and the interval into days", () => {
    const row: RiskRow = {
      id: S_CALM,
      subscriber_first_name: "Maya",
      plan_name: "Pantry Plan",
      status: "ACTIVE",
      interval_unit: "MONTH",
      interval_count: 2,
      started_at: new Date("2026-10-02T12:00:00.000Z"),
      next_billing_time: new Date("2026-11-03T12:00:00.000Z"),
      last_payment_at: null,
      outstanding_value: null,
      failed_payments_count: 0,
      last_failure_at: new Date("2026-10-30T12:00:00.000Z"),
      prior_pauses: 0,
      prior_downgrades: 0,
      prior_discounts: 0,
      recent_revise: false,
    };
    expect(signalsFromRow(row, NOW)).toMatchObject({
      tenureDays: 30,
      daysToNextBilling: 2,
      daysSinceLastFailure: 2,
      daysSinceLastPayment: null,
      billingIntervalDays: 60,
    });
  });
});

// Needs a Postgres 18 server (KEEPWELL_TEST_DATABASE_URL); skipped without one, like the audit tests.
describe.skipIf(TEST_DATABASE_URL === undefined)("listAtRisk", { timeout: 60_000 }, () => {
  let testDb: TestDatabase;
  let db: Db;

  interface SubOverrides {
    status?: string;
    startedAt: string;
    firstName: string;
    failed?: number;
    lastFailureAt?: string;
    outstanding?: string;
    lastPaymentAt?: string;
  }

  const subscription = (id: string, merchantId: string, over: SubOverrides) => sql`
    INSERT INTO subscriptions (id, merchant_id, paypal_subscription_id, paypal_plan_id, plan_name, status,
      interval_unit, interval_count, price_value, price_currency, started_at, subscriber_first_name,
      failed_payments_count, last_failure_at, outstanding_value, outstanding_currency, last_payment_at,
      snapshot, synced_at)
    VALUES (${id}::uuid, ${merchantId}::uuid, ${`I-${id.slice(-4)}`}, 'P-1', 'Pantry Plan',
      ${over.status ?? "ACTIVE"}, 'MONTH', 1, '10.00', 'USD', ${over.startedAt}::timestamptz,
      ${over.firstName}, ${over.failed ?? 0},
      ${over.lastFailureAt ?? null}::timestamptz,
      ${over.outstanding ?? null}::numeric, 'USD',
      ${over.lastPaymentAt ?? null}::timestamptz, '{}'::jsonb, now())`;

  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    for (const [id, slug] of [
      [A, "alpha"],
      [B, "bravo"],
    ] as const) {
      await db.forMerchant(id, (tx) => tx.insert(merchants).values({ id, slug, name: slug }));
    }
    await db.forMerchant(A, async (tx) => {
      await tx.execute(
        subscription(S_RISKY, A, {
          status: "SUSPENDED",
          startedAt: "2026-10-20T00:00:00Z",
          firstName: "Raj",
          failed: 3,
          lastFailureAt: "2026-10-30T00:00:00Z",
          outstanding: "10.00",
          lastPaymentAt: "2026-09-01T00:00:00Z",
        }),
      );
      await tx.execute(
        subscription(S_CALM, A, {
          startedAt: "2025-01-01T00:00:00Z",
          firstName: "Maya",
          lastPaymentAt: "2026-10-20T00:00:00Z",
        }),
      );
      // A pause the subscriber took in a retention session counts as a prior save.
      await tx.execute(sql`
        INSERT INTO actions (merchant_id, subscription_id, type, params, state, origin)
        VALUES (${A}::uuid, ${S_RISKY}::uuid, 'suspend', '{}'::jsonb, 'CONFIRMED', 'session')`);
    });
    await db.forMerchant(B, (tx) =>
      tx.execute(
        subscription(S_OTHER, B, {
          status: "SUSPENDED",
          startedAt: "2026-10-25T00:00:00Z",
          firstName: "Zed",
          failed: 3,
          lastFailureAt: "2026-10-30T00:00:00Z",
        }),
      ),
    );
  }, 120_000);

  afterAll(async () => {
    await testDb.drop();
  }, 60_000);

  it("returns only at-risk subscriptions, highest first, with factors", async () => {
    const items = await listAtRisk(db, A, { now: NOW });
    expect(items.map((i) => i.subscriptionId)).toEqual([S_RISKY]);
    const [item] = items;
    expect(AtRiskItem.parse(item)).toEqual(item);
    expect(item).toMatchObject({ firstName: "Raj", band: "high" });
    expect(item?.factors.map((f) => f.id)).toContain("prior_pauses");
    expect(item?.score).toBe(item?.factors.reduce((t, f) => t + f.points, 0) ?? -1);
    expect(JSON.stringify(item)).not.toMatch(/@/);
  });

  it("honours minScore and limit", async () => {
    expect(await listAtRisk(db, A, { now: NOW, minScore: 0 })).toHaveLength(2);
    expect(await listAtRisk(db, A, { now: NOW, minScore: 0, limit: 1 })).toHaveLength(1);
    expect(await listAtRisk(db, A, { now: NOW, minScore: 101 })).toEqual([]);
  });

  it("never shows another merchant's subscribers", async () => {
    const ids = (await listAtRisk(db, A, { now: NOW, minScore: 0 })).map((i) => i.subscriptionId);
    expect(ids).not.toContain(S_OTHER);
    expect((await listAtRisk(db, B, { now: NOW })).map((i) => i.subscriptionId)).toEqual([S_OTHER]);
  });
});
