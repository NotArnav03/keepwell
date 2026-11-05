import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ErrorEnvelope, OutboxResponse, type Notifier, type TemplateId } from "@keepwell/contracts";
import { createDb, merchants, notifications, type Db, type Tx } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { loadEnv } from "../../env.js";
import { DbAudit } from "../audit/log.js";
import { DbDomainEvents } from "../jobs/domain-events.js";
import { Jobs } from "../jobs/jobs.js";
import { buildServer } from "../../server.js";
import { notifyConfigFromEnv } from "./config.js";
import { createDispatcher, enqueueDueNotifications, MAX_ATTEMPTS } from "./dispatcher.js";
import { CONTENT } from "./fixtures.js";
import { wireNotify } from "./index.js";
import { createNotifier } from "./notifier.js";
import { EmailProviderError, FakeEmailProvider } from "./providers.js";
import { notifyRoutes } from "./routes.js";
import { createUnsubscribeToken, hashEmail } from "./unsubscribe-token.js";

// Real Postgres 18, like packages/db's tests: KEEPWELL_TEST_DATABASE_URL (CI has a service container).
// The email provider is always the in-memory fake: nothing here touches the network.

const URL_ = TEST_DATABASE_URL;
const A = "0199c000-0000-7000-8000-00000000000a";
const B = "0199c000-0000-7000-8000-00000000000b";
const DAY = 24 * 60 * 60 * 1000;
const config = notifyConfigFromEnv(
  loadEnv({ NODE_ENV: "test", UNSUBSCRIBE_TOKEN_SECRET: "test-secret-test-secret-test-secret-0123" }),
  "http://localhost:3000",
);
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

