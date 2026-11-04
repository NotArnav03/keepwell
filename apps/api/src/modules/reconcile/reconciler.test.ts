import Fastify from "fastify";
import { eq } from "drizzle-orm";
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
import { DbActionEngine } from "../actions/engine.js";
import type { Jobs } from "../jobs/jobs.js";
import { PayPalClient } from "../paypal/client.js";
import { singleAppCredentials } from "../paypal/credentials.js";
import { opsRoutes } from "./ops.js";
import { Reconciler } from "./reconciler.js";
import { SubscriptionSync } from "./sync.js";

// The reconciler against paypal-mock and a real Postgres. Jobs it would enqueue are recorded.

const M = PANTRY_PLAN.merchantId;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

let testDb: TestDatabase;
let db: Db;
let mock: PayPalMock;
let sync: SubscriptionSync;
let paypal: PayPalClient;
let engine: DbActionEngine;
let reconciler: Reconciler;
let now: Date;
let sent: { name: string; payload: unknown }[];
let events: FakeDomainEvents;

const ours = async (name: string) =>
  (
    await db.forMerchant(M, (tx) =>
      tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.paypalSubscriptionId, fixtureSubscriptionId(name))),
    )
  )[0];

it.runIf(process.env.KEEPWELL_REQUIRE_DATABASE_TESTS === "1" && TEST_DATABASE_URL === undefined)(
  "has a test database when the database tests are required",
  () => {
    expect.fail("KEEPWELL_REQUIRE_DATABASE_TESTS is set but KEEPWELL_TEST_DATABASE_URL is not");
  },
);

