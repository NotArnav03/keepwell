import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../canonical-json.js";
import { ReasonCategory } from "../shared.js";
import type { Agent } from "../brain/agent.js";
import type { Offer, OfferMenu } from "../brain/offers.js";
import {
  SessionError,
  type PostReasonRequest,
  type SessionStreamEvent,
  type SubscriberPrincipal,
} from "../surfaces/sessions.js";
import { FakeAgent } from "./agent.js";
import { PANTRY_PLAN, pantryPlanSubscription } from "./pantry-plan.js";
import { FakeSessionsApi, type FakeSessionsApiOptions } from "./sessions.js";

const T = "2026-10-29T10:00:00.000Z";
const clock = () => new Date(T);
const maya = pantryPlanSubscription(clock());
const other = pantryPlanSubscription(clock(), {
  id: "0199a1b2-c3d4-7e5f-8a6b-000000000002",
  paypalSubscriptionId: "I-FAKEOTHER0002",
  subscriberFirstName: "Leo",
});
const principal: SubscriberPrincipal = {
  merchantId: PANTRY_PLAN.merchantId,
  subscriptionId: maya.id,
  channel: "widget",
};
const meta = { ipPrefix: "203.0.113.0/24", userAgent: "vitest" };
const usd = (value: string) => ({ value, currency: "USD" });

type Streamed = { seq: number; event: SessionStreamEvent };

function menuOf(offers: Offer[], defaults: Partial<Record<ReasonCategory, string>> = {}): OfferMenu {
  return {
    policyVersion: 1,
    computedAt: T,
    offers,
    defaultByReason: Object.fromEntries(
      ReasonCategory.options.map((r) => [r, defaults[r] ?? null]),
    ) as Record<ReasonCategory, string | null>,
    excluded: [],
  };
}

const downgrade: Offer = {
  id: "offer-downgrade",
  kind: "downgrade",
  toPlanId: PANTRY_PLAN.lite.planId,
  toPlanName: "Lite",
  newPrice: usd("6.00"),
};

/** Opens a widget session for Maya and collects everything its stream carries. */
async function open(api: FakeSessionsApi) {
  const created = await api.create(principal, { channel: "widget" });
  const streamed: Streamed[] = [];
  await api.subscribe(principal, created.sessionId, 0, (seq, event) => streamed.push({ seq, event }));
  const types = () => streamed.map((s) => s.event.type);
  return { created, sessionId: created.sessionId, streamed, types };
}

function presentedOffer(streamed: Streamed[]) {
  for (const { event } of streamed) if (event.type === "offer.presented") return event;
  throw new Error("No offer was presented");
}

function lastClosed(streamed: Streamed[]) {
  const closed = streamed.filter((s) => s.event.type === "session.closed").at(-1)?.event;
  if (closed?.type !== "session.closed") throw new Error("The session never closed");
  return closed;
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(SessionError);
  await expect(promise).rejects.toMatchObject({ code });
}

const make = (options: FakeSessionsApiOptions = {}) =>
  new FakeSessionsApi({ clock, subscriptions: [maya, other], ...options });

