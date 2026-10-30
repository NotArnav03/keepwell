import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { OfferKind, type Offer } from "../brain/offers.js";
import { DomainEventType, parseDomainEventPayload } from "../platform/events.js";
import type { SubscriptionSnapshot } from "../platform/subscriptions.js";
import { Channel } from "../shared.js";
import {
  AcceptOfferRequest,
  AcceptOfferResponse,
  CancelRequest,
  CancelResponse,
  Consent,
  CreateSessionRequest,
  CreateSessionResponse,
  PostMessageRequest,
  PostReasonRequest,
  SAVED_OUTCOME,
  Session,
  SessionError,
  SessionErrorCode,
  SessionOutcome,
  SessionState,
  SessionStreamEvent,
  SubscriptionSummary,
  summarizeSubscription,
} from "./sessions.js";

const MERCHANT = "01972f3e-8c4a-7b1e-9d2a-3f4b5c6d7e8f";
const SUB = "01972f3e-8c4a-7b1e-9d2a-000000000001";
const ACTION = "01972f3e-8c4a-7b1e-9d2a-000000000002";
const SESSION = "01972f3e-8c4a-7b1e-9d2a-000000000003";
const T = "2026-10-29T10:00:00.000Z";
const HASH = "a".repeat(64);
const usd = (value: string) => ({ value, currency: "USD" });

/** parse → JSON → parse gives the same value: the schema survives the wire and the database. */
function roundTrips<S extends z.ZodType>(schema: S, value: unknown): void {
  const once = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
}

const maya: SubscriptionSnapshot = {
  id: SUB,
  merchantId: MERCHANT,
  paypalSubscriptionId: "I-BW452GLLEP1G",
  paypalPlanId: "P-STANDARD",
  planName: "Standard",
  price: usd("12.00"),
  priceOverride: null,
  interval: { unit: "MONTH", count: 1 },
  status: "ACTIVE",
  startedAt: "2026-02-28T09:00:00Z",
  nextBillingTime: "2026-11-28T10:00:00Z",
  lastPayment: { amount: usd("12.00"), time: "2026-10-28T10:00:00Z" },
  outstandingBalance: null,
  failedPaymentsCount: 0,
  lastFailure: null,
  subscriberFirstName: "Maya",
  syncedAt: T,
};

const pause: Offer = { id: "o1", kind: "pause", cycles: 2, resumesOn: "2027-01-15T10:00:00Z" };

const consent = {
  offerHash: HASH,
  shownTextHash: "b".repeat(64),
  at: T,
  channel: "widget",
  ipPrefix: "203.0.113.0/24",
  userAgent: "Mozilla/5.0",
};

const openSession = {
  id: SESSION,
  merchantId: MERCHANT,
  subscriptionId: SUB,
  channel: "widget",
  state: "open",
  fallbackLevel: "L0",
  reason: "unknown",
  presentedOfferId: null,
  policyVersion: 1,
  outcome: null,
  startedAt: T,
  closedAt: null,
  simulated: false,
};

describe("session records", () => {
  it("round-trips a session while open and after it closed", () => {
    roundTrips(Session, openSession);
    roundTrips(Session, {
      ...openSession,
      state: "closed",
      reason: "temporary",
      presentedOfferId: "o1",
      outcome: "saved_pause",
      closedAt: "2026-10-29T10:02:00.000Z",
    });
    expect(SessionState.options).toEqual(["open", "offer_presented", "awaiting_paypal", "closed"]);
  });

  it("rejects an unknown outcome, a PayPal id as our id and a non-UTC time", () => {
    expect(Session.safeParse({ ...openSession, outcome: "saved_forever" }).success).toBe(false);
    expect(Session.safeParse({ ...openSession, subscriptionId: "I-BW452GLLEP1G" }).success).toBe(false);
    expect(Session.safeParse({ ...openSession, startedAt: "2026-10-29T15:30:00+05:30" }).success).toBe(false);
  });

  it("round-trips Consent and rejects a hash that isn't sha256 hex", () => {
    roundTrips(Consent, consent);
    roundTrips(Consent, { ...consent, channel: "subscriber_agent", ipPrefix: null, userAgent: null });
    expect(Consent.safeParse({ ...consent, shownTextHash: "not-a-hash" }).success).toBe(false);
  });

  it("closes every offer kind with its own saved outcome", () => {
    const kinds = OfferKind.options.filter((kind) => kind !== "none");
    expect(Object.keys(SAVED_OUTCOME).sort()).toEqual([...kinds].sort());
    for (const outcome of Object.values(SAVED_OUTCOME)) expect(SessionOutcome.options).toContain(outcome);
  });

  it("summarizes a subscription with the price the subscriber actually pays", () => {
    const summary = summarizeSubscription(maya);
    roundTrips(SubscriptionSummary, summary);
    expect(summary).toEqual({
      paypalSubscriptionId: "I-BW452GLLEP1G",
      planName: "Standard",
      price: usd("12.00"),
      interval: { unit: "MONTH", count: 1 },
      status: "ACTIVE",
      nextBillingTime: "2026-11-28T10:00:00Z",
      subscriberFirstName: "Maya",
    });
    expect(summarizeSubscription({ ...maya, priceOverride: usd("9.00") }).price).toEqual(usd("9.00"));
  });
});