describe.skipIf(TEST_DATABASE_URL === undefined)("Reconciler", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    await db.forMerchant(M, (tx) =>
      tx.insert(merchants).values({ id: M, slug: "pantry-plan", name: "Pantry Plan" }),
    );
    mock = createPayPalMock();
    paypal = new PayPalClient({
      baseUrl: await mock.listen(),
      credentials: singleAppCredentials(PANTRY_PLAN_CREDENTIALS),
      log: quiet,
      retryDelaysMs: [],
    });
    events = new FakeDomainEvents();
    sync = new SubscriptionSync(db, paypal, events);
    engine = new DbActionEngine({
      db,
      lockPool: testDb.appPool,
      paypal,
      audit: new FakeAudit(),
      events,
      log: quiet,
    });
    const jobs: Pick<Jobs, "send"> = {
      send: (name, payload) => {
        sent.push({ name, payload });
        return Promise.resolve("job");
      },
    };
    reconciler = new Reconciler({ db, paypal, sync, engine, jobs, log: quiet, clock: () => now });
  }, 120_000);

  afterAll(async () => {
    await mock.close();
    await testDb.drop();
  }, 60_000);

  beforeEach(() => {
    now = new Date();
    sent = [];
  });

  afterEach(() => {
    sent = [];
  });

  it("sweeps everything the first time, then only what PayPal says changed", async () => {
    expect(await reconciler.sweep(M)).toBe(12);
    expect((await ours("maya"))?.status).toBe("ACTIVE");
    const [merchant] = await db.forMerchant(M, (tx) => tx.select().from(merchants));
    expect(merchant?.lastSweepAt).not.toBeNull();

    // A change no webhook told us about. The next sweep looks from the last one (minus 5 minutes).
    mock.state.suspend(M, fixtureSubscriptionId("lena"));
    const second = await reconciler.sweep(M);
    expect(second).toBe(1);
    expect((await ours("lena"))?.status).toBe("SUSPENDED");
  });

  it("pages on until PayPal sends an empty page, since its list has no totals", async () => {
    // The sandbox's list sends no total_pages (fixtures/spikes/gateway). Pages of 5 here, so the
    // 12 subscriptions take three pages and a fourth, empty one ends the sweep.
    const all = (await paypal.listSubscriptions(M, {})).items;
    const requested: number[] = [];
    const paged = new Reconciler({
      db,
      paypal: {
        listSubscriptions: (_merchantId, { page = 1 }) => {
          requested.push(page);
          const items = all.slice((page - 1) * 5, page * 5);
          return Promise.resolve({ items, page, totalItems: null, totalPages: null });
        },
      },
      sync,
      engine,
      jobs: { send: () => Promise.resolve("job") },
      log: quiet,
      clock: () => now,
    });
    expect(await paged.sweep(M)).toBe(12);
    expect(requested).toEqual([1, 2, 3, 4]);
  });

  it("reports drift a missed webhook left, fixes it, and finds none the next night", async () => {
    mock.state.cancelInPayPal(fixtureSubscriptionId("chloe"));
    mock.state.renew(fixtureSubscriptionId("priya"), "PAYER_CANNOT_PAY");
    const first = await reconciler.drift(M);
    expect(first.drifted).toBe(2);
    expect((await ours("chloe"))?.status).toBe("CANCELLED");
    expect((await ours("priya"))?.failedPaymentsCount).toBe(1);
    expect(await reconciler.drift(M)).toMatchObject({ drifted: 0 });
  });

  // Spike Q5 (#131): a real sandbox renewal failure showed failed_payments_count 3 and no
  // last_failed_payment at all. Recovery must still hear about it, with the reason unknown.
  it("emits payment_failed when the failure count rises even without a reason code", async () => {
    const kenji = fixtureSubscriptionId("kenji");
    await sync.sync(M, kenji);
    mock.state.renew(kenji, "PAYER_CANNOT_PAY");
    delete mock.state.getSubscription(M, kenji).billing_info?.last_failed_payment;
    const before = events.emitted.length;
    await sync.sync(M, kenji);
    const failed = events.emitted.slice(before).filter((e) => e.type === "subscription.payment_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({ reasonCode: "UNKNOWN", failedCount: 1, nextRetryTime: null });
  });

  it("puts subscriptions with an Action in flight on the hot loop", async () => {
    const maya = await ours("maya");
    await engine.create({
      merchantId: M,
      subscriptionId: maya?.id ?? null,
      type: "suspend",
      origin: "session",
      params: { reason: "Pause" },
    });
    expect(await reconciler.hotLoop()).toBeGreaterThanOrEqual(1);
    expect(sent).toContainEqual({ name: "reconcile.subscription", payload: { subscriptionId: maya?.id } });
    await reconciler.syncOne(maya?.id ?? "");
  });

  it("turns due work into jobs, sweeping and drift-checking by age so a sleeping server catches up", async () => {
    // Days after the last sweep, as after Render's free plan slept: everything is overdue.
    now = new Date("2026-11-10T03:00:00Z");
    let ran = 0;
    reconciler.registerDueWork("test.ok", () => Promise.resolve(void ran++));
    reconciler.registerDueWork("test.broken", () => Promise.reject(new Error("broken")));
    reconciler.registerDueWork("test.after", () => Promise.resolve(void ran++));
    await reconciler.dueSweep();
    const names = sent.map((s) => s.name);
    expect(names).toContain("action.execute"); // the PENDING suspend from the hot loop test
    expect(names).toContain("reconcile.subscription"); // the hot loop runs on even minutes
    expect(names).toContain("reconcile.sweep"); // last sweep more than 30 minutes ago
    expect(names).toContain("reconcile.drift"); // no drift report yet today, and it's past 03:00
    // A broken module's due work doesn't stop the others.
    expect(ran).toBe(2);

    // The jobs run: now swept and drift-checked at 03:00.
    await reconciler.sweep(M);
    await reconciler.drift(M);
    sent = [];
    now = new Date("2026-11-10T03:07:00Z");
    await reconciler.dueSweep();
    expect(sent.map((s) => s.name).filter((n) => n.startsWith("reconcile."))).toEqual([]);

    // The next day before 03:00: a sweep is due again, the drift report not yet.
    sent = [];
    now = new Date("2026-11-11T02:01:00Z");
    await reconciler.dueSweep();
    const early = sent.map((s) => s.name);
    expect(early).toContain("reconcile.sweep");
    expect(early).not.toContain("reconcile.drift");
  });

  it("serves /status from the reconciler's state, and /ops behind its token", async () => {
    const app = Fastify();
    await app.register(opsRoutes, {
      db,
      opsToken: "ops-test-token",
      paypalCheck: () => Promise.resolve(true),
    });
    const status = (await app.inject({ url: "/status" })).json<{
      status: string;
      components: {
        database: string;
        paypal: string;
        reconciler: { drift: number; lastSweepAt: string | null };
      };
    }>();
    expect(status).toMatchObject({
      status: "operational",
      components: { database: "operational", paypal: "operational" },
    });
    expect(status.components.reconciler.drift).toBe(0);
    expect(status.components.reconciler.lastSweepAt).not.toBeNull();
    expect((await app.inject({ url: "/ops" })).statusCode).toBe(401);
    const ops = await app.inject({ url: "/ops", headers: { authorization: "Bearer ops-test-token" } });
    expect(ops.statusCode).toBe(200);
    expect(ops.json()).toMatchObject({ drift: [{ merchantId: M, drifted: 0 }] });
    await app.close();
  });
});