describe("FakeSessionsApi: Maya pauses", () => {
  it("opens a session, audits it and tells the dashboard", async () => {
    const api = make();
    const { created, sessionId } = await open(api);

    expect(created).toMatchObject({
      fallbackLevel: "L0",
      subscription: { planName: "Standard", price: usd("12.00"), subscriberFirstName: "Maya" },
      merchant: { name: "Pantry Plan", supportContact: "help@pantryplan.example" },
    });
    expect(created.streamUrl).toContain(sessionId);
    expect(api.get(sessionId)).toMatchObject({ state: "open", reason: "unknown", outcome: null });
    expect(api.events.ofType("session.started")[0]?.payload).toEqual({
      sessionId,
      subscriptionId: maya.id,
      channel: "widget",
      fallbackLevel: "L0",
    });
    expect(api.audit.byKind("session.started")).toHaveLength(1);
  });

  it("streams the reply and one offer card, then records the offer", async () => {
    const api = make();
    const { sessionId, streamed, types } = await open(api);
    await api.message(principal, sessionId, { text: "I'm travelling for about two months" });

    expect(types()).toContain("agent.delta");
    expect(types().slice(-2)).toEqual(["offer.presented", "agent.done"]);
    expect(streamed.map((s) => s.seq)).toEqual(streamed.map((_, i) => i + 1));
    expect(presentedOffer(streamed).offer.kind).toBe("pause");
    expect(api.get(sessionId)).toMatchObject({ state: "offer_presented" });
    expect(api.events.ofType("session.offer_presented")).toHaveLength(1);
    expect(api.audit.byKind("offer.presented")).toHaveLength(1);
  });

  it("accept suspends, schedules the resume and closes the session once PayPal applies it", async () => {
    const api = make();
    const { sessionId, streamed } = await open(api);
    await api.message(principal, sessionId, { text: "Away for a while" });
    const { offer, shownTextHash } = presentedOffer(streamed);
    if (offer.kind !== "pause") throw new Error("expected a pause");

    const accepted = await api.accept(principal, sessionId, offer.id, { shownTextHash }, meta);
    const [actionId] = accepted.actionIds;
    if (actionId === undefined) throw new Error("expected an Action");
    expect(accepted.approveUrl).toBeNull();
    expect(api.actions.actions).toMatchObject([
      { id: actionId, type: "suspend", state: "PENDING", origin: "session" },
    ]);
    expect(api.actions.resumes).toMatchObject([{ subscriptionId: maya.id, dueAt: offer.resumesOn }]);
    expect(api.get(sessionId)).toMatchObject({ state: "awaiting_paypal" });

    const consent = api.events.ofType("session.offer_accepted")[0]?.payload.consent;
    expect(consent).toEqual({
      offerHash: createHash("sha256").update(canonicalJson(offer)).digest("hex"),
      shownTextHash,
      at: T,
      channel: "widget",
      ...meta,
    });

    await api.actions.transition(actionId, "EXECUTING");
    await api.actions.transition(actionId, "APPLIED");
    const updates = streamed.flatMap((s) => (s.event.type === "action.update" ? [s.event.state] : []));
    expect(updates).toEqual(["PENDING", "EXECUTING", "APPLIED"]);
    expect(lastClosed(streamed)).toEqual({
      type: "session.closed",
      outcome: "saved_pause",
      summary: `Your subscription is paused. Billing restarts on ${offer.resumesOn.slice(0, 10)}.`,
    });
    expect(api.get(sessionId)).toMatchObject({ state: "closed", outcome: "saved_pause", closedAt: T });
    expect(api.events.ofType("session.closed")[0]?.payload).toMatchObject({ outcome: "saved_pause" });

    // A late webhook confirmation still reaches the stream, after the close.
    await api.actions.transition(actionId, "CONFIRMED");
    expect(streamed.at(-1)?.event).toMatchObject({ type: "action.update", state: "CONFIRMED" });
    expect(api.audit.verify(PANTRY_PLAN.merchantId)).toMatchObject({ ok: true });
  });

  it("treats a double-click on Accept as one click", async () => {
    const api = make();
    const { sessionId, streamed } = await open(api);
    await api.message(principal, sessionId, { text: "Away for a while" });
    const { offer, shownTextHash } = presentedOffer(streamed);

    const first = await api.accept(principal, sessionId, offer.id, { shownTextHash }, meta);
    const second = await api.accept(principal, sessionId, offer.id, { shownTextHash }, meta);
    expect(second).toEqual(first);
    expect(api.actions.actions).toHaveLength(1);
  });
});

