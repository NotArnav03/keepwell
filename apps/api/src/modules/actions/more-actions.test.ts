import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeAudit, FakeDomainEvents, PANTRY_PLAN } from "@keepwell/contracts/fakes";
import { createDb, merchants, subscriptions, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import {
  createPayPalMock,
  fixtureSubscriptionId,
  PANTRY_PLAN_CREDENTIALS,
  type PayPalMock,
} from "@keepwell/paypal-mock";
import { PayPalClient } from "../paypal/client.js";
import { singleAppCredentials } from "../paypal/credentials.js";
import { DbActionEngine } from "./engine.js";
import { reviseReturn } from "./revise-return.js";

// Revise, price patch, refund, capture and create_plan (#13) against paypal-mock and a real
// Postgres, with the same engine guarantees the status changes have.

const M = PANTRY_PLAN.merchantId;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

let testDb: TestDatabase;
let db: Db;
let mock: PayPalMock;
let client: PayPalClient;
let engine: DbActionEngine;
let now: Date;
const subId: Record<string, string> = {};

const make = (type: string, name: string | null, params: Record<string, unknown>) =>
  engine.create({
    merchantId: M,
    subscriptionId: name === null ? null : (subId[name] ?? null),
    type,
    origin: "session",
    params,
  } as Parameters<DbActionEngine["create"]>[0]);

const paypalSub = (name: string) => mock.state.getSubscription(M, fixtureSubscriptionId(name));
const later = (ms: number) => (now = new Date(now.getTime() + ms));

it.runIf(process.env.KEEPWELL_REQUIRE_DATABASE_TESTS === "1" && TEST_DATABASE_URL === undefined)(
  "has a test database when the database tests are required",
  () => {
    expect.fail("KEEPWELL_REQUIRE_DATABASE_TESTS is set but KEEPWELL_TEST_DATABASE_URL is not");
  },
);

describe.skipIf(TEST_DATABASE_URL === undefined)("more Action types", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    await db.forMerchant(M, async (tx) => {
      await tx.insert(merchants).values({ id: M, slug: "pantry-plan", name: "Pantry Plan" });
      for (const name of ["maya", "raj", "lena", "chloe"]) {
        const [row] = await tx
          .insert(subscriptions)
          .values({
            merchantId: M,
            paypalSubscriptionId: fixtureSubscriptionId(name),
            paypalPlanId: PANTRY_PLAN.standard.planId,
            planName: "Standard",
            status: "ACTIVE",
            intervalUnit: "MONTH",
            intervalCount: 1,
            priceValue: "12.00",
            priceCurrency: "USD",
            startedAt: new Date("2026-03-01T00:00:00Z"),
            snapshot: {},
            syncedAt: new Date(),
          })
          .returning({ id: subscriptions.id });
        if (row) subId[name] = row.id;
      }
    });
  }, 120_000);

  afterAll(async () => {
    await testDb.drop();
  }, 60_000);

  beforeEach(async () => {
    mock = createPayPalMock();
    const url = await mock.listen();
    client = new PayPalClient({
      baseUrl: url,
      credentials: singleAppCredentials(PANTRY_PLAN_CREDENTIALS),
      log: quiet,
      retryDelaysMs: [],
    });
    now = new Date();
    engine = new DbActionEngine({
      db,
      lockPool: testDb.appPool,
      paypal: client,
      audit: new FakeAudit(),
      events: new FakeDomainEvents(),
      log: quiet,
      clock: () => now,
      retryDelaysMs: [60_000],
      random: () => 0.5,
      publicBaseUrl: "https://api.keepwell.example",
    });
  });

  afterEach(async () => {
    await mock.close();
  });

  describe("revise", () => {
    it("waits on the buyer, then completes from PayPal's truth when they come back", async () => {
      const action = await make("revise", "maya", { planId: PANTRY_PLAN.lite.planId });
      expect(await engine.execute(M, action.id)).toBe("awaiting_buyer");
      const waiting = await engine.get(M, action.id);
      expect(waiting?.state).toBe("AWAITING_BUYER");
      expect(waiting?.approveUrl).toContain("ba_token=");
      // Before the buyer acts, the return finds nothing changed and keeps waiting.
      expect(await engine.completeRevise(M, action.id, false)).toBe("pending");

      mock.state.decideRevision(new URL(waiting?.approveUrl ?? "").searchParams.get("ba_token") ?? "", true);
      expect(await engine.completeRevise(M, action.id, false)).toBe("confirmed");
      expect(paypalSub("maya").plan_id).toBe(PANTRY_PLAN.lite.planId);
      expect(await engine.get(M, action.id)).toMatchObject({ state: "CONFIRMED" });
    });

    it("is abandoned when the buyer cancels on PayPal's page", async () => {
      const action = await make("revise", "raj", { planId: PANTRY_PLAN.lite.planId });
      await engine.execute(M, action.id);
      expect(await engine.completeRevise(M, action.id, true)).toBe("abandoned");
      expect(await engine.get(M, action.id)).toMatchObject({
        state: "ABANDONED",
        error: { code: "BUYER_CANCELLED" },
      });
    });

    it("is confirmed by a sync when the buyer approved and closed the tab", async () => {
      const action = await make("revise", "lena", { planId: PANTRY_PLAN.lite.planId });
      await engine.execute(M, action.id);
      const token =
        new URL((await engine.get(M, action.id))?.approveUrl ?? "").searchParams.get("ba_token") ?? "";
      mock.state.decideRevision(token, true);
      const snapshot = {
        id: subId.lena ?? "",
        merchantId: M,
        paypalSubscriptionId: fixtureSubscriptionId("lena"),
        paypalPlanId: PANTRY_PLAN.lite.planId,
        planName: "Lite",
        price: { value: "6.00", currency: "USD" },
        priceOverride: null,
        interval: { unit: "MONTH" as const, count: 1 },
        status: "ACTIVE" as const,
        startedAt: now.toISOString(),
        nextBillingTime: null,
        lastPayment: null,
        outstandingBalance: null,
        failedPaymentsCount: 0,
        lastFailure: null,
        subscriberFirstName: "Lena",
        syncedAt: now.toISOString(),
      };
      expect(await engine.confirmFromSync(M, snapshot)).toEqual([action.id]);
      expect(await engine.get(M, action.id)).toMatchObject({ state: "CONFIRMED" });
    });

    it("expires a link nobody used", async () => {
      const action = await make("revise", "chloe", { planId: PANTRY_PLAN.lite.planId });
      await engine.execute(M, action.id);
      expect(await engine.abandonStaleApprovals()).toEqual([]);
      later(4 * 60 * 60_000);
      expect(await engine.abandonStaleApprovals()).toEqual([action.id]);
    });

    it("serves the return page PayPal redirects the buyer to", async () => {
      const action = await make("revise", "maya", { planId: PANTRY_PLAN.annual.planId });
      await engine.execute(M, action.id);
      const app = Fastify();
      await app.register(reviseReturn, { prefix: "/v1", db, engine });
      const res = await app.inject({ url: `/v1/revise/return?action=${action.id}&cancelled=1` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("Nothing changed");
      expect(res.body).toContain('"outcome":"abandoned"');
      expect((await app.inject({ url: "/v1/revise/return?action=nope" })).statusCode).toBe(400);
      await app.close();
    });
  });

  it("patches the price for a discount, confirms it from PayPal, then removes it", async () => {
    const discount = await make("patch_price", "chloe", { fixedPrice: { value: "9.00", currency: "USD" } });
    expect(await engine.execute(M, discount.id)).toBe("applied");
    expect(await engine.confirm(M, discount.id)).toBe("confirmed");
    const back = await make("patch_price", "chloe", { fixedPrice: null });
    await engine.execute(M, back.id);
    expect(await engine.confirm(M, back.id)).toBe("confirmed");
    const plan = mock.state.effectivePlan(M, paypalSub("chloe"));
    expect(plan.billing_cycles[0]?.pricing_scheme.fixed_price.value).toBe("12.00");
  });

  it("refunds once even when the first response is lost (PayPal-Request-Id = Action id)", async () => {
    const [last] = (
      await client.listTransactions(M, fixtureSubscriptionId("maya"), {
        start: "2025-01-01T00:00:00Z",
        end: "2027-01-01T00:00:00Z",
      })
    ).slice(-1);
    mock.failures.add({ path: /\/refund$/, status: 500, apply: true });
    const refund = await make("refund", "maya", {
      transactionId: last?.id ?? "",
      amount: { value: "6.00", currency: "USD" },
    });
    expect(await engine.execute(M, refund.id)).toBe("retry_scheduled");
    later(61_000);
    expect(await engine.execute(M, refund.id)).toBe("applied");
    expect(await engine.get(M, refund.id)).toMatchObject({ state: "CONFIRMED" });
    const transactions = await client.listTransactions(M, fixtureSubscriptionId("maya"), {
      start: "2025-01-01T00:00:00Z",
      end: "2027-01-01T00:00:00Z",
    });
    // Refunded 6.00 of 12.00 exactly once: a second refund would have made it REFUNDED.
    expect(transactions.at(-1)?.status).toBe("PARTIALLY_REFUNDED");
  });

  it("captures an outstanding balance", async () => {
    const capture = await make("capture_outstanding", "raj", { amount: { value: "24.00", currency: "USD" } });
    expect(await engine.execute(M, capture.id)).toBe("applied");
    expect(await engine.get(M, capture.id)).toMatchObject({ state: "CONFIRMED" });
    expect(paypalSub("raj").billing_info?.outstanding_balance.value).toBe("0.00");
  });

  it("creates a plan with no subscription, once, even after a lost response", async () => {
    mock.failures.add({ method: "POST", path: "/v1/billing/plans", status: 500, apply: true });
    const create = await make("create_plan", null, {
      productId: "PROD-PANTRYPLAN",
      name: "Standard quarterly",
      price: { value: "33.00", currency: "USD" },
      interval: { unit: "MONTH", count: 3 },
    });
    expect(await engine.execute(M, create.id)).toBe("retry_scheduled");
    later(61_000);
    expect(await engine.execute(M, create.id)).toBe("applied");
    const done = await engine.get(M, create.id);
    expect(done?.state).toBe("CONFIRMED");
    const named = mock.state
      .listPlans(M, null, { page: 1, pageSize: 20 })
      .items.filter((p) => p.name === "Standard quarterly");
    expect(named).toHaveLength(1);
  });
});
