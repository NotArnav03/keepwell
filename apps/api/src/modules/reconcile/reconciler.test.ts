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
let engine: DbActionEngine;
let reconciler: Reconciler;
let now: Date;
let sent: { name: string; payload: unknown }[];

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
    const paypal = new PayPalClient({
      baseUrl: await mock.listen(),
      credentials: singleAppCredentials(PANTRY_PLAN_CREDENTIALS),
      log: quiet,
      retryDelaysMs: [],
    });
    const events = new FakeDomainEvents();
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

  it("reports drift a missed webhook left, fixes it, and finds none the next night", async () => {
    mock.state.cancelInPayPal(fixtureSubscriptionId("chloe"));
    mock.state.renew(fixtureSubscriptionId("priya"), "PAYER_CANNOT_PAY");
    const first = await reconciler.drift(M);
    expect(first.drifted).toBe(2);
    expect((await ours("chloe"))?.status).toBe("CANCELLED");
    expect((await ours("priya"))?.failedPaymentsCount).toBe(1);
    expect(await reconciler.drift(M)).toMatchObject({ drifted: 0 });
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

  it("turns due work into jobs, on the minute each part is due", async () => {
    now = new Date("2026-11-10T03:00:00Z");
    let ran = 0;
    reconciler.registerDueWork("test.ok", () => Promise.resolve(void ran++));
    reconciler.registerDueWork("test.broken", () => Promise.reject(new Error("broken")));
    reconciler.registerDueWork("test.after", () => Promise.resolve(void ran++));
    await reconciler.dueSweep();
    const names = sent.map((s) => s.name);
    expect(names).toContain("action.execute"); // the PENDING suspend from the hot loop test
    expect(names).toContain("reconcile.subscription"); // minute 0 is even
    expect(names).toContain("reconcile.sweep"); // minute 0 is a multiple of 30
    expect(names).toContain("reconcile.drift"); // 03:00 UTC
    // A broken module's due work doesn't stop the others.
    expect(ran).toBe(2);

    sent = [];
    now = new Date("2026-11-10T03:07:00Z");
    await reconciler.dueSweep();
    expect(sent.map((s) => s.name).filter((n) => n.startsWith("reconcile."))).toEqual([]);
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
