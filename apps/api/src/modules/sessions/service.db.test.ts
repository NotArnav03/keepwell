import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  SessionError,
  type Agent,
  type DomainEvent,
  type PlanInfo,
  type SessionStreamEvent,
  type SubscriberHistory,
  type SubscriberPrincipal,
  type SubscriptionSnapshot,
} from "@keepwell/contracts";
import {
  FakeAudit,
  FakeDomainEvents,
  FakePolicyStore,
  PANTRY_PLAN,
  pantryPlanSubscription,
} from "@keepwell/contracts/fakes";
import { createDb, merchants, subscriptions, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { DbActionEngine } from "../actions/engine.js";
import { AgentRuntime } from "../agent/runtime.js";
import { DbSessionsApi, MAX_SUBSCRIBER_MESSAGES, type PaymentLookup } from "./service.js";

// The real sessions module against a real database (#32). The agent is the real runtime with no
// model (L1: reason chips and the policy's own menu), so offers match what the policy re-checks at
// accept, and no test calls Anthropic or PayPal. PayPal's answers are played by updating the
// Action's row and handing the service the action.state_changed event the engine would emit.

const M = PANTRY_PLAN.merchantId;
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const history: SubscriberHistory = {
  savesLast365d: 0,
  pausesLast365d: 0,
  lastPauseEndedAt: null,
  refundedLast30d: { value: "0.00", currency: "USD" },
};

let testDb: TestDatabase;
let db: Db;
let subscriptionId = "";
let otherSubscriptionId = "";
let snapshot: SubscriptionSnapshot;

async function addSubscription(key: string): Promise<string> {
  const [row] = await db.forMerchant(M, (tx) =>
    tx
      .insert(subscriptions)
      .values({
        merchantId: M,
        paypalSubscriptionId: `I-${key}`,
        paypalPlanId: PANTRY_PLAN.standard.planId,
        planName: "Standard",
        status: "ACTIVE",
        intervalUnit: "MONTH",
        intervalCount: 1,
        priceValue: "12.00",
        priceCurrency: "USD",
        startedAt: new Date("2026-03-01T00:00:00Z"),
        snapshot: {},
        syncedAt: new Date(),
      })
      .returning({ id: subscriptions.id }),
  );
  if (!row) throw new Error("seed failed");
  return row.id;
}

/** Throws on every call: proves a code path never touches the agent (design law 1). */
const disabledAgent: Agent = {
  start: () => Promise.reject(new Error("agent disabled")),
  respond: () => Promise.reject(new Error("agent disabled")),
  respondToReason: () => Promise.reject(new Error("agent disabled")),
};

function build(
  options: {
    agent?: Agent;
    payments?: PaymentLookup;
    subscription?: () => SubscriptionSnapshot;
    idleMs?: number;
    abandonAfterMs?: number;
  } = {},
) {
  const events = new FakeDomainEvents();
  const audit = new FakeAudit();
  const policies = new FakePolicyStore();
  void policies.publish({
    merchantId: M,
    document: PANTRY_PLAN.policy,
    baseVersion: null,
    publishedBy: "test",
    changeNote: null,
  });
  const engine = new DbActionEngine({
    db,
    lockPool: testDb.appPool,
    paypal: {} as never,
    audit,
    events,
    log: quiet,
  });
  const plans: PlanInfo[] = PANTRY_PLAN.plans;
  const api = new DbSessionsApi({
    db,
    agent: options.agent ?? new AgentRuntime({ llm: null, events, audit, log: quiet }),
    engine,
    events,
    audit,
    policies,
    catalog: {
      plans: () => Promise.resolve(plans),
      samples: (_m, ids) =>
        Promise.resolve(
          ids
            .filter((id) => id === subscriptionId || id === otherSubscriptionId)
            .map((id) => ({ subscription: { ...(options.subscription?.() ?? snapshot), id }, history })),
        ),
    },
    payments: options.payments ?? { listTransactions: () => Promise.resolve([]) },
    streamUrl: (id) => `https://api.keepwell.example/v1/sessions/${id}/stream`,
    pollMs: 50,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.abandonAfterMs === undefined ? {} : { abandonAfterMs: options.abandonAfterMs }),
  });
  return { api, events, audit, engine };
}