describe("FakeSessionsApi: consent and the one-offer rule", () => {
  it("refuses consent that doesn't match the text shown", async () => {
    const api = make();
    const { sessionId, streamed } = await open(api);
    await api.message(principal, sessionId, { text: "Away for a while" });
    const { offer } = presentedOffer(streamed);

    await rejectsWith(
      api.accept(principal, sessionId, offer.id, { shownTextHash: "f".repeat(64) }, meta),
      "consent_mismatch",
    );
    expect(api.actions.actions).toHaveLength(0);
  });

  it("refuses an offer that wasn't shown", async () => {
    const api = make();
    const { sessionId, streamed } = await open(api);
    const hash = { shownTextHash: "a".repeat(64) };
    await rejectsWith(api.accept(principal, sessionId, "offer-pause-1", hash, meta), "offer_unavailable");

    await api.message(principal, sessionId, { text: "Away for a while" });
    const { shownTextHash } = presentedOffer(streamed);
    await rejectsWith(
      api.accept(principal, sessionId, "offer-made-up", { shownTextHash }, meta),
      "offer_unavailable",
    );
  });

  it("after a decline there is no second offer, and the declined one can't be accepted", async () => {
    const api = make();
    const { sessionId, streamed } = await open(api);
    await api.message(principal, sessionId, { text: "Away for a while" });
    const { offer, shownTextHash } = presentedOffer(streamed);

    await api.decline(principal, sessionId, offer.id);
    await api.decline(principal, sessionId, offer.id);
    expect(api.events.ofType("session.offer_declined")).toHaveLength(1);
    expect(api.get(sessionId)).toMatchObject({ state: "open", presentedOfferId: offer.id });

    await api.message(principal, sessionId, { text: "Hmm, are you sure there's nothing else?" });
    expect(streamed.filter((s) => s.event.type === "offer.presented")).toHaveLength(1);
    await rejectsWith(
      api.accept(principal, sessionId, offer.id, { shownTextHash }, meta),
      "offer_unavailable",
    );
  });

  it("never forwards a second offer, even from an agent that tries", async () => {
    const pause: Offer = { id: "p", kind: "pause", cycles: 1, resumesOn: "2026-12-28T10:00:00.000Z" };
    const pushy = new FakeAgent({ clock });
    const agent: Agent = {
      start: (session) => pushy.start(session),
      // Ignores presentedOfferId and offers again on every message.
      respond: (session, text, stream) => pushy.respond({ ...session, presentedOfferId: null }, text, stream),
      respondToReason: (session, reason, stream) => pushy.respondToReason(session, reason, stream),
    };
    const api = make({ agent, scripts: { [maya.id]: { menu: menuOf([pause]) } } });
    const { sessionId, streamed } = await open(api);
    await api.message(principal, sessionId, { text: "one" });
    await api.message(principal, sessionId, { text: "two" });
    expect(streamed.filter((s) => s.event.type === "offer.presented")).toHaveLength(1);
  });

  it("allows three messages per session", async () => {
    const api = make();
    const { sessionId } = await open(api);
    for (const text of ["one", "two", "three"]) await api.message(principal, sessionId, { text });
    await rejectsWith(api.message(principal, sessionId, { text: "four" }), "limit_reached");
  });

  it("validates bodies the way the HTTP layer does", async () => {
    const api = make();
    const { sessionId } = await open(api);
    await rejectsWith(api.message(principal, sessionId, { text: "   " }), "invalid_request");
    // "unknown" is not a chip; the cast gets it past the type so the runtime guard is what's tested.
    const notAChip: unknown = { reason: "unknown" };
    await rejectsWith(api.reason(principal, sessionId, notAChip as PostReasonRequest), "invalid_request");
  });
});

describe("FakeSessionsApi: cancel", () => {
  it("never calls the agent, so it works with the AI down", async () => {
    const real = new FakeAgent({ clock });
    let aiDown = false;
    const down = () => Promise.reject(new Error("Anthropic API unavailable"));
    const agent: Agent = {
      start: (session) => (aiDown ? down() : real.start(session)),
      respond: (session, text, stream) => (aiDown ? down() : real.respond(session, text, stream)),
      respondToReason: (session, reason, stream) =>
        aiDown ? down() : real.respondToReason(session, reason, stream),
    };
    const api = make({ agent });
    const { sessionId, streamed } = await open(api);
    aiDown = true;
    const callsBefore = real.calls.length;

    const { actionId } = await api.cancel(principal, sessionId, { reason: "price" });
    await api.actions.transition(actionId, "EXECUTING");
    await api.actions.transition(actionId, "APPLIED");

    expect(real.calls).toHaveLength(callsBefore);
    expect(api.actions.actions).toMatchObject([{ id: actionId, type: "cancel" }]);
    expect(lastClosed(streamed)).toMatchObject({ outcome: "cancelled" });
    expect(api.events.ofType("session.closed")[0]?.payload).toMatchObject({
      outcome: "cancelled",
      reason: "price",
    });
  });

  it("returns the same Action for a double click, and retries only a failed one", async () => {
    const api = make();
    const { sessionId, streamed } = await open(api);
    const first = await api.cancel(principal, sessionId, {});
    expect(await api.cancel(principal, sessionId, {})).toEqual(first);

    await api.actions.transition(first.actionId, "EXECUTING");
    await api.actions.transition(first.actionId, "FAILED", {
      error: { code: "UNPROCESSABLE", message: "PayPal refused the change" },
    });
    expect(streamed.at(-1)?.event).toMatchObject({
      type: "action.update",
      state: "FAILED",
      error: { code: "UNPROCESSABLE" },
    });
    expect(api.get(sessionId)).toMatchObject({ state: "open" });

    const retry = await api.cancel(principal, sessionId, {});
    expect(retry.actionId).not.toBe(first.actionId);
  });

  it("pre-empts an offer still waiting to be applied", async () => {
    const api = make();
    const { sessionId, streamed } = await open(api);
    await api.message(principal, sessionId, { text: "Away for a while" });
    const { offer, shownTextHash } = presentedOffer(streamed);
    const { actionIds } = await api.accept(principal, sessionId, offer.id, { shownTextHash }, meta);

    const { actionId } = await api.cancel(principal, sessionId, {});
    expect(api.actions.actions.find((a) => a.id === actionIds[0])?.state).toBe("SUPERSEDED");
    await api.actions.transition(actionId, "EXECUTING");
    await api.actions.transition(actionId, "APPLIED");
    expect(lastClosed(streamed)).toMatchObject({ outcome: "cancelled" });
  });

  it("still works after a save: the session reopens and ends cancelled", async () => {
    const api = make();
    const { sessionId, streamed } = await open(api);
    await api.message(principal, sessionId, { text: "Away for a while" });
    const { offer, shownTextHash } = presentedOffer(streamed);
    const [suspendId] = (await api.accept(principal, sessionId, offer.id, { shownTextHash }, meta)).actionIds;
    if (suspendId === undefined) throw new Error("expected an Action");
    await api.actions.transition(suspendId, "EXECUTING");
    await api.actions.transition(suspendId, "APPLIED");
    expect(api.get(sessionId)).toMatchObject({ outcome: "saved_pause" });

    const { actionId } = await api.cancel(principal, sessionId, {});
    expect(api.get(sessionId)).toMatchObject({ state: "awaiting_paypal", outcome: null, closedAt: null });
    await api.actions.transition(actionId, "EXECUTING");
    await api.actions.transition(actionId, "APPLIED");
    expect(api.get(sessionId)).toMatchObject({ state: "closed", outcome: "cancelled" });
    expect(api.events.ofType("session.closed").map((e) => e.payload.outcome)).toEqual([
      "saved_pause",
      "cancelled",
    ]);
  });
});

