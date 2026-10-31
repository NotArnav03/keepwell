import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ErrorEnvelope, OutboxResponse, type Notifier, type TemplateId } from "@keepwell/contracts";
import { FakeAudit, FakeDomainEvents } from "@keepwell/contracts/fakes";
import { createDb, merchants, notifications, runMigrations, type Db, type Tx } from "@keepwell/db";
import { loadEnv } from "../../env.js";
import { buildServer } from "../../server.js";
import { loadNotifyConfig } from "./config.js";
import { createDispatcher, enqueueDueNotifications, MAX_ATTEMPTS } from "./dispatcher.js";
import { CONTENT } from "./fixtures.js";
import { createNotifier } from "./notifier.js";
import { EmailProviderError, FakeEmailProvider } from "./providers.js";
import { notifyRoutes } from "./routes.js";
import { createUnsubscribeToken } from "./unsubscribe-token.js";

// Real Postgres 18, like packages/db's tests: KEEPWELL_TEST_DATABASE_URL (CI has a service container).
// The email provider is always the in-memory fake: nothing here touches the network.

const URL_ = process.env.KEEPWELL_TEST_DATABASE_URL;
const A = "0199c000-0000-7000-8000-00000000000a";
const B = "0199c000-0000-7000-8000-00000000000b";
const DAY = 24 * 60 * 60 * 1000;
const config = loadNotifyConfig({ UNSUBSCRIBE_TOKEN_SECRET: "test-secret-test-secret-test-secret-0123" });
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

let admin: pg.Pool;
let owner: pg.Pool;
let app: pg.Pool;
let dbName: string;
let db: Db;
let now = new Date();
const audit = new FakeAudit(() => now);
const events = new FakeDomainEvents(() => now);
const provider = new FakeEmailProvider();
let notifier: Notifier<Tx>;
let dispatcher: ReturnType<typeof createDispatcher>;
let n = 0;
const email = (): string => `person${String(++n)}@example.com`;

function enqueue(
  to: string,
  template: TemplateId = "dunning.generic",
  extra: { simulated?: boolean; merchantId?: string } = {},
) {
  return notifier.enqueue({
    merchantId: extra.merchantId ?? A,
    subscriptionId: null,
    to,
    content: CONTENT[template],
    simulated: extra.simulated ?? false,
    dueAt: now.toISOString(),
  });
}
const rowOf = async (id: string) =>
  (await db.forMerchant(A, (tx) => tx.select().from(notifications).where(eq(notifications.id, id))))[0];

it.runIf(process.env.KEEPWELL_REQUIRE_DATABASE_TESTS === "1" && URL_ === undefined)(
  "has a test database when the database tests are required",
  () => {
    expect.fail("KEEPWELL_REQUIRE_DATABASE_TESTS is set but KEEPWELL_TEST_DATABASE_URL is not");
  },
);

