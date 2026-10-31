import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { ErrorEnvelope } from "@keepwell/contracts";
import { FakeAudit, FakeDomainEvents, FakeNotifier, uuidv7 } from "@keepwell/contracts/fakes";
import { MemoryDirectory, MemoryJobs, MemoryPolicy, MemoryWinbackStore } from "./memory.js";
import { WINBACK_DELAY_MS, WinbackService } from "./service.js";
import { winbackRoutes } from "./routes.js";
import { REPLY_TOKEN_TTL_MS, signReplyToken, verifyReplyToken } from "./tokens.js";

const SECRET = "test-secret-not-real";
const MERCHANT = uuidv7();
const OTHER_MERCHANT = uuidv7();
const SUB = uuidv7();
const T0 = new Date("2026-11-01T10:00:00.000Z");

function setup() {
  let now = T0;
  const store = new MemoryWinbackStore();
  const directory = new MemoryDirectory();
  const policy = new MemoryPolicy();
  const notifier = new FakeNotifier(() => now);
  const audit = new FakeAudit(() => now);
  const jobs = new MemoryJobs();
  const events = new FakeDomainEvents(() => now);
  const log = Fastify({ logger: false }).log;
  const deps = {
    store,
    directory,
    policy,
    notifier,
    audit,
    jobs,
    log,
    portalUrl: "https://portal.example.test",
    tokenSecret: SECRET,
    clock: () => now,
  };
  const service = new WinbackService(deps);
  service.register(events);
  directory.views.set(SUB, {
    status: "CANCELLED",
    planName: "Standard",
    firstName: "Maya",
    email: "maya@example.test",
    session: "none",
  });
  return {
    store,
    directory,
    policy,
    notifier,
    audit,
    jobs,
    events,
    deps,
    service,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

const codeOf = (res: { json: () => unknown }): string => ErrorEnvelope.parse(res.json()).error.code;

const cancel = (s: ReturnType<typeof setup>, merchantId = MERCHANT) =>
  s.events.emit({
    type: "subscription.cancelled_externally",
    merchantId,
    payload: { subscriptionId: SUB },
  });

describe("opening a case", () => {
  it("records a pending case with a 1 hour timer and enqueues winback.start for then", async () => {
    const s = setup();
    await cancel(s);
    expect(s.store.cases).toHaveLength(1);
    expect(s.store.cases[0]?.state).toBe("pending");
    expect(s.store.cases[0]?.dueAt.getTime()).toBe(T0.getTime() + WINBACK_DELAY_MS);
    expect(s.jobs.sent).toHaveLength(1);
    expect(s.jobs.sent[0]?.options.startAfter?.getTime()).toBe(T0.getTime() + WINBACK_DELAY_MS);
    expect(s.jobs.sent[0]?.options.singletonKey).toBe(SUB);
    expect(s.audit.byKind("winback.case_opened")).toHaveLength(1);
  });

  it("treats a duplicate event as harmless", async () => {
    const s = setup();
    await cancel(s);
    await cancel(s);
    expect(s.store.cases).toHaveLength(1);
    expect(s.jobs.sent).toHaveLength(1);
  });
});

describe("winback.start", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(async () => {
    s = setup();
    await cancel(s);
  });

  it("does nothing before the hour is up", async () => {
    s.advance(WINBACK_DELAY_MS - 1000);
    expect(await s.service.start(SUB)).toEqual({ result: "not_due" });
    expect(s.notifier.queued).toHaveLength(0);
  });

  it("sends exactly one winback.ask, and a second run sends nothing", async () => {
    s.advance(WINBACK_DELAY_MS);
    const first = await s.service.start(SUB);
    const second = await s.service.start(SUB);
    expect(first.result).toBe("sent");
    expect(second).toEqual({ result: "already_handled" });
    expect(s.notifier.byTemplate("winback.ask")).toHaveLength(1);
    expect(s.store.cases[0]?.state).toBe("sent");
    expect(s.audit.byKind("winback.message_queued")).toHaveLength(1);
  });

  it("puts only facts and a signed single-question link in the payload", async () => {
    s.advance(WINBACK_DELAY_MS);
    await s.service.start(SUB);
    const sent = s.notifier.queued[0];
    expect(sent?.to).toBe("maya@example.test");
    if (sent?.content.template !== "winback.ask") throw new Error("wrong template");
    const url = new URL(sent.content.payload.replyUrl);
    expect(url.origin).toBe("https://portal.example.test");
    const token = url.searchParams.get("token") ?? "";
    const checked = verifyReplyToken(SECRET, token, new Date(T0.getTime() + WINBACK_DELAY_MS));
    expect(checked).toMatchObject({ ok: true, claims: { merchantId: MERCHANT } });
  });

  it("includes the resubscribe link only when the policy provides one", async () => {
    s.advance(WINBACK_DELAY_MS);
    s.policy.url = "https://shop.example.test/resubscribe";
    await s.service.start(SUB);
    const withInvite = s.notifier.queued[0]?.content;
    expect(withInvite?.template === "winback.ask" && withInvite.payload.resubscribeUrl).toBe(
      "https://shop.example.test/resubscribe",
    );

    const other = setup();
    await cancel(other);
    other.advance(WINBACK_DELAY_MS);
    await other.service.start(SUB);
    const without = other.notifier.queued[0]?.content;
    expect(without?.template === "winback.ask" && without.payload.resubscribeUrl).toBeNull();
  });

  it("skips when the subscription is no longer cancelled", async () => {
    s.advance(WINBACK_DELAY_MS);
    const view = s.directory.views.get(SUB);
    if (view) view.status = "ACTIVE";
    expect(await s.service.start(SUB)).toEqual({ result: "skipped", reason: "no_longer_cancelled" });
    expect(s.notifier.queued).toHaveLength(0);
    expect(s.store.cases[0]).toMatchObject({ state: "skipped", skipReason: "no_longer_cancelled" });
  });

  it("skips when a session saved them in the meantime", async () => {
    s.advance(WINBACK_DELAY_MS);
    const view = s.directory.views.get(SUB);
    if (view) view.session = "saved";
    expect(await s.service.start(SUB)).toEqual({ result: "skipped", reason: "session_saved" });
    expect(s.notifier.queued).toHaveLength(0);
  });

  it("waits while a session is still open, then sends once it has closed", async () => {
    s.advance(WINBACK_DELAY_MS);
    const view = s.directory.views.get(SUB);
    if (view) view.session = "open";
    expect(await s.service.start(SUB)).toEqual({ result: "deferred" });
    expect(s.store.cases[0]?.state).toBe("pending");
    if (view) view.session = "ended";
    expect(await s.service.sweepDue()).toBe(1);
    expect(s.notifier.queued).toHaveLength(1);
  });

  it("never messages after a skip, and the sweep leaves skipped cases alone", async () => {
    s.advance(WINBACK_DELAY_MS);
    const view = s.directory.views.get(SUB);
    if (view) view.status = "ACTIVE";
    await s.service.start(SUB);
    if (view) view.status = "CANCELLED";
    expect(await s.service.sweepDue()).toBe(0);
    expect(await s.service.start(SUB)).toEqual({ result: "already_handled" });
    expect(s.notifier.queued).toHaveLength(0);
  });

  it("is caught by the sweep when the job was lost", async () => {
    s.advance(WINBACK_DELAY_MS + 1);
    expect(await s.service.sweepDue()).toBe(1);
    expect(s.notifier.queued).toHaveLength(1);
  });
});

describe("startWinbackNow", () => {
  it("sends immediately and flags notification and audit as simulated", async () => {
    const s = setup();
    const outcome = await s.service.startWinbackNow(SUB, MERCHANT);
    expect(outcome.result).toBe("sent");
    expect(s.notifier.queued[0]?.simulated).toBe(true);
    for (const entry of s.audit.entries) {
      expect(entry.simulated).toBe(true);
      expect(entry.payload.simulated).toBe(true);
    }
  });

  it("needs a merchant when no case exists", async () => {
    const s = setup();
    await expect(s.service.startWinbackNow(SUB)).rejects.toThrow(/merchantId/);
  });
});

describe("reply endpoint", () => {
  async function sentCase() {
    const s = setup();
    await cancel(s);
    s.advance(WINBACK_DELAY_MS);
    await s.service.start(SUB);
    const winback = s.store.cases[0];
    if (!winback) throw new Error("no case");
    const app = Fastify({ logger: false });
    await app.register(winbackRoutes, {
      prefix: "/v1",
      deps: s.deps,
      allowOrigin: () => true,
      rateLimit: { max: 5, windowMs: 60_000 },
    });
    const token = (merchantId = MERCHANT, at = T0) =>
      signReplyToken(SECRET, { merchantId, caseId: winback.id }, at);
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/v1/winback/replies", payload });
    return { s, app, winback, token, post };
  }

  it("stores the reply, queues insights.extract, audits, and returns 202", async () => {
    const { s, token, post } = await sentCase();
    const res = await post({
      token: token(MERCHANT, new Date(T0.getTime() + WINBACK_DELAY_MS)),
      text: "Too pricey",
    });
    expect(res.statusCode).toBe(202);
    expect(s.store.replies).toHaveLength(1);
    const reply = s.store.replies[0];
    expect(s.jobs.sent.filter((j) => j.name === "insights.extract")).toEqual([
      expect.objectContaining({ payload: { replyId: reply?.id } }),
    ]);
    expect(s.audit.byKind("winback.reply_received")).toHaveLength(1);
    expect(JSON.stringify(s.audit.entries)).not.toContain("Too pricey");
    expect(s.store.cases[0]?.state).toBe("replied");
  });

  it("rejects a reused token", async () => {
    const { s, token, post } = await sentCase();
    const t = token(MERCHANT, new Date(T0.getTime() + WINBACK_DELAY_MS));
    expect((await post({ token: t, text: "one" })).statusCode).toBe(202);
    const again = await post({ token: t, text: "two" });
    expect(again.statusCode).toBe(409);
    expect(codeOf(again)).toBe("token_used");
    expect(s.store.replies).toHaveLength(1);
  });

  it("rejects an expired token", async () => {
    const { s, token, post } = await sentCase();
    // Signed so that it expired before "now" (T0 + 1h).
    const old = token(MERCHANT, new Date(T0.getTime() - REPLY_TOKEN_TTL_MS));
    const res = await post({ token: old, text: "late" });
    expect(res.statusCode).toBe(401);
    expect(codeOf(res)).toBe("expired_token");
    expect(s.store.replies).toHaveLength(0);
  });

  it("rejects a forged or wrong-secret token", async () => {
    const { winback, post } = await sentCase();
    const forged = signReplyToken("another-secret", { merchantId: MERCHANT, caseId: winback.id }, T0);
    expect((await post({ token: forged, text: "x" })).statusCode).toBe(401);
    expect((await post({ token: "garbage", text: "x" })).statusCode).toBe(401);
  });

  it("does not let a token for another merchant reach this merchant's case", async () => {
    const { s, token, post } = await sentCase();
    const res = await post({
      token: token(OTHER_MERCHANT, new Date(T0.getTime() + WINBACK_DELAY_MS)),
      text: "x",
    });
    expect(res.statusCode).toBe(401);
    expect(codeOf(res)).toBe("invalid_token");
    expect(s.store.replies).toHaveLength(0);
    expect(s.store.cases[0]?.state).toBe("sent");
  });

  it("enforces the 1000 character limit and rejects empty text and extra fields", async () => {
    const { s, token, post } = await sentCase();
    const t = token(MERCHANT, new Date(T0.getTime() + WINBACK_DELAY_MS));
    expect((await post({ token: t, text: "a".repeat(1001) })).statusCode).toBe(400);
    expect((await post({ token: t, text: "   " })).statusCode).toBe(400);
    expect((await post({ token: t, text: "ok", merchantId: OTHER_MERCHANT })).statusCode).toBe(400);
    expect((await post({ token: t, text: "a".repeat(1000) })).statusCode).toBe(202);
    expect(s.store.replies).toHaveLength(1);
  });

  it("rate limits by client", async () => {
    const { post } = await sentCase();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post({ token: "x", text: "y" })).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it("refuses a reply when no message was ever sent for the case", async () => {
    const s = setup();
    await cancel(s);
    const winback = s.store.cases[0];
    if (!winback) throw new Error("no case");
    const app = Fastify({ logger: false });
    await app.register(winbackRoutes, { prefix: "/v1", deps: s.deps, allowOrigin: () => false });
    const res = await app.inject({
      method: "POST",
      url: "/v1/winback/replies",
      payload: {
        token: signReplyToken(SECRET, { merchantId: MERCHANT, caseId: winback.id }, T0),
        text: "hi",
      },
    });
    expect(res.statusCode).toBe(401);
  });
});