describe("FakeSessionsApi: keep, replay and scoping", () => {
  it("keep closes the session without a change", async () => {
    const api = make();
    const { sessionId, streamed } = await open(api);
    await api.keep(principal, sessionId);
    await api.keep(principal, sessionId);

    expect(lastClosed(streamed)).toMatchObject({ outcome: "kept_without_offer" });
    expect(api.events.ofType("session.closed")).toHaveLength(1);
    expect(api.actions.actions).toHaveLength(0);
    await rejectsWith(api.message(principal, sessionId, { text: "hello?" }), "session_closed");
  });

  it("replays what came after Last-Event-ID, then streams live until unsubscribed", async () => {
    const api = make();
    const { sessionId, streamed } = await open(api);
    await api.message(principal, sessionId, { text: "Away for a while" });
    const lastSeen = 3;

    const replayed: Streamed[] = [];
    const sub = await api.subscribe(principal, sessionId, lastSeen, (seq, event) =>
      replayed.push({ seq, event }),
    );
    expect(sub.closed).toBe(false);
    expect(replayed).toEqual(streamed.filter((s) => s.seq > lastSeen));

    await api.message(principal, sessionId, { text: "Still thinking" });
    expect(replayed).toEqual(streamed.filter((s) => s.seq > lastSeen));

    sub.unsubscribe();
    await api.keep(principal, sessionId);
    expect(streamed.at(-1)?.event.type).toBe("session.closed");
    expect(replayed.some((s) => s.event.type === "session.closed")).toBe(false);

    const late = await api.subscribe(principal, sessionId, streamed.length, () => undefined);
    expect(late.closed).toBe(true);
  });

  it("hides one subscriber's session from another", async () => {
    const api = make();
    const { sessionId } = await open(api);
    const leo = { ...principal, subscriptionId: other.id };

    await rejectsWith(
      api.subscribe(leo, sessionId, 0, () => undefined),
      "not_found",
    );
    await rejectsWith(api.message(leo, sessionId, { text: "hi" }), "not_found");
    await rejectsWith(api.cancel(leo, sessionId, {}), "not_found");
    expect(api.actions.actions).toHaveLength(0);
  });

  it("refuses an unknown subscription or a channel the credential doesn't grant", async () => {
    const api = make();
    await rejectsWith(
      api.create(
        { ...principal, subscriptionId: "0199a1b2-c3d4-7e5f-8a6b-0000000000ff" },
        { channel: "widget" },
      ),
      "unauthorized",
    );
    await rejectsWith(api.create(principal, { channel: "portal" }), "unauthorized");
  });
});

