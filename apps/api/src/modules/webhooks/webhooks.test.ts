import Fastify, { type FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DomainEvent } from "@keepwell/contracts";
import { FakeAudit, PANTRY_PLAN } from "@keepwell/contracts/fakes";
import {
  createDb,
  domainEvents,
  merchants,
  plans,
  subscriptions,
  webhookEvents,
  type Db,
} from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import {
  createPayPalMock,
  fixtureSubscriptionId,
  PANTRY_PLAN_CREDENTIALS,
  type PayPalMock,
} from "@keepwell/paypal-mock";
import { DbActionEngine } from "../actions/engine.js";
import { DbDomainEvents } from "../jobs/domain-events.js";
import { Jobs } from "../jobs/jobs.js";
import { PayPalClient } from "../paypal/client.js";
import { singleAppCredentials } from "../paypal/credentials.js";
import { SubscriptionSync } from "../reconcile/sync.js";
import { webhookIntake } from "./intake.js";
import { WebhookProcessor } from "./processor.js";

// The whole pipeline: paypal-mock sends signed webhooks to our intake over HTTP, pg-boss runs the
// processing, the subscription is fetched and diffed, and domain events come out of the diff.

const M = PANTRY_PLAN.merchantId;
const id = (name: string) => fixtureSubscriptionId(name);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

let testDb: TestDatabase;
let db: Db;
let mock: PayPalMock;
let app: FastifyInstance;
let intakeUrl: string;
let jobs: Jobs;
let sync: SubscriptionSync;
let engine: DbActionEngine;
const seen: DomainEvent[] = [];

async function until(check: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 150));
  }
}

const ourId = async (paypalId: string) =>
  (
    await db.forMerchant(M, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.paypalSubscriptionId, paypalId)),
    )
  )[0];

/** How many events of a type the sync stored for a subscription. */
const storedEvents = async (subscriptionId: string | undefined, type: string) =>
  (
    await db.forMerchant(M, (tx) =>
      tx
        .select({ id: domainEvents.id })
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.type, type),
            sql`${domainEvents.payload}->>'subscriptionId' = ${subscriptionId ?? ""}`,
          ),
        ),
    )
  ).length;

const eventsFor = (subscriptionId: string | undefined, type: string) =>
  seen.filter(
    (e) => e.type === type && (e.payload as { subscriptionId?: string }).subscriptionId === subscriptionId,
  );

it.runIf(process.env.KEEPWELL_REQUIRE_DATABASE_TESTS === "1" && TEST_DATABASE_URL === undefined)(
  "has a test database when the database tests are required",
  () => {
    expect.fail("KEEPWELL_REQUIRE_DATABASE_TESTS is set but KEEPWELL_TEST_DATABASE_URL is not");
  },
);