let testDb: TestDatabase;
let db: Db;
let jobs: Jobs;
let now = new Date();
let audit: DbAudit;
let events: DbDomainEvents;
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
/** Audit kinds written for one notification, read straight from the hash-chained log. */
const auditKinds = async (notificationId: string): Promise<string[]> =>
  (
    await testDb.ownerPool.query<{ kind: string }>(
      "SELECT kind FROM audit_log WHERE subject_ids->>'notificationId' = $1 ORDER BY seq",
      [notificationId],
    )
  ).rows.map((r) => r.kind);
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
    testDb = await createTestDatabase(URL_ ?? "");
    db = createDb(testDb.appPool);
    for (const [id, slug] of [
      [A, "alpha"],
      [B, "bravo"],
    ] as const) {
      await db.forMerchant(id, (tx) => tx.insert(merchants).values({ id, slug, name: slug }));
    }
    jobs = await Jobs.start({ connectionString: testDb.url, log, pollingIntervalSeconds: 0.5 });
    audit = new DbAudit(db, () => now);
    events = new DbDomainEvents(db, jobs, log);
    notifier = createNotifier({ db, audit, log, now: () => now });
    dispatcher = createDispatcher({ db, provider, audit, events, config, log, now: () => now });
  }, 120_000);

  afterAll(async () => {
    await jobs.stop();
    await testDb.drop();
  }, 60_000);

  describe("outbox insert", () => {
    it("commits with the caller's transaction and audits", async () => {
      const to = email();
      const id = await db.forMerchant(A, (tx) =>
        notifier.enqueue({ merchantId: A, subscriptionId: null, to, content: CONTENT["winback.ask"] }, tx),
      );
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: "queued", attempts: 0, template: "winback.ask", simulated: false });
      expect(await auditKinds(id)).toEqual(["notification.enqueued"]);
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
      expect(await auditKinds(id)).toEqual([]); // the audit entry rolled back too
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
      const to = email();
      const id = await enqueue(to);
      const before = provider.sent.length;
      expect(await dispatcher.dispatch(id)).toEqual({ status: "sent" });
      expect(await dispatcher.dispatch(id)).toEqual({ status: "skipped" });
      expect(provider.sent.length - before).toBe(1);
      expect(await rowOf(id)).toMatchObject({ status: "sent", providerId: `fake:${id}`, attempts: 1 });
      const emitted = await testDb.ownerPool.query<{ payload: unknown }>(
        "SELECT payload FROM domain_events WHERE type = 'notification.sent' AND payload->>'notificationId' = $1",
        [id],
      );
      expect(emitted.rows).toHaveLength(1);
      expect(emitted.rows[0]?.payload).toMatchObject({ template: "dunning.generic", channel: "email" });
      expect(await auditKinds(id)).toEqual(["notification.enqueued", "notification.sent"]);
      const message = provider.sent.at(-1);
      expect(message?.text).toContain("/v1/unsubscribe?token=");
      const link = message?.unsubscribeUrl ?? "";
      expect(link.includes(to)).toBe(false);
      expect(link.toLowerCase().includes(to.replaceAll("@", "%40"))).toBe(false);
      expect(link.includes("@")).toBe(false);
    });

    it("two workers at once still send once", async () => {
      const id = await enqueue(email());
      const before = provider.sent.length;
      await Promise.all([dispatcher.dispatch(id), dispatcher.dispatch(id)]);
      expect(provider.sent.length - before).toBe(1);
    });

    it("sends a row whose own send lease has expired", async () => {
      const to = email();
      const id = await enqueue(to);
      await testDb.ownerPool.query(
        `UPDATE notifications SET status = 'sending', due_at = $2, attempts = 1 WHERE id = $1`,
        [id, new Date(now.getTime() - 1000)],
      );
      expect(await dispatcher.dispatch(id)).toEqual({ status: "sent" });
      expect(provider.sent.filter((m) => m.to === to)).toHaveLength(1);
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
    it("counts a send that is still in flight", async () => {
      const to = email();
      const inflight = await enqueue(to);
      await testDb.ownerPool.query(`UPDATE notifications SET status = 'sending', due_at = $2 WHERE id = $1`, [
        inflight,
        new Date(now.getTime() + 5 * 60 * 1000),
      ]);
      const outcome = await dispatcher.dispatch(await enqueue(to));
      expect(outcome.status).toBe("deferred");
      if (outcome.status === "deferred") {
        expect(Math.abs(outcome.retryAt.getTime() - now.getTime() - DAY)).toBeLessThanOrEqual(1000);
      }
      expect(provider.sent.filter((m) => m.to === to)).toHaveLength(0);
      // Leave it finished so a later sweep does not deliver this fixture.
      await testDb.ownerPool.query(`UPDATE notifications SET status = 'failed' WHERE id = $1`, [inflight]);
    });

    it("two concurrent dispatches for the same address on the same day send exactly one", async () => {
      const to = email();
      const [first, second] = [await enqueue(to), await enqueue(to)];
      let release: () => void = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = provider.send.bind(provider);
      let sendCalls = 0;
      let settled = 0;
      provider.send = (message) => {
        sendCalls += 1;
        const result = original(message);
        // Hold the first delivery so the other dispatch observes `sending`, not yet `sent`.
        if (sendCalls === 1) return hold.then(() => result);
        return result;
      };
      const pending = Promise.all(
        [first, second].map(async (id) => {
          const outcome = await dispatcher.dispatch(id);
          settled += 1;
          return outcome;
        }),
      );
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && sendCalls < 2 && !(sendCalls >= 1 && settled >= 1)) {
          await new Promise((r) => setTimeout(r, 15));
        }
        expect(sendCalls).toBe(1);
        expect(settled).toBe(1);
        release();
        const outcomes = await pending;
        expect(outcomes.map((o) => o.status).sort()).toEqual(["deferred", "sent"]);
        expect(provider.sent.filter((m) => m.to === to)).toHaveLength(1);
      } finally {
        release();
        provider.send = original;
        await pending.catch(() => undefined);
      }
    });

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
        email: `  ${to.toUpperCase()}  `,
      });
      const queued = await enqueue(to);
      const unsubscribedCount = async (): Promise<number> =>
        (
          await testDb.ownerPool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM audit_log WHERE kind = 'notification.unsubscribed'",
          )
        ).rows[0]?.n ?? 0;
      const before = await unsubscribedCount();
      for (let i = 0; i < 2; i++) {
        const res = await server.inject({ method: "GET", url: `/v1/unsubscribe?token=${token}` });
        expect(res.statusCode).toBe(200);
      }
      expect((await unsubscribedCount()) - before).toBe(1); // the second click is not a new change
      const stored = await testDb.ownerPool.query<{ email_hash: string }>(
        "SELECT email_hash FROM email_unsubscribes WHERE merchant_id = $1 AND email_hash = $2",
        [A, hashEmail(to)],
      );
      expect(stored.rows).toEqual([{ email_hash: hashEmail(to) }]);
      // The row's address is not normalised, so the dispatcher has to hash it the same way as the link.
      await testDb.ownerPool.query(`UPDATE notifications SET "to" = $2 WHERE id = $1`, [
        queued,
        `  ${to.toUpperCase()}  `,
      ]);
      const calls = provider.calls;
      expect(await dispatcher.dispatch(queued)).toEqual({ status: "suppressed", reason: "unsubscribed" });
      expect(provider.calls).toBe(calls);
      expect(await rowOf(queued)).toMatchObject({ status: "suppressed", suppressedBecause: "unsubscribed" });
      // Put the address back: the Demo Inbox tests list every row and validate each `to` as an email.
      await testDb.ownerPool.query(`UPDATE notifications SET "to" = $2 WHERE id = $1`, [queued, to]);
    });

    it("does not apply a token for another address", async () => {
      const to = email();
      const token = createUnsubscribeToken(config.unsubscribeSecret, {
        merchantId: A,
        email: "someone-else@example.com",
      });
      const res = await server.inject({ method: "GET", url: `/v1/unsubscribe?token=${token}` });
      expect(res.statusCode).toBe(200);
      expect(await dispatcher.dispatch(await enqueue(to))).toEqual({ status: "sent" });
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
      await testDb.ownerPool.query(`UPDATE notifications SET status = 'sending', due_at = $2 WHERE id = $1`, [
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

  describe("platform wiring (real pg-boss jobs)", () => {
    it("the due-work hook enqueues notify.dispatch and the worker sends the message", async () => {
      now = new Date(); // the sweep hook reads the real clock
      const dueWork = new Map<string, () => Promise<void>>();
      await wireNotify({
        db,
        dispatcher,
        jobs,
        registerDueWork: (name, fn) => dueWork.set(name, fn),
      });
      const id = await enqueue(email(), "dunning.update_payment_method");
      const hook = dueWork.get("notify.dispatch");
      if (!hook) throw new Error("wireNotify registered no due work");
      await hook();
      const end = Date.now() + 15_000;
      while ((await rowOf(id))?.status !== "sent") {
        if (Date.now() > end) throw new Error("the worker never sent the message");
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(provider.sent.filter((m) => m.id === id)).toHaveLength(1);
      // A second sweep finds nothing left to do.
      await hook();
      await new Promise((r) => setTimeout(r, 1500));
      expect(provider.sent.filter((m) => m.id === id)).toHaveLength(1);
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
