import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DomainEvent } from "@keepwell/contracts";
import { FakeActionEngine, FakeNotifier, PANTRY_PLAN } from "@keepwell/contracts/fakes";
import { actions, createDb, dunningCases, merchants, subscriptions, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { DbAudit } from "../audit/log.js";
import { PgPlanCatalog, PgPolicyReader, PgSubscriptionSource } from "./pg-source.js";
import { PgDunningStore } from "./pg-store.js";
import { recoveredRevenue } from "./revenue.js";
import { RecoveryService, VOLUNTARY_SUSPEND_WINDOW_MS } from "./service.js";

// The Postgres side of recovery: the migrated dunning_cases table, row-level security, the
// one-active-case index, the revenue aggregate, and the service end to end on real rows.

const A = "0199d000-0000-7000-8000-00000000000a";
const B = "0199d000-0000-7000-8000-00000000000b";
const NOW = new Date("2026-11-01T12:00:00.000Z");
const RANGE = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-12-01T00:00:00Z") };

let testDb: TestDatabase;
let db: Db;
let svc: RecoveryService<Parameters<Parameters<Db["forMerchant"]>[1]>[0]>;
let notifier: FakeNotifier;
let subA: string;
let subB: string;
const logs: { level: "info" | "warn" | "error"; msg: string }[] = [];

const failed = (
  merchantId: string,
  subscriptionId: string,
  failedCount = 1,
): DomainEvent<"subscription.payment_failed"> => ({
  id: "0199d000-0000-7000-8000-0000000000e1",
  type: "subscription.payment_failed",
  merchantId,
  occurredAt: NOW.toISOString(),
  simulated: false,
  payload: {
    subscriptionId,
    reasonCode: "PAYER_CANNOT_PAY",
    failedCount,
    nextRetryTime: "2026-11-06T12:00:00.000Z",
  },
});

const completed = (
  merchantId: string,
  subscriptionId: string,
): DomainEvent<"subscription.payment_completed"> => ({
  id: "0199d000-0000-7000-8000-0000000000e2",
  type: "subscription.payment_completed",
  merchantId,
  occurredAt: NOW.toISOString(),
  simulated: false,
  payload: { subscriptionId, amount: { value: "12.00", currency: "USD" } },
});

async function seed(id: string, slug: string): Promise<string> {
  return db.forMerchant(id, async (tx) => {
    await tx.insert(merchants).values({ id, slug, name: slug });
    const [row] = await tx
      .insert(subscriptions)
      .values({
        merchantId: id,
        paypalSubscriptionId: `I-${slug.toUpperCase()}`,
        paypalPlanId: "P-STANDARD",
        planName: "Standard",
        status: "ACTIVE",
        intervalUnit: "MONTH",
        intervalCount: 1,
        priceValue: "12.00",
        priceCurrency: "USD",
        startedAt: new Date("2026-03-01T00:00:00Z"),
        snapshot: {},
        syncedAt: NOW,
      })
      .returning({ id: subscriptions.id });
    if (!row) throw new Error("seed failed");
    return row.id;
  });
}

it.runIf(process.env.KEEPWELL_REQUIRE_DATABASE_TESTS === "1" && TEST_DATABASE_URL === undefined)(
  "has a test database when the database tests are required",
  () => {
    expect.fail("KEEPWELL_REQUIRE_DATABASE_TESTS is set but KEEPWELL_TEST_DATABASE_URL is not");
  },
);

describe.skipIf(TEST_DATABASE_URL === undefined)("recovery against Postgres", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    subA = await seed(A, "alpha");
    subB = await seed(B, "bravo");
    notifier = new FakeNotifier(() => NOW);
    svc = new RecoveryService({
      db,
      store: new PgDunningStore(),
      subscriptions: new PgSubscriptionSource(db, {
        // The address is read from PayPal only when a message is actually queued.
        getSubscription: () =>
          Promise.resolve({
            id: "I-RECOVERY",
            plan_id: "P-STANDARD",
            status: "SUSPENDED",
            subscriber: { email_address: "maya@example.com" },
          }),
      }),
      plans: new PgPlanCatalog(db),
      policies: new PgPolicyReader(db),
      notifier,
      actions: new FakeActionEngine({ clock: () => NOW }),
      audit: new DbAudit(db, () => NOW),
      jobs: { send: () => Promise.resolve() },
      config: { portalUrl: "https://portal.example", paypalWebUrl: "https://www.sandbox.paypal.com" },
      log: {
        info: (_obj, msg) => logs.push({ level: "info", msg }),
        warn: (_obj, msg) => logs.push({ level: "warn", msg }),
        error: (_obj, msg) => logs.push({ level: "error", msg }),
      },
      clock: () => NOW,
    });
  }, 120_000);

  afterAll(async () => {
    await testDb.drop();
  }, 60_000);

  it("opens a case row with the contract's columns, and a repeat changes nothing", async () => {
    await svc.onPaymentFailed(failed(A, subA));
    await svc.onPaymentFailed(failed(A, subA));
    const rows = await db.forMerchant(A, (tx) => tx.select().from(dunningCases));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "open",
      playbook: "update_payment_method",
      failedCount: 1,
      simulated: false,
      notificationId: null,
    });
    expect(await new DbAudit(db).verify(A)).toMatchObject({ ok: true, checked: 1 });
  });

  it("allows only one live case per subscription", async () => {
    await expect(
      db.forMerchant(A, (tx) =>
        tx.insert(dunningCases).values({
          merchantId: A,
          subscriptionId: subA,
          reasonCode: "X",
          failedCount: 1,
          playbook: "generic",
          state: "open",
        }),
      ),
    ).rejects.toThrow();
  });

  it("sweeps a case with no message (cross-tenant list, per-merchant work)", async () => {
    const pending = await db.acrossMerchants((tx) => new PgDunningStore().listUnnotified(tx));
    expect(pending.map((c) => c.merchantId)).toContain(A);
  });

  it("recovers the case and the revenue aggregate sums exact decimals", async () => {
    await svc.onPaymentCompleted(completed(A, subA));
    await svc.onPaymentCompleted(completed(A, subA));
    // A second recovered case: failure then payment again.
    await svc.onPaymentFailed(failed(A, subA, 2));
    await svc.onPaymentCompleted(completed(A, subA));
    const revenue = await db.forMerchant(A, (tx) => recoveredRevenue(tx, A, RANGE));
    expect(revenue).toEqual([{ total: { value: "24.00", currency: "USD" }, cases: 2 }]);
    const states = await db.forMerchant(A, (tx) => tx.select({ s: dunningCases.state }).from(dunningCases));
    expect(states.map((r) => r.s)).toEqual(["recovered", "recovered"]);
  });

  it("keeps merchants apart: B sees none of A's cases or revenue", async () => {
    await svc.onPaymentFailed(failed(B, subB));
    expect(await db.forMerchant(B, (tx) => recoveredRevenue(tx, B, RANGE))).toEqual([]);
    // Asking for A's numbers from B's scope finds nothing: row-level security, not just the WHERE.
    expect(await db.forMerchant(B, (tx) => recoveredRevenue(tx, A, RANGE))).toEqual([]);
    const seenByB = await db.forMerchant(B, (tx) => tx.select().from(dunningCases));
    expect(seenByB.every((r) => r.merchantId === B)).toBe(true);
  });

  it("the date range is half-open on the resolve time", async () => {
    const outside = { from: new Date("2027-01-01T00:00:00Z"), to: new Date("2027-02-01T00:00:00Z") };
    expect(await db.forMerchant(A, (tx) => recoveredRevenue(tx, A, outside))).toEqual([]);
  });

  it("the plan catalogue and policy reader return nothing for a merchant with none", async () => {
    expect(await new PgPlanCatalog(db).plans(A)).toEqual([]);
    expect(await new PgPolicyReader(db).current(A)).toBeNull();
    expect(PANTRY_PLAN.merchantId).toBeTruthy();
  });

  // A Keepwell pause and PayPal's failure-threshold suspension look the same on
  // subscription.status_changed. These rows are the difference.
  const reactivateCount = () => notifier.byTemplate("dunning.reactivate").length;

  async function addSubscription(merchantId: string, paypalSubscriptionId: string): Promise<string> {
    return db.forMerchant(merchantId, async (tx) => {
      const [row] = await tx
        .insert(subscriptions)
        .values({
          merchantId,
          paypalSubscriptionId,
          paypalPlanId: "P-STANDARD",
          planName: "Standard",
          status: "ACTIVE",
          intervalUnit: "MONTH",
          intervalCount: 1,
          priceValue: "12.00",
          priceCurrency: "USD",
          startedAt: new Date("2026-03-01T00:00:00Z"),
          subscriberFirstName: "Maya",
          snapshot: {},
          syncedAt: NOW,
        })
        .returning({ id: subscriptions.id });
      if (!row) throw new Error("seed failed");
      return row.id;
    });
  }

  async function showFailures(merchantId: string, subscriptionId: string, failedPaymentsCount: number) {
    await db.forMerchant(merchantId, (tx) =>
      tx
        .update(subscriptions)
        .set({ failedPaymentsCount, status: "SUSPENDED" })
        .where(and(eq(subscriptions.merchantId, merchantId), eq(subscriptions.id, subscriptionId))),
    );
  }

  async function insertSuspend(
    merchantId: string,
    subscriptionId: string,
    opts: {
      agoMs: number;
      origin?: "session" | "recovery";
      state?: "APPLIED" | "CONFIRMED" | "PENDING";
    },
  ): Promise<string> {
    const when = new Date(NOW.getTime() - opts.agoMs);
    const [row] = await db.forMerchant(merchantId, (tx) =>
      tx
        .insert(actions)
        .values({
          merchantId,
          subscriptionId,
          type: "suspend",
          params: { reason: "Subscriber accepted a pause" },
          state: opts.state ?? "APPLIED",
          origin: opts.origin ?? "session",
          createdAt: when,
          updatedAt: when,
        })
        .returning({ id: actions.id }),
    );
    if (!row) throw new Error("action insert failed");
    return row.id;
  }

  const suspended = (
    merchantId: string,
    subscriptionId: string,
  ): DomainEvent<"subscription.status_changed"> => ({
    id: "0199d000-0000-7000-8000-0000000000e3",
    type: "subscription.status_changed",
    merchantId,
    occurredAt: NOW.toISOString(),
    simulated: false,
    payload: { subscriptionId, from: "ACTIVE", to: "SUSPENDED" },
  });

  async function caseRow(merchantId: string, subscriptionId: string) {
    const [row] = await db.forMerchant(merchantId, (tx) =>
      tx.select().from(dunningCases).where(eq(dunningCases.subscriptionId, subscriptionId)),
    );
    return row;
  }

  it("a recent suspend Action we applied does not send dunning.reactivate", async () => {
    const sub = await addSubscription(A, "I-VOLUNTARY");
    await svc.onPaymentFailed(failed(A, sub));
    // Failure evidence is present, so only the Action can suppress the email.
    await showFailures(A, sub, 2);
    const actionId = await insertSuspend(A, sub, { agoMs: 60_000, origin: "session", state: "APPLIED" });
    const before = reactivateCount();
    await svc.onStatusChanged(suspended(A, sub));
    expect(reactivateCount()).toBe(before);
    expect(await caseRow(A, sub)).toMatchObject({ state: "open" });
    const noted = await new DbAudit(db, () => NOW).list(A, {
      kind: "dunning.voluntary_suspend",
      subject: sub,
    });
    expect(noted.entries).toHaveLength(1);
    expect(noted.entries[0]).toMatchObject({
      actor: "system",
      subjectIds: { subscriptionId: sub, actionId },
      payload: { actionId },
    });
    expect(logs.some((l) => l.level === "info" && l.msg.includes("voluntary suspend"))).toBe(true);
    // A replayed status event must not send the email or write a second entry.
    await svc.onStatusChanged(suspended(A, sub));
    expect(reactivateCount()).toBe(before);
    expect(
      (
        await new DbAudit(db, () => NOW).list(A, {
          kind: "dunning.voluntary_suspend",
          subject: sub,
        })
      ).entries,
    ).toHaveLength(1);
    // The case stayed open, so a later failure with a higher count replans this same case.
    await svc.onPaymentFailed(failed(A, sub, 2));
    const rows = await db.forMerchant(A, (tx) =>
      tx.select().from(dunningCases).where(eq(dunningCases.subscriptionId, sub)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "open", failedCount: 2 });
  });

  it("a threshold suspension with failed payments and no recent suspend sends dunning.reactivate once", async () => {
    const sub = await addSubscription(A, "I-THRESHOLD");
    await svc.onPaymentFailed(failed(A, sub));
    await showFailures(A, sub, 3);
    const before = reactivateCount();
    await svc.onStatusChanged(suspended(A, sub));
    await svc.onStatusChanged(suspended(A, sub));
    expect(reactivateCount() - before).toBe(1);
    expect(notifier.byTemplate("dunning.reactivate").at(-1)?.content.template).toBe("dunning.reactivate");
    expect(await caseRow(A, sub)).toMatchObject({ state: "suspended" });
  });

  it("a suspend Action older than the window does not suppress dunning.reactivate", async () => {
    const sub = await addSubscription(A, "I-STALE-PAUSE");
    await svc.onPaymentFailed(failed(A, sub));
    await showFailures(A, sub, 1);
    await insertSuspend(A, sub, {
      agoMs: VOLUNTARY_SUSPEND_WINDOW_MS + 60_000,
      origin: "session",
      state: "APPLIED",
    });
    const before = reactivateCount();
    await svc.onStatusChanged(suspended(A, sub));
    expect(reactivateCount() - before).toBe(1);
  });

  it("a suspend Action started by recovery does not suppress dunning.reactivate", async () => {
    const sub = await addSubscription(A, "I-RECOVERY-SUSPEND");
    await svc.onPaymentFailed(failed(A, sub));
    await showFailures(A, sub, 1);
    await insertSuspend(A, sub, { agoMs: 60_000, origin: "recovery", state: "CONFIRMED" });
    const before = reactivateCount();
    await svc.onStatusChanged(suspended(A, sub));
    expect(reactivateCount() - before).toBe(1);
  });

  it("another merchant's suspend, or one on a different subscription, is ignored", async () => {
    const target = await addSubscription(A, "I-TARGET");
    const other = await addSubscription(A, "I-OTHER-SUB");
    await svc.onPaymentFailed(failed(A, target));
    await showFailures(A, target, 2);
    await insertSuspend(A, other, { agoMs: 60_000, origin: "session", state: "CONFIRMED" });
    // Same subscription id, other merchant: row-level security hides it from A's handler.
    await insertSuspend(B, target, { agoMs: 60_000, origin: "session", state: "APPLIED" });
    const before = reactivateCount();
    await svc.onStatusChanged(suspended(A, target));
    expect(reactivateCount() - before).toBe(1);
    expect(await caseRow(A, target)).toMatchObject({ state: "suspended" });
  });

  it("a CONFIRMED suspend inside the window is a voluntary pause too", async () => {
    const sub = await addSubscription(A, "I-CONFIRMED-PAUSE");
    await svc.onPaymentFailed(failed(A, sub));
    await showFailures(A, sub, 1);
    await insertSuspend(A, sub, { agoMs: 60_000, origin: "session", state: "CONFIRMED" });
    const before = reactivateCount();
    await svc.onStatusChanged(suspended(A, sub));
    expect(reactivateCount()).toBe(before);
    expect(await caseRow(A, sub)).toMatchObject({ state: "open" });
  });

  it("a suspend Action that is still pending does not suppress dunning.reactivate", async () => {
    const sub = await addSubscription(A, "I-PENDING-PAUSE");
    await svc.onPaymentFailed(failed(A, sub));
    await showFailures(A, sub, 1);
    await insertSuspend(A, sub, { agoMs: 60_000, origin: "session", state: "PENDING" });
    const before = reactivateCount();
    await svc.onStatusChanged(suspended(A, sub));
    expect(reactivateCount() - before).toBe(1);
  });

  it("an outstanding balance with no failed payments is still a dunning suspension", async () => {
    const sub = await addSubscription(A, "I-BALANCE");
    await svc.onPaymentFailed(failed(A, sub));
    await db.forMerchant(A, (tx) =>
      tx
        .update(subscriptions)
        .set({
          failedPaymentsCount: 0,
          outstandingValue: "4.00",
          outstandingCurrency: "USD",
          status: "SUSPENDED",
        })
        .where(and(eq(subscriptions.merchantId, A), eq(subscriptions.id, sub))),
    );
    const before = reactivateCount();
    await svc.onStatusChanged(suspended(A, sub));
    expect(reactivateCount() - before).toBe(1);
    expect(await caseRow(A, sub)).toMatchObject({ state: "suspended" });
  });

  it("SUSPENDED with no failed payments and no balance does not send dunning.reactivate", async () => {
    const sub = await addSubscription(A, "I-NO-EVIDENCE");
    await svc.onPaymentFailed(failed(A, sub));
    const before = reactivateCount();
    await svc.onStatusChanged(suspended(A, sub));
    expect(reactivateCount()).toBe(before);
    expect(await caseRow(A, sub)).toMatchObject({ state: "open" });
    const noted = await new DbAudit(db, () => NOW).list(A, { kind: "dunning.case_suspended", subject: sub });
    expect(noted.entries).toHaveLength(0);
  });
});