const maya = (): SubscriberPrincipal => ({ merchantId: M, subscriptionId, channel: "widget" });
const meta = { ipPrefix: "203.0.113.0/24", userAgent: "vitest" };

/** Collects a session's stream, replay included. */
async function watch(api: DbSessionsApi, sessionId: string, afterSeq = 0) {
  const seen: [number, SessionStreamEvent][] = [];
  const sub = await api.subscribe(maya(), sessionId, afterSeq, (seq, event) => seen.push([seq, event]));
  return { seen, ...sub };
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Moves an Action as PayPal would, and delivers the event the engine would emit. */
async function payPalMoves(
  api: DbSessionsApi,
  actionId: string,
  from: string,
  to: "EXECUTING" | "APPLIED" | "CONFIRMED" | "FAILED",
) {
  await testDb.ownerPool.query("UPDATE actions SET state = $1 WHERE id = $2", [to, actionId]);
  const { rows } = await testDb.ownerPool.query<{ type: string }>("SELECT type FROM actions WHERE id = $1", [
    actionId,
  ]);
  const event = {
    type: "action.state_changed",
    merchantId: M,
    payload: { actionId, type: rows[0]?.type, from, to, approveUrl: null, error: null },
  } as unknown as DomainEvent<"action.state_changed">;
  await api.onActionStateChanged(event);
}

/** Starts a session and has the policy's pause offer presented (the L1 "temporary" chip). */
async function withPauseOffer(api: DbSessionsApi, reason: "temporary" | "quality_issue" = "temporary") {
  const created = await api.create(maya(), { channel: "widget" });
  await api.reason(maya(), created.sessionId, { reason });
  const { rows } = await testDb.ownerPool.query<{
    picked_offer: { offer: { id: string; kind: string }; shownTextHash: string };
  }>("SELECT picked_offer FROM offers WHERE session_id = $1", [created.sessionId]);
  const picked = rows[0]?.picked_offer;
  if (!picked) throw new Error("no offer presented");
  return {
    sessionId: created.sessionId,
    offerId: picked.offer.id,
    hash: picked.shownTextHash,
    kind: picked.offer.kind,
  };
}

describe.skipIf(TEST_DATABASE_URL === undefined)("DbSessionsApi", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    await db.forMerchant(M, (tx) =>
      tx.insert(merchants).values({ id: M, slug: "pantry-plan", name: "Pantry Plan" }),
    );
    subscriptionId = await addSubscription("MAYA0001");
    otherSubscriptionId = await addSubscription("RAJ00001");
  }, 120_000);

  beforeEach(() => {
    snapshot = pantryPlanSubscription(new Date(), { merchantId: M });
  });

  afterAll(async () => {
    await testDb.drop();
  }, 60_000);

  it("starts a session: stored, announced, audited, with the menu kept for the accept re-check", async () => {
    const { api, events, audit } = build();
    const created = await api.create(maya(), { channel: "widget" });
    expect(created.merchant.name).toBe("Pantry Plan");
    expect(created.fallbackLevel).toBe("L1");
    expect(created.streamUrl).toBe(`https://api.keepwell.example/v1/sessions/${created.sessionId}/stream`);

    const { rows } = await testDb.ownerPool.query("SELECT state, channel FROM sessions WHERE id = $1", [
      created.sessionId,
    ]);
    expect(rows[0]).toEqual({ state: "open", channel: "widget" });
    const menu = await testDb.ownerPool.query<{ menu_snapshot: { policyVersion: number } }>(
      "SELECT menu_snapshot FROM offers WHERE session_id = $1",
      [created.sessionId],
    );
    expect(menu.rows[0]?.menu_snapshot.policyVersion).toBe(PANTRY_PLAN.policy.version);
    expect(events.emitted.map((e) => e.type)).toContain("session.started");
    expect(audit.entries.map((e) => e.kind)).toContain("session.started");

    // L1 starts with the reason chips on the stream.
    const stream = await watch(api, created.sessionId);
    stream.unsubscribe();
    expect(stream.seen[0]?.[1].type).toBe("reason.chips");
  });

  it("refuses a credential for another channel, and a subscription it doesn't know", async () => {
    const { api } = build();
    await expect(api.create({ ...maya(), channel: "portal" }, { channel: "widget" })).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(
      api.create(
        { ...maya(), subscriptionId: "0199c100-0000-7000-8000-00000000ffff" },
        { channel: "widget" },
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("shows the policy's offer for a reason chip, once, and streams it live and on replay", async () => {
    const { api } = build();
    const created = await api.create(maya(), { channel: "widget" });
    const live = await watch(api, created.sessionId);
    await api.reason(maya(), created.sessionId, { reason: "temporary" });
    // The reply ends with agent.done, after the card.
    await until(() => live.seen.some(([, e]) => e.type === "agent.done"));
    live.unsubscribe();

    const seqs = live.seen.map(([seq]) => seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // A reconnect after seq 1 replays exactly the rest.
    const replay = await watch(api, created.sessionId, 1);
    replay.unsubscribe();
    expect(replay.seen.map(([seq]) => seq)).toEqual(seqs.slice(1));

    // A second chip never shows a second offer.
    await api.reason(maya(), created.sessionId, { reason: "price" });
    const all = await watch(api, created.sessionId);
    all.unsubscribe();
    expect(all.seen.filter(([, e]) => e.type === "offer.presented")).toHaveLength(1);
  });

  it("stores the transcript redacted, and stops after three messages", async () => {
    const { api } = build();
    const { sessionId } = await api.create(maya(), { channel: "widget" });
    await api.message(maya(), sessionId, { text: "email me at maya@example.com or +91 98765 43210" });
    const { rows } = await testDb.ownerPool.query<{ role: string; text: string }>(
      "SELECT role, text FROM messages WHERE session_id = $1 ORDER BY created_at, id",
      [sessionId],
    );
    expect(rows[0]).toEqual({ role: "subscriber", text: "email me at [email] or [phone]" });
    expect(rows.some((r) => r.role === "agent")).toBe(true);

    for (let i = 1; i < MAX_SUBSCRIBER_MESSAGES; i++) await api.message(maya(), sessionId, { text: "hmm" });
    await expect(api.message(maya(), sessionId, { text: "one more" })).rejects.toMatchObject({
      code: "limit_reached",
    });
  });

  it("accepts with the shown text only, records consent, creates the suspend and its resume, once", async () => {
    const { api, audit } = build();
    const { sessionId, offerId, hash, kind } = await withPauseOffer(api);
    expect(kind).toBe("pause");

    await expect(
      api.accept(maya(), sessionId, offerId, { shownTextHash: "b".repeat(64) }, meta),
    ).rejects.toMatchObject({ code: "consent_mismatch" });

    const first = await api.accept(maya(), sessionId, offerId, { shownTextHash: hash }, meta);
    const second = await api.accept(maya(), sessionId, offerId, { shownTextHash: hash }, meta);
    expect(second).toEqual(first);
    const actionId = first.actionIds[0];

    const action = await testDb.ownerPool.query("SELECT type, idempotency_key FROM actions WHERE id = $1", [
      actionId,
    ]);
    expect(action.rows[0]).toEqual({ type: "suspend", idempotency_key: `${sessionId}:${offerId}` });
    const resume = await testDb.ownerPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM scheduled_resumes WHERE after_action_id = $1",
      [actionId],
    );
    expect(resume.rows[0]?.n).toBe(1);
    const offer = await testDb.ownerPool.query<{ status: string; consent: unknown }>(
      "SELECT status, consent FROM offers WHERE session_id = $1",
      [sessionId],
    );
    expect(offer.rows[0]?.status).toBe("accepted");
    expect(offer.rows[0]?.consent).toMatchObject({
      shownTextHash: hash,
      channel: "widget",
      ipPrefix: meta.ipPrefix,
    });
    expect(audit.entries.filter((e) => e.kind === "offer.accepted")).toHaveLength(1);
  });

  it("closes as saved_pause when PayPal applies the suspend, and tells the stream", async () => {
    const { api } = build();
    const { sessionId, offerId, hash } = await withPauseOffer(api);
    const { actionIds } = await api.accept(maya(), sessionId, offerId, { shownTextHash: hash }, meta);
    const stream = await watch(api, sessionId);

    await payPalMoves(api, actionIds[0] ?? "", "PENDING", "EXECUTING");
    await payPalMoves(api, actionIds[0] ?? "", "EXECUTING", "APPLIED");
    await payPalMoves(api, actionIds[0] ?? "", "APPLIED", "CONFIRMED");
    await until(() => stream.seen.some(([, e]) => e.type === "session.closed"));
    stream.unsubscribe();

    const closed = stream.seen.filter(([, e]) => e.type === "session.closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.[1]).toMatchObject({ outcome: "saved_pause" });
    const { rows } = await testDb.ownerPool.query("SELECT state, outcome FROM sessions WHERE id = $1", [
      sessionId,
    ]);
    expect(rows[0]).toEqual({ state: "closed", outcome: "saved_pause" });
  });

  it("refuses an offer the policy no longer allows at accept, and leaves cancel and keep open", async () => {
    let status: SubscriptionSnapshot["status"] = "ACTIVE";
    const { api } = build({ subscription: () => ({ ...snapshot, status }) });
    const { sessionId, offerId, hash } = await withPauseOffer(api);
    status = "SUSPENDED";
    await expect(api.accept(maya(), sessionId, offerId, { shownTextHash: hash }, meta)).rejects.toMatchObject(
      {
        code: "offer_unavailable",
      },
    );
    const { rows } = await testDb.ownerPool.query<{ status: string }>(
      "SELECT status FROM offers WHERE session_id = $1",
      [sessionId],
    );
    expect(rows[0]?.status).toBe("refused_at_accept");
    await api.keep(maya(), sessionId);
  });

  it("cancels without the agent, in any state, once per click, and again after a failed attempt", async () => {
    const { api } = build();
    const { sessionId, offerId, hash } = await withPauseOffer(api);
    await api.accept(maya(), sessionId, offerId, { shownTextHash: hash }, meta);

    // Same database, but an agent that throws on any call: cancel must not need it.
    const { api: noAgent } = build({ agent: disabledAgent });
    const first = await noAgent.cancel(maya(), sessionId, {});
    expect(await noAgent.cancel(maya(), sessionId, { reason: "price" })).toEqual(first);

    await payPalMoves(noAgent, first.actionId, "PENDING", "FAILED");
    const second = await noAgent.cancel(maya(), sessionId, {});
    expect(second.actionId).not.toBe(first.actionId);
    const keys = await testDb.ownerPool.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM actions WHERE idempotency_key LIKE $1 ORDER BY created_at",
      [`${sessionId}:cancel:%`],
    );
    expect(keys.rows.map((r) => r.idempotency_key)).toEqual([
      `${sessionId}:cancel:1`,
      `${sessionId}:cancel:2`,
    ]);
  });

  it("retries an accepted offer whose attempt changed nothing, with a new Action and resume", async () => {
    const { api } = build();
    const { sessionId, offerId, hash } = await withPauseOffer(api);
    const first = await api.accept(maya(), sessionId, offerId, { shownTextHash: hash }, meta);
    // Still in flight: a second click is the same click.
    expect(await api.accept(maya(), sessionId, offerId, { shownTextHash: hash }, meta)).toEqual(first);

    await payPalMoves(api, first.actionIds[0] ?? "", "PENDING", "FAILED");
    const second = await api.accept(maya(), sessionId, offerId, { shownTextHash: hash }, meta);
    expect(second.actionIds[0]).not.toBe(first.actionIds[0]);
    const keys = await testDb.ownerPool.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM actions WHERE id = $1",
      [second.actionIds[0]],
    );
    expect(keys.rows[0]?.idempotency_key).toBe(`${sessionId}:${offerId}:2`);
    const resumes = await testDb.ownerPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM scheduled_resumes WHERE after_action_id = $1",
      [second.actionIds[0]],
    );
    expect(resumes.rows[0]?.n).toBe(1);

    await payPalMoves(api, second.actionIds[0] ?? "", "PENDING", "FAILED");
    const third = await api.accept(maya(), sessionId, offerId, { shownTextHash: hash }, meta);
    await payPalMoves(api, third.actionIds[0] ?? "", "PENDING", "FAILED");
    await expect(api.accept(maya(), sessionId, offerId, { shownTextHash: hash }, meta)).rejects.toMatchObject(
      {
        code: "offer_unavailable",
      },
    );
  });

  describe("review fixes", () => {
    /** The engine's event for an Action, delivered again without changing anything (at-least-once). */
    const redeliver = (api: DbSessionsApi, actionId: string, type: string, from: string, to: string) =>
      api.onActionStateChanged({
        type: "action.state_changed",
        merchantId: M,
        payload: { actionId, type, from, to, approveUrl: null, error: null },
      } as unknown as DomainEvent<"action.state_changed">);
    const stateOf = async (sessionId: string) =>
      (
        await testDb.ownerPool.query<{ state: string; outcome: string | null }>(
          "SELECT state, outcome FROM sessions WHERE id = $1",
          [sessionId],
        )
      ).rows[0];

    it("ignores a late duplicate from an attempt a retry replaced", async () => {
      const { api } = build();
      const { sessionId, offerId, hash } = await withPauseOffer(api);
      const first = await api.accept(maya(), sessionId, offerId, { shownTextHash: hash }, meta);
      await payPalMoves(api, first.actionIds[0] ?? "", "PENDING", "FAILED");
      await api.accept(maya(), sessionId, offerId, { shownTextHash: hash }, meta);
      expect(await stateOf(sessionId)).toMatchObject({ state: "awaiting_paypal" });

      await redeliver(api, first.actionIds[0] ?? "", "suspend", "EXECUTING", "FAILED");
      expect(await stateOf(sessionId)).toMatchObject({ state: "awaiting_paypal" });
      // So keep is still refused, and can't record "kept" while the retry is being applied.
      await expect(api.keep(maya(), sessionId)).rejects.toMatchObject({ code: "action_in_progress" });
    });

    it("records the save when a cancel that pre-empted it fails, whichever finishes first", async () => {
      // The suspend is already executing at PayPal when the cancel is clicked (a PENDING one would be
      // superseded by the cancel; see the last case), and applies after the cancel failed.
      const { api } = build();
      const a = await withPauseOffer(api);
      const accepted = await api.accept(maya(), a.sessionId, a.offerId, { shownTextHash: a.hash }, meta);
      await payPalMoves(api, accepted.actionIds[0] ?? "", "PENDING", "EXECUTING");
      const cancel = await api.cancel(maya(), a.sessionId, {});
      await payPalMoves(api, cancel.actionId, "PENDING", "FAILED");
      // The suspend is still being applied, so the session keeps waiting on PayPal.
      expect(await stateOf(a.sessionId)).toMatchObject({ state: "awaiting_paypal" });
      await payPalMoves(api, accepted.actionIds[0] ?? "", "EXECUTING", "APPLIED");
      expect(await stateOf(a.sessionId)).toEqual({ state: "closed", outcome: "saved_pause" });

      // The suspend applies while the cancel is in flight, then the cancel fails.
      const b = await withPauseOffer(api);
      const acceptedB = await api.accept(maya(), b.sessionId, b.offerId, { shownTextHash: b.hash }, meta);
      await payPalMoves(api, acceptedB.actionIds[0] ?? "", "PENDING", "EXECUTING");
      const cancelB = await api.cancel(maya(), b.sessionId, {});
      await payPalMoves(api, acceptedB.actionIds[0] ?? "", "EXECUTING", "APPLIED");
      expect(await stateOf(b.sessionId)).toMatchObject({ state: "awaiting_paypal" });
      await payPalMoves(api, cancelB.actionId, "PENDING", "FAILED");
      expect(await stateOf(b.sessionId)).toEqual({ state: "closed", outcome: "saved_pause" });

      // A suspend that hadn't started is superseded by the cancel, so when the cancel fails nothing
      // is pending and the subscriber can cancel again or keep.
      const c = await withPauseOffer(api);
      const acceptedC = await api.accept(maya(), c.sessionId, c.offerId, { shownTextHash: c.hash }, meta);
      const cancelC = await api.cancel(maya(), c.sessionId, {});
      const superseded = await testDb.ownerPool.query<{ state: string }>(
        "SELECT state FROM actions WHERE id = $1",
        [acceptedC.actionIds[0]],
      );
      expect(superseded.rows[0]?.state).toBe("SUPERSEDED");
      await payPalMoves(api, cancelC.actionId, "PENDING", "FAILED");
      expect(await stateOf(c.sessionId)).toEqual({ state: "open", outcome: null });
    });

    it("gives the model the redacted message, never the email or phone number", async () => {
      const said: string[] = [];
      const inner = new AgentRuntime({
        llm: null,
        events: new FakeDomainEvents(),
        audit: new FakeAudit(),
        log: quiet,
      });
      const recording: Agent = {
        start: (s) => inner.start(s),
        respond: (s, text, stream) => {
          said.push(text);
          return inner.respond(s, text, stream);
        },
        respondToReason: (s, r, stream) => inner.respondToReason(s, r, stream),
      };
      const { api } = build({ agent: recording });
      const { sessionId } = await api.create(maya(), { channel: "widget" });
      await api.message(maya(), sessionId, { text: "reach me at maya@example.com or +91 98765 43210" });
      expect(said).toEqual(["reach me at [email] or [phone]"]);
    });

    it("leaves a refund offer open when PayPal can't be reached, and refuses only when the payment isn't there", async () => {
      let mode: "down" | "none" | "found" = "down";
      const { api } = build({
        payments: {
          listTransactions: (_m, _s, range) => {
            if (mode === "down") return Promise.reject(new Error("ECONNRESET"));
            if (mode === "none") return Promise.resolve([]);
            return Promise.resolve([{ id: "CAPTURE-1", status: "COMPLETED", time: range.start }]);
          },
        },
      });
      const offer = await withPauseOffer(api, "quality_issue");
      expect(offer.kind).toBe("refund_partial");

      await expect(
        api.accept(maya(), offer.sessionId, offer.offerId, { shownTextHash: offer.hash }, meta),
      ).rejects.toMatchObject({ code: "internal" });
      const { rows } = await testDb.ownerPool.query<{ status: string }>(
        "SELECT status FROM offers WHERE session_id = $1",
        [offer.sessionId],
      );
      expect(rows[0]?.status).toBe("presented");

      mode = "found";
      const accepted = await api.accept(
        maya(),
        offer.sessionId,
        offer.offerId,
        { shownTextHash: offer.hash },
        meta,
      );
      const action = await testDb.ownerPool.query<{ type: string; params: { transactionId: string } }>(
        "SELECT type, params FROM actions WHERE id = $1",
        [accepted.actionIds[0]],
      );
      expect(action.rows[0]).toMatchObject({ type: "refund", params: { transactionId: "CAPTURE-1" } });

      // A lookup that worked and found nothing is a real refusal.
      mode = "none";
      const other = await withPauseOffer(api, "quality_issue");
      await expect(
        api.accept(maya(), other.sessionId, other.offerId, { shownTextHash: other.hash }, meta),
      ).rejects.toMatchObject({ code: "offer_unavailable" });
    });

    it("calls a session with no stream events quiet, counting from when it started", async () => {
      const { api } = build({ idleMs: 50 });
      const { sessionId } = await api.create(maya(), { channel: "widget" });
      // L1 sessions start with the chips event; remove it to stand in for an L0 session.
      await testDb.ownerPool.query("DELETE FROM session_events WHERE session_id = $1", [sessionId]);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const sub = await api.subscribe(maya(), sessionId, 0, () => undefined);
      sub.unsubscribe();
      expect(sub.idle).toBe(true);
    });

    it("drops the rest of an agent reply once the subscriber has cancelled", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow: Agent = {
        start: (s) =>
          new AgentRuntime({
            llm: null,
            events: new FakeDomainEvents(),
            audit: new FakeAudit(),
            log: quiet,
          }).start(s),
        respond: async (_s, _text, stream) => {
          stream({ type: "agent.delta", text: "Before you go, " });
          await gate;
          stream({ type: "agent.delta", text: "here is a special offer" });
          stream({ type: "agent.done", messageId: "0199a1b2-0000-7000-8000-00000000d0e0" });
        },
        respondToReason: () => Promise.resolve(),
      };
      const { api } = build({ agent: slow });
      const { sessionId } = await api.create(maya(), { channel: "widget" });
      const talking = api.message(maya(), sessionId, { text: "hmm" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await api.cancel(maya(), sessionId, {});
      release();
      await talking;

      const stream = await watch(api, sessionId);
      stream.unsubscribe();
      const deltas = stream.seen.filter(([, e]) => e.type === "agent.delta").map(([, e]) => e);
      expect(deltas).toEqual([{ type: "agent.delta", text: "Before you go, " }]);
      expect(stream.seen.some(([, e]) => e.type === "agent.done")).toBe(true);
    });
  });

  it("lets a cancel pre-empt an offer still being applied", async () => {
    const { api } = build();
    const { sessionId, offerId, hash } = await withPauseOffer(api);
    const { actionIds } = await api.accept(maya(), sessionId, offerId, { shownTextHash: hash }, meta);
    const { actionId: cancelId } = await api.cancel(maya(), sessionId, {});

    await payPalMoves(api, actionIds[0] ?? "", "PENDING", "APPLIED");
    let row = await testDb.ownerPool.query<{ state: string; outcome?: string | null }>(
      "SELECT state FROM sessions WHERE id = $1",
      [sessionId],
    );
    expect(row.rows[0]?.state).toBe("awaiting_paypal");

    await payPalMoves(api, cancelId, "PENDING", "APPLIED");
    row = await testDb.ownerPool.query<{ state: string; outcome?: string | null }>(
      "SELECT state, outcome FROM sessions WHERE id = $1",
      [sessionId],
    );
    expect(row.rows[0]).toEqual({ state: "closed", outcome: "cancelled" });
  });

  it("keeps: closes as kept_without_offer, twice is fine, and nothing else then works", async () => {
    const { api } = build();
    const { sessionId } = await api.create(maya(), { channel: "widget" });
    await api.keep(maya(), sessionId);
    await api.keep(maya(), sessionId);
    await expect(api.message(maya(), sessionId, { text: "hi" })).rejects.toMatchObject({
      code: "session_closed",
    });
  });

  it("hides another subscriber's session, and a made-up id", async () => {
    const { api } = build();
    const { sessionId } = await api.create(maya(), { channel: "widget" });
    const raj = { ...maya(), subscriptionId: otherSubscriptionId };
    for (const call of [
      () => api.cancel(raj, sessionId, {}),
      () => api.message(raj, sessionId, { text: "hi" }),
      () => api.subscribe(raj, sessionId, 0, () => undefined),
      () => api.keep(maya(), "not-a-uuid"),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(SessionError);
      await expect(call()).rejects.toMatchObject({ code: "not_found" });
    }
  });

  it("stops polling once the session closes, so an open tab costs nothing", async () => {
    const { api: reader } = build();
    const { api: writer } = build();
    const { sessionId } = await reader.create(maya(), { channel: "widget" });
    const stream = await watch(reader, sessionId);
    await writer.keep(maya(), sessionId);
    await until(() => stream.seen.some(([, e]) => e.type === "session.closed"));
    const seen = stream.seen.length;
    // Another instance writes after the close (a cancel after keeping): the stopped poll misses it.
    await writer.cancel(maya(), sessionId, {});
    await new Promise((resolve) => setTimeout(resolve, 400));
    stream.unsubscribe();
    expect(stream.seen.length).toBe(seen);
  });

  it("abandons sessions nobody touched, but not one waiting on PayPal or one just used", async () => {
    const { api, events } = build({ abandonAfterMs: 100 });
    const quiet = await api.create(maya(), { channel: "widget" });
    const shown = await withPauseOffer(api);
    const waiting = await withPauseOffer(api);
    await api.accept(maya(), waiting.sessionId, waiting.offerId, { shownTextHash: waiting.hash }, meta);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const fresh = await api.create(maya(), { channel: "widget" });

    expect(await api.abandonIdle()).toBeGreaterThanOrEqual(2);
    const state = async (id: string) =>
      (
        await testDb.ownerPool.query<{ state: string; outcome: string | null }>(
          "SELECT state, outcome FROM sessions WHERE id = $1",
          [id],
        )
      ).rows[0];
    expect(await state(quiet.sessionId)).toEqual({ state: "closed", outcome: "abandoned" });
    expect(await state(shown.sessionId)).toEqual({ state: "closed", outcome: "abandoned" });
    expect(await state(waiting.sessionId)).toEqual({ state: "awaiting_paypal", outcome: null });
    expect(await state(fresh.sessionId)).toEqual({ state: "open", outcome: null });

    const stream = await watch(api, quiet.sessionId);
    stream.unsubscribe();
    expect(stream.seen.at(-1)?.[1]).toMatchObject({ type: "session.closed", outcome: "abandoned" });
    expect(events.emitted.filter((e) => e.type === "session.closed").length).toBeGreaterThanOrEqual(2);
    // Cancel still works on an abandoned session.
    await api.cancel(maya(), quiet.sessionId, {});
  });

  it("calls a quiet session idle, but never one waiting on PayPal", async () => {
    const { api } = build({ idleMs: 50 });
    const { sessionId } = await api.create(maya(), { channel: "widget" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const quiet = await api.subscribe(maya(), sessionId, 99, () => undefined);
    quiet.unsubscribe();
    expect(quiet).toMatchObject({ idle: true, closed: false });

    await api.cancel(maya(), sessionId, {});
    await new Promise((resolve) => setTimeout(resolve, 120));
    const waiting = await api.subscribe(maya(), sessionId, 99, () => undefined);
    waiting.unsubscribe();
    expect(waiting).toMatchObject({ idle: false, closed: false });
  });

  it("delivers events written by another instance, by polling", async () => {
    const { api: reader } = build();
    const { api: writer } = build();
    const { sessionId } = await reader.create(maya(), { channel: "widget" });
    const stream = await watch(reader, sessionId);
    const before = stream.seen.length;
    await writer.keep(maya(), sessionId);
    await until(() => stream.seen.length > before);
    stream.unsubscribe();
    expect(stream.seen.at(-1)?.[1]).toMatchObject({ type: "session.closed", outcome: "kept_without_offer" });
  });

  describe("the subscriber's agent (MCP)", () => {
    const agentOf = (): SubscriberPrincipal => ({ ...maya(), channel: "subscriber_agent" });

    it("lists the policy's offers, reuses the session, and accepts as the agent with consent", async () => {
      const { api, audit } = build();
      const first = await api.agentOptions(agentOf());
      const again = await api.agentOptions(agentOf());
      expect(again.sessionId).toBe(first.sessionId);
      const pause = first.menu.offers.find((o) => o.kind === "pause");
      if (!pause) throw new Error("the policy offers no pause");

      const accepted = await api.agentAccept(agentOf(), pause.id, meta);
      expect(await api.agentAccept(agentOf(), pause.id, meta)).toEqual(accepted);
      const { rows } = await testDb.ownerPool.query<{
        channel: string;
        status: string;
        consent: { channel: string };
      }>(
        "SELECT s.channel, o.status, o.consent FROM sessions s JOIN offers o ON o.session_id = s.id WHERE s.id = $1",
        [first.sessionId],
      );
      expect(rows[0]).toMatchObject({
        channel: "subscriber_agent",
        status: "accepted",
        consent: { channel: "subscriber_agent" },
      });
      expect(audit.entries.find((e) => e.kind === "offer.accepted")?.actor).toBe("subscriber_agent");
    });

    it("needs the options first, and only accepts an offer from them", async () => {
      const { api } = build();
      const raj = { ...agentOf(), subscriptionId: otherSubscriptionId };
      await expect(api.agentAccept(raj, "pause-2", meta)).rejects.toMatchObject({
        code: "offer_unavailable",
      });
      await api.agentOptions(agentOf());
      await expect(api.agentAccept(agentOf(), "made-up-offer", meta)).rejects.toMatchObject({
        code: "offer_unavailable",
      });
    });

    it("cancels in one call with no session before it and the agent disabled", async () => {
      const { api, audit } = build({ agent: disabledAgent });
      const raj = { ...agentOf(), subscriptionId: otherSubscriptionId };
      const { actionId } = await api.agentCancel(raj, { reason: "price" });
      expect(await api.agentCancel(raj, {})).toEqual({ actionId });
      const { rows } = await testDb.ownerPool.query<{ type: string }>(
        "SELECT type FROM actions WHERE id = $1",
        [actionId],
      );
      expect(rows[0]?.type).toBe("cancel");
      expect(audit.entries.find((e) => e.kind === "session.cancel_requested")?.actor).toBe(
        "subscriber_agent",
      );
    });
  });
});
