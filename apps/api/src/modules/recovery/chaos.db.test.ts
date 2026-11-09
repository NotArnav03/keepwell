import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeActionEngine } from "@keepwell/contracts/fakes";
import { createDb, dunningCases, merchants, notifications, subscriptions, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { DbAudit } from "../audit/log.js";
import { DbDomainEvents } from "../jobs/domain-events.js";
import { Jobs } from "../jobs/jobs.js";
import { loadEnv } from "../../env.js";
import { notifyConfigFromEnv } from "../notify/config.js";
import { createDispatcher } from "../notify/dispatcher.js";
import { createNotifier } from "../notify/notifier.js";
import { EmailProviderError, FakeEmailProvider } from "../notify/providers.js";
import { mountRecovery } from "./mount.js";

// Chaos day, M5 drills (docs/CHAOS-REPORT.md): the failure-mode matrix rows "Email provider down"
// and "Webhook duplicate", run on the real recovery engine, the real notifier and dispatcher, and
// a real Postgres. Only the email provider (an in-memory fake that can be told to fail) and the
// PayPal subscription read are stand-ins.

const M = "0199e000-0000-7000-8000-0000000000c1";
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const DUE = new Date("2030-01-09T00:00:00.000Z");
const failed = {
  type: "subscription.payment_failed" as const,
  merchantId: M,
  payload: {
    subscriptionId: "",
    reasonCode: "PAYMENT_DENIED",
    failedCount: 1,
    nextRetryTime: "2030-01-10T00:00:00.000Z",
  },
};

let testDb: TestDatabase;
let db: Db;
let jobs: Jobs;
let events: DbDomainEvents;
let subId: string;
let now = new Date();
const provider = new FakeEmailProvider();

async function until(check: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const cases = () => db.forMerchant(M, (tx) => tx.select().from(dunningCases));
const outbox = () => db.forMerchant(M, (tx) => tx.select().from(notifications));

it.runIf(process.env.KEEPWELL_REQUIRE_DATABASE_TESTS === "1" && TEST_DATABASE_URL === undefined)(
  "has a test database when the database tests are required",
  () => {
    expect.fail("KEEPWELL_REQUIRE_DATABASE_TESTS is set but KEEPWELL_TEST_DATABASE_URL is not");
  },
);

describe.skipIf(TEST_DATABASE_URL === undefined)("M5 chaos drills", { timeout: 90_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    subId = await db.forMerchant(M, async (tx) => {
      await tx.insert(merchants).values({ id: M, slug: "chaos", name: "Chaos" });
      const [row] = await tx
        .insert(subscriptions)
        .values({
          merchantId: M,
          paypalSubscriptionId: "I-CHAOS",
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
    const audit = new DbAudit(db, () => now);
    events = new DbDomainEvents(db, jobs, quiet);
    await mountRecovery({
      db,
      jobs,
      events,
      audit,
      engine: new FakeActionEngine(),
      reconciler: { registerDueWork: () => undefined },
      paypal: {
        getSubscription: () =>
          Promise.resolve({
            id: "I-CHAOS",
            plan_id: "P-STANDARD",
            status: "ACTIVE",
            subscriber: { email_address: "maya@example.com" },
          } as never),
      },
      notifier: createNotifier({ db, audit, log: quiet }),
      log: quiet,
      env: { PORTAL_URL: "https://portal.example" },
    });
    await events.startWorker();
  }, 120_000);

  afterAll(async () => {
    await jobs.stop();
    await testDb.drop();
  }, 60_000);

  it("the same payment_failed delivered three times opens one case and queues one message", async () => {
    const event = { ...failed, payload: { ...failed.payload, subscriptionId: subId } };
    await events.emit(event);
    await events.emit(event);
    await events.emit(event);
    await until(async () => (await outbox()).length >= 1);
    // Give any duplicate handler or evaluate job time to misbehave before asserting.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await cases()).toHaveLength(1);
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ template: "dunning.update_payment_method", status: "queued" });
  });

  it("with the email provider down the message stays queued, is retried, and is sent exactly once", async () => {
    const dispatcher = createDispatcher({
      db,
      provider,
      audit: new DbAudit(db, () => now),
      events,
      config: notifyConfigFromEnv(
        loadEnv({ NODE_ENV: "test", UNSUBSCRIBE_TOKEN_SECRET: "test-secret-test-secret-test-secret-0123" }),
        "http://localhost:3000",
      ),
      log: quiet,
      now: () => now,
    });
    const [row] = await outbox();
    if (!row) throw new Error("no message to send");
    now = DUE;
    provider.failNext(new EmailProviderError("http_503", "provider answered 503", true), 2);

    expect(await dispatcher.dispatch(row.id)).toMatchObject({ status: "retry_scheduled" });
    // The outbox still holds the message (Demo Inbox keeps showing it), and the case is not lost.
    const queued = (
      await db.forMerchant(M, (tx) => tx.select().from(notifications).where(eq(notifications.id, row.id)))
    )[0];
    expect(queued).toMatchObject({ status: "queued", attempts: 1 });
    expect((await cases())[0]?.state).not.toBe("recovered");
    expect(provider.sent).toHaveLength(0);

    now = new Date(now.getTime() + 60_000);
    expect(await dispatcher.dispatch(row.id)).toMatchObject({ status: "retry_scheduled" });
    now = new Date(now.getTime() + 240_000);
    expect(await dispatcher.dispatch(row.id)).toEqual({ status: "sent" });
    // A second dispatch (a replayed job) must not send again.
    expect(await dispatcher.dispatch(row.id)).toEqual({ status: "skipped" });
    expect(provider.sent.filter((m) => m.id === row.id)).toHaveLength(1);
    expect((await outbox())[0]).toMatchObject({ status: "sent", attempts: 3 });
  });
});