describe("FakeSessionsApi: scripts", () => {
  it("L1 shows reason chips, and a chip shows that reason's default offer", async () => {
    const api = make({
      scripts: { [maya.id]: { fallbackLevel: "L1", menu: menuOf([downgrade], { price: downgrade.id }) } },
    });
    const { created, sessionId, streamed } = await open(api);
    expect(created.fallbackLevel).toBe("L1");
    expect(streamed[0]?.event).toEqual({
      type: "reason.chips",
      reasons: ReasonCategory.options.filter((r) => r !== "unknown"),
    });

    await api.reason(principal, sessionId, { reason: "price" });
    expect(api.get(sessionId)).toMatchObject({ reason: "price", state: "offer_presented" });
    expect(presentedOffer(streamed).offer).toEqual(downgrade);
  });

  it("a downgrade waits for PayPal's approval link", async () => {
    const api = make({ scripts: { [maya.id]: { menu: menuOf([downgrade]) } } });
    const { sessionId, streamed } = await open(api);
    await api.message(principal, sessionId, { text: "It's too expensive right now" });
    const { shownTextHash } = presentedOffer(streamed);
    const [actionId] = (await api.accept(principal, sessionId, downgrade.id, { shownTextHash }, meta))
      .actionIds;
    if (actionId === undefined) throw new Error("expected an Action");
    expect(api.actions.actions).toMatchObject([
      { type: "revise", params: { planId: PANTRY_PLAN.lite.planId } },
    ]);

    const approveUrl = "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-1";
    await api.actions.transition(actionId, "EXECUTING");
    await api.actions.transition(actionId, "AWAITING_BUYER", { approveUrl });
    expect(streamed.at(-1)?.event).toMatchObject({
      type: "action.update",
      state: "AWAITING_BUYER",
      approveUrl,
    });
    expect(api.get(sessionId)).toMatchObject({ state: "awaiting_paypal" });

    await api.actions.transition(actionId, "APPLIED");
    expect(lastClosed(streamed)).toEqual({
      type: "session.closed",
      outcome: "saved_downgrade",
      summary: "You're now on Lite at 6.00 USD.",
    });
  });

  it("an abandoned approval leaves the session open for cancel or keep", async () => {
    const api = make({ scripts: { [maya.id]: { menu: menuOf([downgrade]) } } });
    const { sessionId, streamed } = await open(api);
    await api.message(principal, sessionId, { text: "Too expensive" });
    const { shownTextHash } = presentedOffer(streamed);
    const [actionId] = (await api.accept(principal, sessionId, downgrade.id, { shownTextHash }, meta))
      .actionIds;
    if (actionId === undefined) throw new Error("expected an Action");
    await api.actions.transition(actionId, "EXECUTING");
    await api.actions.transition(actionId, "AWAITING_BUYER", { approveUrl: "https://example.com/approve" });
    await api.actions.transition(actionId, "ABANDONED");

    expect(api.get(sessionId)).toMatchObject({ state: "open", outcome: null });
    await api.keep(principal, sessionId);
    expect(lastClosed(streamed)).toMatchObject({ outcome: "kept_without_offer" });
  });

  it("creates the right Action for every other offer kind", async () => {
    const cases: { offer: Offer; expected: object }[] = [
      {
        offer: {
          id: "a",
          kind: "switch_annual",
          toPlanId: PANTRY_PLAN.annual.planId,
          newPrice: usd("120.00"),
          effectiveMonthly: usd("10.00"),
        },
        expected: { type: "revise", params: { planId: PANTRY_PLAN.annual.planId } },
      },
      {
        offer: {
          id: "d",
          kind: "discount",
          percent: 25,
          cycles: 3,
          newPrice: usd("9.00"),
          firstAffectedBilling: maya.nextBillingTime ?? T,
        },
        expected: { type: "patch_price", params: { fixedPrice: usd("9.00") } },
      },
      {
        offer: { id: "r", kind: "refund_partial", amount: usd("6.00"), ofPaymentOn: T },
        expected: { type: "refund", params: { amount: usd("6.00") } },
      },
    ];
    for (const { offer, expected } of cases) {
      const api = make({ scripts: { [maya.id]: { menu: menuOf([offer]) } } });
      const { sessionId, streamed } = await open(api);
      await api.message(principal, sessionId, { text: "hi" });
      const { shownTextHash } = presentedOffer(streamed);
      await api.accept(principal, sessionId, offer.id, { shownTextHash }, meta);
      expect(api.actions.actions).toMatchObject([expected]);
    }
  });
});