describe("HTTP bodies", () => {
  it("round-trips every request and response", () => {
    roundTrips(CreateSessionRequest, { channel: "widget" });
    roundTrips(CreateSessionRequest, { channel: "portal", locale: "hi-IN" });
    roundTrips(CreateSessionResponse, {
      sessionId: SESSION,
      subscription: summarizeSubscription(maya),
      fallbackLevel: "L0",
      streamUrl: `https://api.keepwell.example/v1/sessions/${SESSION}/stream?ticket=t1`,
      merchant: { name: "Pantry Plan", supportContact: "help@pantryplan.example" },
    });
    roundTrips(PostMessageRequest, { text: "I'm travelling for two months" });
    roundTrips(PostReasonRequest, { reason: "temporary" });
    roundTrips(AcceptOfferRequest, { shownTextHash: HASH });
    roundTrips(AcceptOfferResponse, { actionIds: [ACTION], approveUrl: null });
    roundTrips(AcceptOfferResponse, {
      actionIds: [ACTION],
      approveUrl: "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-1",
    });
    roundTrips(CancelRequest, {});
    roundTrips(CancelRequest, { reason: "price" });
    roundTrips(CancelResponse, { actionId: ACTION });
  });

  it("keeps agents off the HTTP session routes: they use MCP", () => {
    expect(Channel.options).toContain("subscriber_agent");
    expect(CreateSessionRequest.safeParse({ channel: "subscriber_agent" }).success).toBe(false);
  });

  it("trims messages and caps them at 1000 characters", () => {
    expect(PostMessageRequest.parse({ text: "  pause please  " })).toEqual({ text: "pause please" });
    expect(PostMessageRequest.safeParse({ text: "   " }).success).toBe(false);
    expect(PostMessageRequest.safeParse({ text: "x".repeat(1000) }).success).toBe(true);
    expect(PostMessageRequest.safeParse({ text: "x".repeat(1001) }).success).toBe(false);
  });

  it("has no 'unknown' reason chip", () => {
    expect(PostReasonRequest.safeParse({ reason: "unknown" }).success).toBe(false);
  });

  it("only takes http(s) links and at least one Action", () => {
    expect(
      AcceptOfferResponse.safeParse({ actionIds: [ACTION], approveUrl: "javascript:alert(1)" }).success,
    ).toBe(false);
    expect(AcceptOfferResponse.safeParse({ actionIds: [], approveUrl: null }).success).toBe(false);
  });
});

describe("stream events", () => {
  const events = [
    { type: "agent.delta", text: "That makes sense. " },
    { type: "agent.done", messageId: SESSION },
    { type: "offer.presented", offer: pause, cardText: "Pause for 2 billing cycles.", shownTextHash: HASH },
    { type: "reason.chips", reasons: ["price", "temporary"] },
    { type: "fallback.changed", level: "L1" },
    {
      type: "action.update",
      actionId: ACTION,
      actionType: "revise",
      state: "AWAITING_BUYER",
      approveUrl: "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-1",
      error: null,
    },
    {
      type: "action.update",
      actionId: ACTION,
      actionType: "cancel",
      state: "FAILED",
      approveUrl: null,
      error: { code: "UNPROCESSABLE", message: "PayPal refused the change" },
    },
    { type: "session.closed", outcome: "saved_pause", summary: "Your subscription is paused." },
    { type: "error", code: "internal", message: "Something went wrong" },
  ];

  it("round-trips the agent's events and M3's own", () => {
    for (const event of events) roundTrips(SessionStreamEvent, event);
  });

  it("rejects unknown types and broken payloads", () => {
    expect(SessionStreamEvent.safeParse({ type: "offer.retracted" }).success).toBe(false);
    expect(SessionStreamEvent.safeParse({ ...events[5], state: "DONE" }).success).toBe(false);
    expect(SessionStreamEvent.safeParse({ ...events[7], outcome: "saved_forever" }).success).toBe(false);
  });
});

describe("SessionError", () => {
  it("maps every code to an HTTP error status", () => {
    for (const code of SessionErrorCode.options) {
      const status = new SessionError(code, "x").status;
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
    expect(new SessionError("not_found", "No such session")).toMatchObject({
      name: "SessionError",
      code: "not_found",
      message: "No such session",
      status: 404,
    });
    expect(new SessionError("consent_mismatch", "x").status).toBe(409);
    expect(new SessionError("limit_reached", "x").status).toBe(429);
  });
});

describe("domain events", () => {
  it("registers M3's session events", () => {
    expect(DomainEventType.options).toEqual(
      expect.arrayContaining([
        "session.started",
        "session.offer_accepted",
        "session.offer_declined",
        "session.closed",
      ]),
    );
  });

  it("validates their payloads", () => {
    const ids = { sessionId: SESSION, subscriptionId: SUB };
    expect(
      parseDomainEventPayload("session.started", { ...ids, channel: "portal", fallbackLevel: "L1" }),
    ).toEqual({ ...ids, channel: "portal", fallbackLevel: "L1" });
    const accepted = { ...ids, offer: pause, consent, actionIds: [ACTION] };
    expect(parseDomainEventPayload("session.offer_accepted", accepted)).toEqual(accepted);
    expect(parseDomainEventPayload("session.offer_declined", { ...ids, offerId: "o1" })).toEqual({
      ...ids,
      offerId: "o1",
    });
    expect(
      parseDomainEventPayload("session.closed", { ...ids, outcome: "cancelled", reason: "price" }),
    ).toEqual({ ...ids, outcome: "cancelled", reason: "price" });

    expect(() =>
      parseDomainEventPayload("session.offer_accepted", { ...accepted, consent: { ...consent, at: "now" } }),
    ).toThrow();
    expect(() => parseDomainEventPayload("session.offer_accepted", { ...accepted, actionIds: [] })).toThrow();
    expect(() =>
      parseDomainEventPayload("session.closed", { ...ids, outcome: "cancelled", reason: null }),
    ).toThrow();
  });
});
