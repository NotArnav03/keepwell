import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeActionEngine, FakeNotifier } from "@keepwell/contracts/fakes";
import { createDb, dunningCases, merchants, subscriptions, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { DbAudit } from "../audit/log.js";
import { DbDomainEvents } from "../jobs/domain-events.js";
import { Jobs } from "../jobs/jobs.js";
import { mountRecovery } from "./mount.js";

// The whole path on real parts: DbDomainEvents -> domain.dispatch -> handler -> dunning.evaluate
// job (pg-boss) -> worker -> Notifier, then the recovery event, and the due-sweep hook.

const M = "0199e000-0000-7000-8000-00000000000a";
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

let testDb: TestDatabase;
let db: Db;
let jobs: Jobs;
let events: DbDomainEvents;
let notifier: FakeNotifier;
let subId: string;
const dueWork: (() => Promise<void>)[] = [];

async function until(check: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const caseState = async () => (await db.forMerchant(M, (tx) => tx.select().from(dunningCases)))[0];

it.runIf(process.env.KEEPWELL_REQUIRE_DATABASE_TESTS === "1" && TEST_DATABASE_URL === undefined)(
  "has a test database when the database tests are required",
  () => {
    expect.fail("KEEPWELL_REQUIRE_DATABASE_TESTS is set but KEEPWELL_TEST_DATABASE_URL is not");
  },
);

describe.skipIf(TEST_DATABASE_URL === undefined)(
  "recovery wired into the platform",
  { timeout: 90_000 },
  () => {
    beforeAll(async () => {
      testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
      db = createDb(testDb.appPool);
      subId = await db.forMerchant(M, async (tx) => {
        await tx.insert(merchants).values({ id: M, slug: "wiring", name: "Wiring" });
        const [row] = await tx
          .insert(subscriptions)
          .values({
            merchantId: M,
            paypalSubscriptionId: "I-WIRING",
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
            syncedAt: new Date(),
          })
          .returning({ id: subscriptions.id });
        if (!row) throw new Error("seed failed");
        return row.id;
      });
      jobs = await Jobs.start({
        connectionString: testDb.url,
        log: quiet,
        pollingIntervalSeconds: 0.5,
        retryDelaySeconds: 1,
      });
      events = new DbDomainEvents(db, jobs, quiet);
      notifier = new FakeNotifier();
      await mountRecovery({
        db,
        jobs,
        events,
        audit: new DbAudit(db),
        engine: new FakeActionEngine(),
        reconciler: { registerDueWork: (_name, fn) => void dueWork.push(fn) },
        // The email comes from PayPal live; a stub stands in for the gateway.
        paypal: {
          getSubscription: () =>
            Promise.resolve({
              id: "I-WIRING",
              plan_id: "P-STANDARD",
              status: "ACTIVE",
              subscriber: { email_address: "maya@example.com" },
            } as never),
        },
        notifier,
        log: quiet,
        env: { PORTAL_URL: "https://portal.example" },
      });
      await events.startWorker();
    }, 120_000);

    afterAll(async () => {
      await jobs.stop();
      await testDb.drop();
    }, 60_000);

    it("a payment_failed event opens a case and the evaluate job queues the message", async () => {
      await events.emit({
        type: "subscription.payment_failed",
        merchantId: M,
        payload: {
          subscriptionId: subId,
          reasonCode: "PAYMENT_DENIED",
          failedCount: 1,
          nextRetryTime: "2030-01-10T00:00:00.000Z",
        },
      });
      await until(() => notifier.queued.length === 1);
      expect(notifier.queued[0]).toMatchObject({
        to: "maya@example.com",
        dueAt: "2030-01-09T00:00:00.000Z",
        content: { template: "dunning.update_payment_method" },
      });
      // The notifier is called before the case row records the id, so wait for the row.
      await until(async () => (await caseState())?.notificationId === notifier.queued[0]?.id);
      expect((await caseState())?.notificationId).toBe(notifier.queued[0]?.id);
    });

    it("registers its due-work hook with the reconciler, and a sweep with nothing due is quiet", async () => {
      expect(dueWork).toHaveLength(1);
      await dueWork[0]?.();
      expect(notifier.queued).toHaveLength(1);
    });

    it("payment_completed recovers the case and withdraws the waiting reminder", async () => {
      await events.emit({
        type: "subscription.payment_completed",
        merchantId: M,
        payload: { subscriptionId: subId, amount: { value: "12.00", currency: "USD" } },
      });
      await until(async () => (await caseState())?.state === "recovered");
      expect(notifier.queued[0]?.status).toBe("suppressed");
      const row = await caseState();
      expect(row).toMatchObject({ recoveredValue: "12.00", recoveredCurrency: "USD" });
    });
  },
);