describe.skipIf(TEST_DATABASE_URL === undefined)("webhook pipeline", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    mock = createPayPalMock();
    const mockUrl = await mock.listen();
    const paypal = new PayPalClient({
      baseUrl: mockUrl,
      credentials: singleAppCredentials(PANTRY_PLAN_CREDENTIALS),
      log: quiet,
      retryDelaysMs: [],
    });
    jobs = await Jobs.start({
      connectionString: testDb.url,
      log: quiet,
      pollingIntervalSeconds: 0.5,
      retryDelaySeconds: 1,
    });
    const events = new DbDomainEvents(db, jobs, quiet);
    sync = new SubscriptionSync(db, paypal, events);
    engine = new DbActionEngine({
      db,
      lockPool: testDb.appPool,
      paypal,
      audit: new FakeAudit(),
      events,
      log: quiet,
    });
    const processor = new WebhookProcessor(db, paypal, sync, quiet);

    for (const type of [
      "subscription.synced",
      "subscription.status_changed",
      "subscription.plan_changed",
      "subscription.payment_failed",
      "subscription.payment_completed",
      "subscription.cancelled_externally",
    ] as const) {
      events.on(type, "test.recorder", (event) => {
        seen.push(event);
        return Promise.resolve();
      });
    }
    events.on("subscription.synced", "actions.confirm", (event) =>
      engine
        .confirmFromSync(event.merchantId, event.payload.subscriptionId, event.payload.snapshot.status)
        .then(() => {}),
    );
    await events.startWorker();
    await jobs.work("webhook.process", ({ webhookEventId }) =>
      processor.process(webhookEventId).then(() => {}),
    );

    app = Fastify();
    await app.register(webhookIntake, { db, jobs });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    intakeUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/webhooks/paypal/${M}`;
    const webhook = mock.state.registerWebhook(M, intakeUrl, ["*"]);
    await db.forMerchant(M, (tx) =>
      tx.insert(merchants).values({ id: M, slug: "pantry-plan", name: "Pantry Plan", webhookId: webhook.id }),
    );
    // We already know these subscribers, so later webhooks produce diffs.
    for (const name of ["maya", "lena", "chloe", "raj", "priya"]) await sync.sync(M, id(name));
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await jobs.stop();
    await mock.close();
    await testDb.drop();
  }, 60_000);

  it("stores a first sync as our snapshot, with the plan fetched once and no email kept", async () => {
    const maya = await ourId(id("maya"));
    expect(maya).toMatchObject({
      status: "ACTIVE",
      planName: "Standard",
      priceValue: "12.00",
      lastPaymentValue: "12.00",
    });
    expect(maya?.subscriberEmailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(maya?.snapshot)).not.toContain("@example.com");
    const known = await db.forMerchant(M, (tx) => tx.select().from(plans));
    // Each plan was fetched from PayPal once, however many subscribers are on it.
    expect(known.map((p) => p.paypalPlanId).sort()).toEqual([
      PANTRY_PLAN.lite.planId,
      PANTRY_PLAN.standard.planId,
    ]);
  });

  it("turns a signed webhook into a fetched, diffed status change", async () => {
    mock.state.suspend(M, id("maya"));
    await until(async () => (await ourId(id("maya")))?.status === "SUSPENDED");
    const maya = await ourId(id("maya"));
    await until(() => eventsFor(maya?.id, "subscription.status_changed").length === 1);
    expect(eventsFor(maya?.id, "subscription.status_changed")[0]?.payload).toMatchObject({
      from: "ACTIVE",
      to: "SUSPENDED",
    });
    const [stored] = await db.forMerchant(M, (tx) =>
      tx.select().from(webhookEvents).where(eq(webhookEvents.eventType, "BILLING.SUBSCRIPTION.SUSPENDED")),
    );
    expect(stored).toMatchObject({ status: "processed", verification: "VERIFIED", attempts: 1 });
  });

  it("answers a duplicate delivery 200 and processes it once", async () => {
    const [first] = await db.forMerchant(M, (tx) =>
      tx.select().from(webhookEvents).where(eq(webhookEvents.eventType, "BILLING.SUBSCRIPTION.SUSPENDED")),
    );
    const before = mock.webhooks.deliveries.length;
    mock.webhooks.dispatch(mock.state.event(M, first?.eventId ?? ""), mock.state.webhooks(M));
    await mock.webhooks.flush();
    expect(mock.webhooks.deliveries.slice(before).map((d) => d.status)).toEqual([200]);
    const rows = await db.forMerchant(M, (tx) =>
      tx
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.eventId, first?.eventId ?? "")),
    );
    expect(rows).toHaveLength(1);
  });

  it("rejects a webhook whose body was changed after PayPal signed it", async () => {
    const [genuine] = await db.forMerchant(M, (tx) =>
      tx.select().from(webhookEvents).where(eq(webhookEvents.eventType, "BILLING.SUBSCRIPTION.SUSPENDED")),
    );
    const forged = (genuine?.rawBody ?? "")
      .replace('"SUSPENDED"', '"CANCELLED"')
      .replace(genuine?.eventId ?? "", "WH-FORGED");
    const res = await fetch(intakeUrl, {
      method: "POST",
      headers: { ...(genuine?.headers as Record<string, string>), "content-type": "application/json" },
      body: forged,
    });
    expect(res.status).toBe(200);
    await until(async () => {
      const [row] = await db.forMerchant(M, (tx) =>
        tx.select().from(webhookEvents).where(eq(webhookEvents.eventId, "WH-FORGED")),
      );
      return row?.status === "rejected";
    });
    expect((await ourId(id("maya")))?.status).toBe("SUSPENDED");
  });

  it("calls a PayPal-side cancel external, and our own cancel not, confirming our Action", async () => {
    mock.state.cancelInPayPal(id("lena"));
    const lena = await ourId(id("lena"));
    await until(() => eventsFor(lena?.id, "subscription.cancelled_externally").length === 1);

    const raj = await ourId(id("raj"));
    const action = await engine.create({
      merchantId: M,
      subscriptionId: raj?.id ?? null,
      type: "cancel",
      origin: "session",
      params: { reason: "Cancelled by the subscriber" },
    });
    await engine.execute(M, action.id);
    await until(async () => (await engine.get(M, action.id))?.state === "CONFIRMED");
    // Confirmation and the recorder are separate jobs: wait for the event too.
    await until(() => eventsFor(raj?.id, "subscription.status_changed").length === 1);
    expect(eventsFor(raj?.id, "subscription.status_changed").map((e) => e.payload)).toMatchObject([
      { from: "ACTIVE", to: "CANCELLED" },
    ]);
    // Checked in domain_events, which the sync writes in one transaction: a recorder job could lag.
    expect(await storedEvents(raj?.id, "subscription.cancelled_externally")).toBe(0);
    expect(await storedEvents(raj?.id, "subscription.status_changed")).toBe(1);
  });

  it("reports failed and completed payments from the diff", async () => {
    const priya = await ourId(id("priya"));
    mock.state.renew(id("priya"), "PAYER_CANNOT_PAY");
    await until(() => eventsFor(priya?.id, "subscription.payment_failed").length === 1);
    expect(eventsFor(priya?.id, "subscription.payment_failed")[0]?.payload).toMatchObject({
      reasonCode: "PAYER_CANNOT_PAY",
      failedCount: 1,
    });
    mock.state.renew(id("priya"));
    await until(() => eventsFor(priya?.id, "subscription.payment_completed").length === 1);
    expect(eventsFor(priya?.id, "subscription.payment_completed")[0]?.payload).toMatchObject({
      amount: { value: "12.00", currency: "USD" },
    });
  });

  it("is immune to webhooks that arrive late: a suspend undone at once changes nothing", async () => {
    const chloe = await ourId(id("chloe"));
    mock.state.suspend(M, id("chloe"));
    mock.state.activate(M, id("chloe"));
    await until(async () => {
      const rows = await db.forMerchant(M, (tx) =>
        tx
          .select()
          .from(webhookEvents)
          .where(
            and(
              eq(webhookEvents.status, "processed"),
              eq(webhookEvents.eventType, "BILLING.SUBSCRIPTION.ACTIVATED"),
            ),
          ),
      );
      return rows.length >= 1;
    });
    expect((await ourId(id("chloe")))?.status).toBe("ACTIVE");
    expect(eventsFor(chloe?.id, "subscription.status_changed")).toEqual([]);
  });

  it("follows a plan change and learns the new plan", async () => {
    const token = mock.state.revise(M, id("maya"), PANTRY_PLAN.lite.planId, {
      returnUrl: null,
      cancelUrl: null,
    });
    mock.state.decideRevision(token, true);
    const maya = await ourId(id("maya"));
    await until(() => eventsFor(maya?.id, "subscription.plan_changed").length === 1);
    expect(eventsFor(maya?.id, "subscription.plan_changed")[0]?.payload).toMatchObject({
      fromPlanId: PANTRY_PLAN.standard.planId,
      toPlanId: PANTRY_PLAN.lite.planId,
    });
    expect(await ourId(id("maya"))).toMatchObject({ planName: "Lite", priceValue: "6.00" });
  });

  it("answers 404 for a merchant we don't have", async () => {
    const res = await fetch(intakeUrl.replace(M, "0199e000-0000-7000-8000-0000000000ff"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "WH-X", event_type: "BILLING.SUBSCRIPTION.SUSPENDED" }),
    });
    expect(res.status).toBe(404);
  });
});
