import { createHmac } from "node:crypto";
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
    expect(s.jobs.sent[0]).toMatchObject({ name: "winback.start", payload: { subscriptionId: SUB } });
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

  it("stores the reply with emails, phones and card numbers redacted", async () => {
    const { s, token, post } = await sentCase();
    const raw =
      "I was away for 2 months and paid 12 dollars on 3 March. Reach me at maya@example.test or +1 415 555 0100. Card 4111-1111-1111-1111.";
    const res = await post({
      token: token(MERCHANT, new Date(T0.getTime() + WINBACK_DELAY_MS)),
      text: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(s.store.replies[0]?.text).toBe(
      "I was away for 2 months and paid 12 dollars on 3 March. Reach me at [email] or [phone]. Card [number].",
    );
    expect(JSON.stringify(s.audit.entries)).not.toContain("maya@example.test");
    expect(JSON.stringify(s.audit.entries)).not.toContain("4111");
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

describe("reply token purpose", () => {
  const claims = { merchantId: MERCHANT, caseId: uuidv7() };

  function signForPurpose(purpose: string): string {
    const body = Buffer.from(
      JSON.stringify({ m: claims.merchantId, c: claims.caseId, exp: T0.getTime() + REPLY_TOKEN_TTL_MS }),
    ).toString("base64url");
    const sig = createHmac("sha256", SECRET)
      .update(purpose + body)
      .digest("base64url");
    return `${body}.${sig}`;
  }

  it("verifies a token it signed, and the MAC covers the winback-reply purpose", () => {
    const token = signReplyToken(SECRET, claims, T0);
    expect(verifyReplyToken(SECRET, token, T0)).toEqual({ ok: true, claims });
    const [body, sig] = token.split(".");
    const expected = createHmac("sha256", SECRET)
      .update(`winback-reply\n${body ?? ""}`)
      .digest("base64url");
    expect(sig).toBe(expected);
  });

  it("rejects a token signed without the purpose prefix or with another prefix", () => {
    expect(verifyReplyToken(SECRET, signForPurpose(""), T0)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyReplyToken(SECRET, signForPurpose("magic-link\n"), T0)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("still expires", () => {
    const token = signReplyToken(SECRET, claims, new Date(T0.getTime() - REPLY_TOKEN_TTL_MS));
    expect(verifyReplyToken(SECRET, token, T0)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("startBatch", () => {
  function track(
    s: ReturnType<typeof setup>,
    subscriptionId: string,
    status: "ACTIVE" | "SUSPENDED" | "CANCELLED" | "OTHER",
    merchantId = MERCHANT,
  ) {
    s.store.subscriptions.push({ merchantId, subscriptionId, status });
  }

  it("queues cancelled subscriptions that have no case, and skips the rest", async () => {
    const s = setup();
    const active = uuidv7();
    const missing = uuidv7();
    const sentSub = uuidv7();
    const repliedSub = uuidv7();
    const skippedSub = uuidv7();
    track(s, SUB, "CANCELLED");
    track(s, active, "ACTIVE");
    track(s, sentSub, "CANCELLED");
    track(s, repliedSub, "CANCELLED");
    track(s, skippedSub, "CANCELLED");
    await s.store.withMerchant(MERCHANT, async (repo) => {
      const sent = await repo.openCase({
        merchantId: MERCHANT,
        subscriptionId: sentSub,
        dueAt: T0,
        simulated: false,
      });
      await repo.transition(sent.case.id, "pending", { state: "sent", sentAt: T0 });
      const replied = await repo.openCase({
        merchantId: MERCHANT,
        subscriptionId: repliedSub,
        dueAt: T0,
        simulated: false,
      });
      await repo.transition(replied.case.id, "pending", { state: "sent", sentAt: T0 });
      await repo.transition(replied.case.id, "sent", { state: "replied" });
      const skipped = await repo.openCase({
        merchantId: MERCHANT,
        subscriptionId: skippedSub,
        dueAt: T0,
        simulated: true,
      });
      await repo.transition(skipped.case.id, "pending", { state: "skipped", skipReason: "session_saved" });
    });

    const first = await s.service.startBatch(MERCHANT, [
      SUB,
      active,
      missing,
      sentSub,
      repliedSub,
      skippedSub,
    ]);
    expect(first).toEqual({
      queued: 1,
      skipped: [
        { subscriptionId: active, reason: "not_cancelled" },
        { subscriptionId: missing, reason: "not_found" },
        { subscriptionId: sentSub, reason: "already_sent" },
        { subscriptionId: repliedSub, reason: "already_replied" },
        { subscriptionId: skippedSub, reason: "already_skipped" },
      ],
    });
    const opened = s.store.cases.find((c) => c.subscriptionId === SUB);
    expect(opened).toMatchObject({ state: "pending", simulated: false, dueAt: T0 });
    expect(s.jobs.sent.filter((job) => job.name === "winback.start")).toEqual([
      { name: "winback.start", payload: { subscriptionId: SUB }, options: { startAfter: T0 } },
    ]);
    expect(s.audit.byKind("winback.batch_queued")).toHaveLength(1);
    expect(s.audit.byKind("winback.batch_queued")[0]).toMatchObject({
      actor: "system",
      simulated: false,
      payload: { queued: 1, subscriptionIds: [SUB] },
    });

    const second = await s.service.startBatch(MERCHANT, [SUB, active]);
    expect(second).toEqual({
      queued: 0,
      skipped: [
        { subscriptionId: SUB, reason: "already_pending" },
        { subscriptionId: active, reason: "not_cancelled" },
      ],
    });
    expect(s.jobs.sent.filter((job) => job.name === "winback.start")).toHaveLength(1);
    expect(s.store.cases.filter((c) => c.subscriptionId === SUB)).toHaveLength(1);
    expect(s.audit.byKind("winback.batch_queued")).toHaveLength(1);
  });

  it("does not pull an existing pending case forward or enqueue it again", async () => {
    const s = setup();
    track(s, SUB, "CANCELLED");
    await cancel(s);
    const result = await s.service.startBatch(MERCHANT, [SUB]);
    expect(result).toEqual({ queued: 0, skipped: [{ subscriptionId: SUB, reason: "already_pending" }] });
    expect(s.jobs.sent).toHaveLength(1);
    expect(s.store.cases[0]?.dueAt.toISOString()).toBe(
      new Date(T0.getTime() + WINBACK_DELAY_MS).toISOString(),
    );
    expect(s.audit.byKind("winback.batch_queued")).toHaveLength(0);
  });

  it("collapses duplicate ids and hides another merchant's subscription", async () => {
    const s = setup();
    const otherSub = uuidv7();
    track(s, SUB, "CANCELLED");
    track(s, otherSub, "CANCELLED", OTHER_MERCHANT);
    const result = await s.service.startBatch(MERCHANT, [SUB, SUB, otherSub]);
    expect(result).toEqual({
      queued: 1,
      skipped: [{ subscriptionId: otherSub, reason: "not_found" }],
    });
    expect(s.store.cases.map((c) => c.merchantId)).toEqual([MERCHANT]);
    expect(s.jobs.sent).toHaveLength(1);
  });

  it("accepts 500 ids and rejects 501 or a bad id", async () => {
    const s = setup();
    const ids = Array.from({ length: 500 }, () => uuidv7());
    const accepted = await s.service.startBatch(MERCHANT, ids);
    expect(accepted.queued).toBe(0);
    expect(accepted.skipped).toHaveLength(500);
    expect(accepted.skipped.every((row) => row.reason === "not_found")).toBe(true);
    expect(s.audit.entries).toHaveLength(0);
    await expect(s.service.startBatch(MERCHANT, [])).resolves.toEqual({ queued: 0, skipped: [] });
    await expect(s.service.startBatch(MERCHANT, [...ids, uuidv7()])).rejects.toThrow();
    await expect(s.service.startBatch("not-a-uuid", [SUB])).rejects.toThrow();
  });
});