describe.skipIf(URL_ === undefined)("notify against Postgres", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    dbName = `kw_test_${randomBytes(6).toString("hex")}`;
    admin = new pg.Pool({ connectionString: URL_, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(URL_ ?? "");
    url.pathname = `/${dbName}`;
    owner = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await runMigrations(owner);
    app = new pg.Pool({ connectionString: url.toString(), max: 6, options: "-c role=keepwell_app" });
    db = createDb(app);
    for (const [id, slug] of [
      [A, "alpha"],
      [B, "bravo"],
    ] as const) {
      await db.forMerchant(id, (tx) => tx.insert(merchants).values({ id, slug, name: slug }));
    }
    notifier = createNotifier({ db, audit, log, now: () => now });
    dispatcher = createDispatcher({ db, provider, audit, events, config, log, now: () => now });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner.end(), app.end()]);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }, 60_000);

  describe("outbox insert", () => {
    it("commits with the caller's transaction and audits", async () => {
      const to = email();
      const id = await db.forMerchant(A, (tx) =>
        notifier.enqueue({ merchantId: A, subscriptionId: null, to, content: CONTENT["winback.ask"] }, tx),
      );
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: "queued", attempts: 0, template: "winback.ask", simulated: false });
      expect(
        audit.entries.some((e) => e.kind === "notification.enqueued" && e.subjectIds.notificationId === id),
      ).toBe(true);
      expect(provider.sent.some((m) => m.id === id)).toBe(false); // enqueue never sends
    });

    it("rolls back with the caller's transaction", async () => {
      const to = email();
      let id = "";
      await expect(
        db.forMerchant(A, async (tx) => {
          id = await notifier.enqueue(
            { merchantId: A, subscriptionId: null, to, content: CONTENT["dunning.generic"] },
            tx,
          );
          throw new Error("business change failed");
        }),
      ).rejects.toThrow("business change failed");
      expect(await rowOf(id)).toBeUndefined();
    });

    it("rejects an invalid request before touching the database", async () => {
      await expect(
        notifier.enqueue({
          merchantId: A,
          subscriptionId: null,
          to: "not-an-email",
          content: CONTENT["dunning.generic"],
        }),
      ).rejects.toThrow();
    });
  });

  describe("dispatch", () => {
    it("sends once and a second run of the same job does nothing", async () => {
      const id = await enqueue(email());
      const before = provider.sent.length;
      expect(await dispatcher.dispatch(id)).toEqual({ status: "sent" });
      expect(await dispatcher.dispatch(id)).toEqual({ status: "skipped" });
      expect(provider.sent.length - before).toBe(1);
      expect(await rowOf(id)).toMatchObject({ status: "sent", providerId: `fake:${id}`, attempts: 1 });
      expect(
        events.emitted.filter(
          (e) =>
            e.type === "notification.sent" &&
            "notificationId" in e.payload &&
            e.payload.notificationId === id,
        ),
      ).toHaveLength(1);
      expect(
        audit.entries.some((e) => e.kind === "notification.sent" && e.subjectIds.notificationId === id),
      ).toBe(true);
      const message = provider.sent.at(-1);
      expect(message?.text).toContain("/v1/unsubscribe?token=");
    });

    it("two workers at once still send once", async () => {
      const id = await enqueue(email());
      const before = provider.sent.length;
      await Promise.all([dispatcher.dispatch(id), dispatcher.dispatch(id)]);
      expect(provider.sent.length - before).toBe(1);
    });

    it("keeps simulated notifications away from the provider", async () => {
      const id = await enqueue(email(), "dunning.generic", { simulated: true });
      const calls = provider.calls;
      expect(await dispatcher.dispatch(id)).toEqual({ status: "sent" });
      expect(provider.calls).toBe(calls);
      expect(await rowOf(id)).toMatchObject({ providerId: `simulated:${id}`, simulated: true });
    });

    it("skips an unknown id and a row that is not due yet", async () => {
      expect(await dispatcher.dispatch("0199c000-0000-7000-8000-0000000000ff")).toEqual({
        status: "skipped",
      });
      const id = await notifier.enqueue({
        merchantId: A,
        subscriptionId: null,
        to: email(),
        content: CONTENT["dunning.generic"],
        dueAt: new Date(now.getTime() + 60_000).toISOString(),
      });
      expect(await dispatcher.dispatch(id)).toEqual({ status: "skipped" });
    });
  });

  describe("frequency caps (1 a day, 3 a week, per address)", () => {
    it("defers a second message to 24 h after the first, then suppresses what the weekly cap would delay too long", async () => {
      const to = email();
      const start = new Date(now);
      const [m1, m2, m3, m4] = [
        await enqueue(to),
        await enqueue(to),
        await enqueue(to),
        await enqueue(to),
      ] as [string, string, string, string];

      expect(await dispatcher.dispatch(m1)).toEqual({ status: "sent" });
      // Same day: deferred to 24 h after the send, still queued.
      const second = await dispatcher.dispatch(m2);
      expect(second).toEqual({ status: "deferred", retryAt: new Date(start.getTime() + DAY) });
      expect(await rowOf(m2)).toMatchObject({ status: "queued", suppressedBecause: null });

      now = new Date(start.getTime() + DAY);
      expect(await dispatcher.dispatch(m2)).toEqual({ status: "sent" });
      expect(await dispatcher.dispatch(m3)).toEqual({
        status: "deferred",
        retryAt: new Date(start.getTime() + 2 * DAY),
      });
      now = new Date(start.getTime() + 2 * DAY);
      expect(await dispatcher.dispatch(m3)).toEqual({ status: "sent" });

      // Three in the week: a 4th would wait until day 7, more than 3 days after it was created.
      expect(await dispatcher.dispatch(m4)).toEqual({ status: "suppressed", reason: "frequency_cap" });
      expect(await rowOf(m4)).toMatchObject({ status: "suppressed", suppressedBecause: "frequency_cap" });
      expect(provider.sent.filter((m) => m.to === to)).toHaveLength(3);
      now = new Date(start.getTime() + 3 * DAY);
    });

    it("counts per address, not across addresses", async () => {
      const [a, b] = [email(), email()];
      expect(await dispatcher.dispatch(await enqueue(a))).toEqual({ status: "sent" });
      expect(await dispatcher.dispatch(await enqueue(b))).toEqual({ status: "sent" });
    });
  });

  describe("unsubscribe", () => {
    let server: FastifyInstance;
    beforeAll(async () => {
      server = buildServer(loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
      await server.register(notifyRoutes, {
        prefix: "/v1",
        db,
        audit,
        config,
        log,
        authenticate: () => Promise.resolve({ merchantId: A }),
      });
    });
    afterAll(async () => {
      await server.close();
    });

    it("records the opt-out, suppresses later sends and is idempotent", async () => {
      const to = email();
      const token = createUnsubscribeToken(config.unsubscribeSecret, {
        merchantId: A,
        email: to.toUpperCase(),
      });
      const queued = await enqueue(to);
      const unsubscribedCount = () =>
        audit.entries.filter((e) => e.kind === "notification.unsubscribed").length;
      const before = unsubscribedCount();
      for (let i = 0; i < 2; i++) {
        const res = await server.inject({ method: "GET", url: `/v1/unsubscribe?token=${token}` });
        expect(res.statusCode).toBe(200);
      }
      expect(unsubscribedCount() - before).toBe(1); // the second click is not a new change
      const calls = provider.calls;
      expect(await dispatcher.dispatch(queued)).toEqual({ status: "suppressed", reason: "unsubscribed" });
      expect(provider.calls).toBe(calls);
      expect(await rowOf(queued)).toMatchObject({ status: "suppressed", suppressedBecause: "unsubscribed" });
    });

    it("is per merchant", async () => {
      const to = email();
      const token = createUnsubscribeToken(config.unsubscribeSecret, { merchantId: B, email: to });
      await server.inject({ method: "GET", url: `/v1/unsubscribe?token=${token}` });
      expect(await dispatcher.dispatch(await enqueue(to))).toEqual({ status: "sent" });
    });

    it("rejects a forged or missing token", async () => {
      expect((await server.inject({ method: "GET", url: "/v1/unsubscribe?token=nope" })).statusCode).toBe(
        400,
      );
      expect((await server.inject({ method: "GET", url: "/v1/unsubscribe" })).statusCode).toBe(400);
    });
  });

  describe("provider failure", () => {
    const down = new EmailProviderError("http_503", "Resend answered 503", true);

    it("retries with backoff, keeps the message in the outbox, and then sends", async () => {
      const id = await enqueue(email());
      provider.failNext(down, 2);
      const t0 = new Date(now);

      const first = await dispatcher.dispatch(id);
      expect(first).toEqual({ status: "retry_scheduled", retryAt: new Date(t0.getTime() + 60_000) });
      expect(await rowOf(id)).toMatchObject({
        status: "queued",
        attempts: 1,
        lastError: { code: "http_503", message: "Resend answered 503" },
      });
      // Not due yet: nothing happens.
      expect(await dispatcher.dispatch(id)).toEqual({ status: "skipped" });

      now = new Date(t0.getTime() + 60_000);
      expect(await dispatcher.dispatch(id)).toEqual({
        status: "retry_scheduled",
        retryAt: new Date(now.getTime() + 240_000),
      });
      now = new Date(now.getTime() + 240_000);
      expect(await dispatcher.dispatch(id)).toEqual({ status: "sent" });
      expect(await rowOf(id)).toMatchObject({ status: "sent", attempts: 3, lastError: null });
    });

    it("gives up after the attempt limit", async () => {
      const id = await enqueue(email());
      provider.failNext(down, MAX_ATTEMPTS);
      let last = await dispatcher.dispatch(id);
      for (let i = 1; i < MAX_ATTEMPTS; i++) {
        if (last.status !== "retry_scheduled") throw new Error("expected a retry");
        now = last.retryAt;
        last = await dispatcher.dispatch(id);
      }
      expect(last).toEqual({ status: "failed" });
      expect(await rowOf(id)).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    });

    it("does not retry a permanent rejection", async () => {
      const id = await enqueue(email());
      provider.failNext(new EmailProviderError("http_422", "bad address", false));
      expect(await dispatcher.dispatch(id)).toEqual({ status: "failed" });
      expect(await rowOf(id)).toMatchObject({ status: "failed", attempts: 1 });
    });
  });

  describe("due-work sweep", () => {
    it("finds due rows and expired send leases, not future or finished ones", async () => {
      const due = await enqueue(email());
      const future = await notifier.enqueue({
        merchantId: A,
        subscriptionId: null,
        to: email(),
        content: CONTENT["dunning.generic"],
        dueAt: new Date(now.getTime() + DAY).toISOString(),
      });
      const done = await enqueue(email());
      await dispatcher.dispatch(done);
      const stuck = await enqueue(email());
      await owner.query(`UPDATE notifications SET status = 'sending', due_at = $2 WHERE id = $1`, [
        stuck,
        new Date(now.getTime() - 1000),
      ]);

      const ids: string[] = [];
      await enqueueDueNotifications(
        db,
        (p) => {
          ids.push(p.notificationId);
          return Promise.resolve();
        },
        now,
        1000,
      );
      expect(ids).toContain(due);
      expect(ids).toContain(stuck);
      expect(ids).not.toContain(future);
      expect(ids).not.toContain(done);
    });
  });

  describe("Demo Inbox", () => {
    let server: FastifyInstance;
    let mine: string[];
    beforeAll(async () => {
      server = buildServer(loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
      await server.register(notifyRoutes, {
        prefix: "/v1",
        db,
        audit,
        config,
        log,
        authenticate: (request) =>
          Promise.resolve({ merchantId: request.headers["x-test-merchant"] === "B" ? B : A }),
      });
      // A fresh merchant-B history so the isolation check has something to leak.
      for (let i = 0; i < 2; i++) await enqueue(email(), "winback.ask", { merchantId: B });
      mine = [];
      for (let i = 0; i < 5; i++) mine.push(await enqueue(email(), "dunning.reactivate"));
    });
    afterAll(async () => {
      await server.close();
    });

    const get = async (url: string, merchant = "A") => {
      const res = await server.inject({ method: "GET", url, headers: { "x-test-merchant": merchant } });
      return { status: res.statusCode, body: res.json<unknown>() };
    };

    it("pages newest first without gaps or repeats", async () => {
      const seen: string[] = [];
      let url = "/v1/m/outbox?limit=3";
      for (let guard = 0; guard < 50; guard++) {
        const { status, body } = await get(url);
        expect(status).toBe(200);
        const page = OutboxResponse.parse(body);
        expect(page.items.length).toBeLessThanOrEqual(3);
        seen.push(...page.items.map((i) => i.id));
        if (!page.nextCursor) break;
        url = `/v1/m/outbox?limit=3&cursor=${page.nextCursor}`;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen]).toEqual([...seen].sort().reverse());
      for (const id of mine) expect(seen).toContain(id);
    });

    it("shows rendered subject and body, status and simulated flag", async () => {
      const sim = await enqueue(email(), "dunning.reactivate", { simulated: true });
      const { body } = await get("/v1/m/outbox?limit=1");
      const item = OutboxResponse.parse(body).items[0];
      expect(item).toMatchObject({
        id: sim,
        status: "queued",
        simulated: true,
        template: "dunning.reactivate",
      });
      expect(item?.subject).toContain("Standard");
      expect(item?.bodyText).toContain("https://portal.pantryplan.example/back");
    });

    it("still shows a message whose provider send is failing", async () => {
      const id = await enqueue(email(), "dunning.generic");
      provider.failNext(new EmailProviderError("network", "down", true));
      await dispatcher.dispatch(id);
      const page = OutboxResponse.parse((await get("/v1/m/outbox?limit=5")).body);
      expect(page.items.find((i) => i.id === id)).toMatchObject({ status: "queued", sentAt: null });
    });

    it("never shows another merchant's messages", async () => {
      const aIds = new Set(
        OutboxResponse.parse((await get("/v1/m/outbox?limit=100")).body).items.map((i) => i.id),
      );
      const bItems = OutboxResponse.parse((await get("/v1/m/outbox?limit=100", "B")).body).items;
      expect(bItems.length).toBeGreaterThanOrEqual(2);
      for (const item of bItems) expect(aIds.has(item.id)).toBe(false);
      expect(bItems.every((i) => i.template === "winback.ask")).toBe(true);
    });

    it("answers a bad cursor or limit with the error envelope", async () => {
      for (const url of [
        "/v1/m/outbox?cursor=!!!",
        "/v1/m/outbox?cursor=bm90LWEtdXVpZA",
        "/v1/m/outbox?limit=0",
        "/v1/m/outbox?limit=1000",
      ]) {
        const { status, body } = await get(url);
        expect(status).toBe(400);
        expect(ErrorEnvelope.parse(body).error.code).toBe("invalid_request");
      }
    });
  });
});
