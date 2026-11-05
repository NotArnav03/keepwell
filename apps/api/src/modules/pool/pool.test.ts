import { eq, gt, max } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeDomainEvents, PANTRY_PLAN } from "@keepwell/contracts/fakes";
import { actions, auditLog, createDb, merchants, scheduledResumes, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import {
  createPayPalMock,
  fixtureSubscriptionId,
  PANTRY_PLAN_CREDENTIALS,
  type PayPalMock,
} from "@keepwell/paypal-mock";
import { DbActionEngine } from "../actions/engine.js";
import { DbAudit } from "../audit/log.js";
import { PayPalClient } from "../paypal/client.js";
import { singleAppCredentials } from "../paypal/credentials.js";
import { SubscriptionSync } from "../reconcile/sync.js";
import { DbJudgePool, PoolEntryNotFound } from "./pool.js";

// The pool against paypal-mock and a real Postgres: leases, and what a returned subscription
// needs, decided from PayPal's state.

const M = PANTRY_PLAN.merchantId;
const MAYA = fixtureSubscriptionId("maya");
const PRIYA = fixtureSubscriptionId("priya");
const CHLOE = fixtureSubscriptionId("chloe");
const DIEGO = fixtureSubscriptionId("diego"); // ACTIVE Standard, with a running discount

let testDb: TestDatabase;
let db: Db;
let mock: PayPalMock;
let engine: DbActionEngine;
let pool: DbJudgePool;
let now: Date;
let errors: string[];
let auditFrom: number;

const quiet = { info: () => {}, warn: () => {} };

/** Runs an Action through PayPal to CONFIRMED, as the action.execute and action.confirm jobs would. */
async function runActions() {
  const open = await db.forMerchant(M, (tx) =>
    tx.select({ id: actions.id }).from(actions).where(eq(actions.state, "PENDING")),
  );
  for (const { id } of open) {
    await engine.execute(M, id);
    await engine.confirm(M, id);
  }
  return open.length;
}

/** The pool's audit entries written by the current test. */
async function auditKinds() {
  const rows = await db.forMerchant(M, (tx) =>
    tx
      .select({ kind: auditLog.kind })
      .from(auditLog)
      .where(gt(auditLog.seq, auditFrom))
      .orderBy(auditLog.seq),
  );
  return rows.map((r) => r.kind).filter((k) => k.startsWith("pool."));
}

describe.skipIf(TEST_DATABASE_URL === undefined)("DbJudgePool", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    mock = createPayPalMock();
    const paypal = new PayPalClient({
      baseUrl: await mock.listen(),
      credentials: singleAppCredentials(PANTRY_PLAN_CREDENTIALS),
      log: quiet,
      retryDelaysMs: [],
    });
    await db.forMerchant(M, (tx) =>
      tx.insert(merchants).values({ id: M, slug: "pantry-plan", name: "Pantry Plan", mode: "demo" }),
    );
    const events = new FakeDomainEvents();
    const audit = new DbAudit(db);
    const sync = new SubscriptionSync(db, paypal, events);
    const log = { ...quiet, error: () => {} };
    engine = new DbActionEngine({ db, lockPool: testDb.appPool, paypal, audit, events, log });
    pool = new DbJudgePool({
      db,
      engine,
      sync,
      audit,
      log: { ...quiet, error: (_obj, msg) => errors.push(msg) },
      clock: () => now,
    });
  }, 120_000);

  afterAll(async () => {
    await mock.close();
    await testDb.drop();
  }, 60_000);

  beforeEach(async () => {
    // PayPal back to the fixtures, and an empty pool. The audit log is append-only (even for
    // the owner), so each test reads only the entries after this point.
    mock.reset();
    await testDb.ownerPool.query(
      "DELETE FROM pool_subscriptions; DELETE FROM scheduled_resumes; DELETE FROM actions",
    );
    const [last] = await db.forMerchant(M, (tx) => tx.select({ seq: max(auditLog.seq) }).from(auditLog));
    auditFrom = last?.seq ?? 0;
    now = new Date();
    errors = [];
  });

  it("enrolls ACTIVE subscriptions on the pool's plan, once", async () => {
    expect(await pool.enroll(M, MAYA)).toBe(true);
    expect(await pool.enroll(M, MAYA)).toBe(false);
    await expect(pool.enroll(M, fixtureSubscriptionId("lena"))).rejects.toThrow(/Lite/); // another plan
    await expect(pool.enroll(M, fixtureSubscriptionId("ana"))).rejects.toThrow(/SUSPENDED/);
    expect(await pool.counts(M)).toEqual({ available: 1, leased: 0, restoring: 0, consumed: 0 });
    expect(await auditKinds()).toEqual(["pool.enrolled"]);
  });

  it("leases each subscription to one judge at a time, oldest first, and says when it's empty", async () => {
    for (const id of [MAYA, PRIYA, CHLOE]) await pool.enroll(M, id);
    const [a, b] = await Promise.all([pool.lease(M), pool.lease(M)]);
    expect(new Set([a?.paypalSubscriptionId, b?.paypalSubscriptionId])).toEqual(new Set([MAYA, PRIYA]));
    const c = await pool.lease(M, { minutes: 10 });
    expect(c).toMatchObject({ paypalSubscriptionId: CHLOE });
    // Whole seconds, so a lease token's exp names the lease exactly.
    expect(Date.parse(c?.leasedUntil ?? "")).toBe(Math.floor((now.getTime() + 10 * 60_000) / 1000) * 1000);
    expect(await pool.lease(M)).toBeNull();
    expect(await pool.counts(M)).toMatchObject({ available: 0, leased: 3 });
  });

  it("takes an untouched subscription back, and rests it before lending it again", async () => {
    await pool.enroll(M, MAYA);
    const lease = await pool.lease(M);
    expect(await pool.release(M, lease?.poolEntryId ?? "")).toBe("available");
    // A widget token minted just before the return lives 10 minutes: nobody else gets it until then.
    expect(await pool.lease(M)).toBeNull();
    now = new Date(now.getTime() + 10 * 60_000);
    expect(await pool.lease(M)).toMatchObject({ paypalSubscriptionId: MAYA });
    expect(await auditKinds()).toEqual(["pool.enrolled", "pool.leased", "pool.returned", "pool.leased"]);
  });

  it("names a lease by entry and leasedUntil, so a returned lease reaches nothing after it", async () => {
    for (const id of [MAYA, PRIYA]) await pool.enroll(M, id);
    const a = await pool.lease(M);
    if (!a) throw new Error("no lease");
    expect(a.paypalSubscriptionId).toBe(MAYA);
    expect(await pool.holds(M, a.poolEntryId, a.leasedUntil)).toBe(true);
    const later = new Date(Date.parse(a.leasedUntil) + 1000).toISOString();
    expect(await pool.holds(M, a.poolEntryId, later)).toBe(false);

    expect(await pool.release(M, a.poolEntryId, a.leasedUntil)).toBe("available");
    expect(await pool.holds(M, a.poolEntryId, a.leasedUntil)).toBe(false);
    expect(await pool.release(M, a.poolEntryId, a.leasedUntil)).toBeNull(); // a double click

    // Rested: the entry never lent goes first, then Maya's, under a new leasedUntil.
    now = new Date(now.getTime() + 11 * 60_000);
    expect(await pool.lease(M)).toMatchObject({ paypalSubscriptionId: PRIYA });
    const c = await pool.lease(M);
    if (!c) throw new Error("no lease");
    expect(c.poolEntryId).toBe(a.poolEntryId);
    // The old lease's token names the same entry, and still reaches nothing.
    expect(await pool.holds(M, a.poolEntryId, a.leasedUntil)).toBe(false);
    expect(await pool.release(M, a.poolEntryId, a.leasedUntil)).toBeNull();
    expect(await pool.holds(M, c.poolEntryId, c.leasedUntil)).toBe(true);
    expect(await pool.counts(M)).toMatchObject({ available: 0, leased: 2 });

    // Past its end, a lease isn't held even before the sweep takes it back.
    now = new Date(Date.parse(c.leasedUntil) + 1000);
    expect(await pool.holds(M, c.poolEntryId, c.leasedUntil)).toBe(false);
  });

  it("activates a paused subscription before the next judge, and cancels the pause's resume", async () => {
    await pool.enroll(M, MAYA);
    const lease = await pool.lease(M);
    // The judge pauses, as the sessions module would: suspend plus a resume in a month.
    await db.forMerchant(M, async (tx) => {
      const suspend = await engine.create(
        {
          merchantId: M,
          subscriptionId: lease?.subscriptionId ?? "",
          type: "suspend",
          origin: "session",
          params: { reason: "Paused for a month" },
        },
        tx,
      );
      const dueAt = new Date(now.getTime() + 30 * 86_400_000).toISOString();
      await engine.scheduleResume(
        { merchantId: M, subscriptionId: lease?.subscriptionId ?? "", dueAt, afterActionId: suspend.id },
        tx,
      );
    });
    await runActions();
    expect(mock.state.getSubscription(M, MAYA).status).toBe("SUSPENDED");

    expect(await pool.release(M, lease?.poolEntryId ?? "")).toBe("restoring");
    expect(await pool.lease(M)).toBeNull();
    const resumes = await db.forMerchant(M, (tx) => tx.select().from(scheduledResumes));
    expect(resumes.map((r) => r.status)).toEqual(["cancelled"]);

    expect(await runActions()).toBe(1); // the activate
    expect(mock.state.getSubscription(M, MAYA).status).toBe("ACTIVE");
    expect(await pool.sweep(M)).toMatchObject({ available: 1, restoring: 0 });
  });

  it("puts the plan price back on a discounted subscription", async () => {
    await pool.enroll(M, DIEGO);
    const lease = await pool.lease(M);
    expect(await pool.release(M, lease?.poolEntryId ?? "")).toBe("restoring");
    await runActions();
    expect(mock.state.effectivePlan(M, mock.state.getSubscription(M, DIEGO)).billing_cycles[0]).toMatchObject(
      {
        pricing_scheme: { fixed_price: { value: "12.00" } },
      },
    );
    expect(await pool.sweep(M)).toMatchObject({ available: 1 });
  });

  it("consumes a subscription that was cancelled or moved to another plan", async () => {
    await pool.enroll(M, MAYA);
    await pool.enroll(M, PRIYA);
    const cancelled = await pool.lease(M);
    const downgraded = await pool.lease(M);
    mock.state.cancelInPayPal(MAYA);
    const token = mock.state.revise(M, PRIYA, "P-PANTRY-LITE", { returnUrl: null, cancelUrl: null });
    mock.state.decideRevision(token, true);

    expect(await pool.release(M, cancelled?.poolEntryId ?? "")).toBe("consumed");
    expect(await pool.release(M, downgraded?.poolEntryId ?? "")).toBe("consumed");
    expect(await pool.counts(M)).toEqual({ available: 0, leased: 0, restoring: 0, consumed: 2 });
    await expect(pool.release(M, "0195d6a4-0000-7000-8000-000000000000")).rejects.toBeInstanceOf(
      PoolEntryNotFound,
    );
  });

  it("takes back expired leases on its own, and alerts when the pool runs low", async () => {
    await pool.enroll(M, MAYA);
    await pool.lease(M, { minutes: 30 });
    expect(await pool.sweep(M)).toMatchObject({ leased: 1 }); // not expired yet
    now = new Date(now.getTime() + 31 * 60_000);
    expect(await pool.sweep(M)).toMatchObject({ available: 1, leased: 0 });
    expect(errors.at(-1)).toMatch(/judge pool below 40/);
  });
});
