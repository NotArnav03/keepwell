import { z } from "zod";
import { BillingInterval, Channel, Id, IsoDateTime, Money, ReasonCategory } from "../shared.js";
import { ActionError, ActionState, ActionType } from "../platform/actions.js";
import { Sha256Hex } from "../platform/audit.js";
import { SubscriptionStatus, type SubscriptionSnapshot } from "../platform/subscriptions.js";
import { AgentStreamEvent, FallbackLevel } from "../brain/agent.js";
import { Offer, OfferId, type OfferKind } from "../brain/offers.js";

// The subscriber-facing sessions API (CONTRACTS.md §4, owner M3): what the widget, the portal and
// the subscriber MCP server talk to. Agent behaviour is M2's (brain/agent.ts); ARCHITECTURE.md §6.5–6.8.

const HttpUrl = z.url({ protocol: /^https?$/ });

export const SessionState = z.enum(["open", "offer_presented", "awaiting_paypal", "closed"]);
export type SessionState = z.infer<typeof SessionState>;

export const SessionOutcome = z.enum([
  "saved_pause",
  "saved_downgrade",
  "saved_annual",
  "saved_discount",
  "saved_refund",
  "cancelled",
  "abandoned",
  "kept_without_offer",
]);
export type SessionOutcome = z.infer<typeof SessionOutcome>;

/** The outcome an accepted offer closes its session with, once PayPal has applied it. */
export const SAVED_OUTCOME = {
  pause: "saved_pause",
  downgrade: "saved_downgrade",
  switch_annual: "saved_annual",
  discount: "saved_discount",
  refund_partial: "saved_refund",
} as const satisfies Record<Exclude<OfferKind, "none">, SessionOutcome>;

/**
 * What the subscriber agreed to, stored with every accepted offer (ARCHITECTURE.md §6.7).
 * offerHash = sha256(canonicalJson(offer)). shownTextHash comes from `offer.presented` and the
 * accept click sends it back, so the record proves which exact text was on screen.
 */
export const Consent = z.object({
  offerHash: Sha256Hex,
  shownTextHash: Sha256Hex,
  at: IsoDateTime,
  channel: Channel,
  /** The IP cut to /24 (IPv4) or /48 (IPv6): enough to spot abuse, not enough to identify anyone. */
  ipPrefix: z.string().max(64).nullable(),
  userAgent: z.string().max(512).nullable(),
});
export type Consent = z.infer<typeof Consent>;

/** What the widget shows about the subscription: the subscriber's own data, no email or payer id. */
export const SubscriptionSummary = z.object({
  paypalSubscriptionId: z.string().min(1),
  planName: z.string(),
  /** What each cycle costs now: the discount override if one is active, else the plan price. */
  price: Money,
  interval: BillingInterval,
  status: SubscriptionStatus,
  nextBillingTime: IsoDateTime.nullable(),
  subscriberFirstName: z.string().nullable(),
});
export type SubscriptionSummary = z.infer<typeof SubscriptionSummary>;

export function summarizeSubscription(snapshot: SubscriptionSnapshot): SubscriptionSummary {
  return {
    paypalSubscriptionId: snapshot.paypalSubscriptionId,
    planName: snapshot.planName,
    price: snapshot.priceOverride ?? snapshot.price,
    interval: snapshot.interval,
    status: snapshot.status,
    nextBillingTime: snapshot.nextBillingTime,
    subscriberFirstName: snapshot.subscriberFirstName,
  };
}

/** A session as stored (`sessions` table) and as the merchant API lists it. */
export const Session = z.object({
  id: Id,
  merchantId: Id,
  subscriptionId: Id,
  channel: Channel,
  state: SessionState,
  fallbackLevel: FallbackLevel,
  /** The latest classified or chip-picked reason; "unknown" until there is one. */
  reason: ReasonCategory,
  /** The one offer shown this session, if any. */
  presentedOfferId: OfferId.nullable(),
  policyVersion: z.number().int().min(1),
  /** null until closed. A cancel after a save reopens the session, so the last outcome wins. */
  outcome: SessionOutcome.nullable(),
  startedAt: IsoDateTime,
  closedAt: IsoDateTime.nullable(),
  simulated: z.boolean(),
});
export type Session = z.infer<typeof Session>;

// ---------- HTTP bodies: /v1/sessions/* ----------

export const CreateSessionRequest = z.object({
  /** Must match the credential: a widget token opens "widget", a portal cookie "portal". Agents use MCP. */
  channel: Channel.exclude(["subscriber_agent"]),
  /** The browser's BCP 47 tag, e.g. "hi-IN": picks card templates before the subscriber types. */
  locale: z.string().min(2).max(35).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const CreateSessionResponse = z.object({
  sessionId: Id,
  subscription: SubscriptionSummary,
  fallbackLevel: FallbackLevel,
  /** Absolute SSE URL. It may carry a short-lived read-only ticket, so use it as is and never log it. */
  streamUrl: HttpUrl,
  merchant: z.object({ name: z.string().min(1), supportContact: z.string().min(1) }),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

export const PostMessageRequest = z.object({ text: z.string().trim().min(1).max(1000) });
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

/** L1: the subscriber tapped a reason chip. */
export const PostReasonRequest = z.object({ reason: ReasonCategory.exclude(["unknown"]) });
export type PostReasonRequest = z.infer<typeof PostReasonRequest>;

export const AcceptOfferRequest = z.object({ shownTextHash: Sha256Hex });
export type AcceptOfferRequest = z.infer<typeof AcceptOfferRequest>;

export const AcceptOfferResponse = z.object({
  actionIds: z.array(Id).min(1),
  /** Downgrade and annual only. Usually null here: PayPal's link arrives later as `action.update`. */
  approveUrl: HttpUrl.nullable(),
});
export type AcceptOfferResponse = z.infer<typeof AcceptOfferResponse>;

export const CancelRequest = z.object({ reason: ReasonCategory.optional() });
export type CancelRequest = z.infer<typeof CancelRequest>;

export const CancelResponse = z.object({ actionId: Id });
export type CancelResponse = z.infer<typeof CancelResponse>;

/**
 * Everything on GET /v1/sessions/:id/stream: the agent's events plus M3's own. Each SSE frame is
 * `id: <seq>` and `data: <one event as JSON>`; seq starts at 1 per session, and a reconnect with
 * Last-Event-ID (or `?after=`) replays what came after it. The stream ends after `session.closed`.
 */
export const SessionStreamEvent = z.discriminatedUnion("type", [
  ...AgentStreamEvent.options,
  z.object({
    type: z.literal("action.update"),
    actionId: Id,
    actionType: ActionType,
    state: ActionState,
    approveUrl: HttpUrl.nullable(),
    error: ActionError.nullable(),
  }),
  z.object({
    type: z.literal("session.closed"),
    outcome: SessionOutcome,
    /** Rendered from templates and the offer object, never by the model. */
    summary: z.string(),
  }),
  /** `code` stays a string so an older widget can still show an error code it doesn't know. */
  z.object({ type: z.literal("error"), code: z.string().min(1), message: z.string() }),
]);
export type SessionStreamEvent = z.infer<typeof SessionStreamEvent>;

// ---------- errors ----------

export const SessionErrorCode = z.enum([
  "unauthorized",
  "not_found",
  "invalid_request",
  "session_closed",
  /** Not the offer this session showed, or it was already answered. */
  "offer_unavailable",
  /** The accept click's shownTextHash isn't the text we showed. */
  "consent_mismatch",
  /** Message limit for the session, or a rate limit. */
  "limit_reached",
  /** An accepted offer or a cancel is still being applied in PayPal. */
  "action_in_progress",
  "internal",
]);
export type SessionErrorCode = z.infer<typeof SessionErrorCode>;

const HTTP_STATUS: Record<SessionErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  invalid_request: 400,
  session_closed: 409,
  offer_unavailable: 409,
  consent_mismatch: 409,
  limit_reached: 429,
  action_in_progress: 409,
  internal: 500,
};

/** What SessionsApi implementations throw; the HTTP layer turns it into an ErrorEnvelope. */
export class SessionError extends Error {
  override readonly name = "SessionError";

  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}

// ---------- the module seam ----------

/** Who is calling, resolved from the credential (widget token, portal cookie or delegation). */
export interface SubscriberPrincipal {
  merchantId: string;
  /** Our subscription id (not PayPal's): every credential is bound to exactly one. */
  subscriptionId: string;
  channel: Channel;
}

/** Request facts that go into the consent record. */
export interface RequestMeta {
  ipPrefix: string | null;
  userAgent: string | null;
}

export type SessionStreamListener = (seq: number, event: SessionStreamEvent) => void;

/**
 * The sessions API without HTTP: the routes, the subscriber MCP server and FakeSessionsApi share it.
 * Every method is scoped to the principal: someone else's session is `not_found`.
 */
export interface SessionsApi {
  create(principal: SubscriberPrincipal, body: CreateSessionRequest): Promise<CreateSessionResponse>;
  /**
   * Replays the events after `afterSeq` (0 for all), then delivers new ones until unsubscribed.
   * `closed` says the session had already ended when the replay finished.
   */
  subscribe(
    principal: SubscriberPrincipal,
    sessionId: string,
    afterSeq: number,
    listener: SessionStreamListener,
  ): Promise<{ unsubscribe: () => void; closed: boolean }>;
  /** Resolves once the message is accepted; the reply arrives on the stream. */
  message(principal: SubscriberPrincipal, sessionId: string, body: PostMessageRequest): Promise<void>;
  reason(principal: SubscriberPrincipal, sessionId: string, body: PostReasonRequest): Promise<void>;
  /**
   * Idempotent: a second click on the same offer returns the first click's Actions. Before any
   * Action is created, re-run `evaluate(policy, freshContext, offerId, storedMenu)` with
   * `offersPresentedThisSession: 0` (the offer being accepted is the one that was presented);
   * a refusal is `offer_unavailable`. A pause's resume is scheduled only once its suspend applies.
   */
  accept(
    principal: SubscriberPrincipal,
    sessionId: string,
    offerId: string,
    body: AcceptOfferRequest,
    meta: RequestMeta,
  ): Promise<AcceptOfferResponse>;
  decline(principal: SubscriberPrincipal, sessionId: string, offerId: string): Promise<void>;
  /** "Keep my subscription": closes the session as kept_without_offer. */
  keep(principal: SubscriberPrincipal, sessionId: string): Promise<void>;
  /** Works in every state, including after a save. Never touches the agent or any LLM (design law 1). */
  cancel(principal: SubscriberPrincipal, sessionId: string, body: CancelRequest): Promise<CancelResponse>;
}

/** Domain events M3 produces (CONTRACTS.md §2); spread into domainEventPayloads. */
export const surfacesEventPayloads = {
  "session.started": z.object({
    sessionId: Id,
    subscriptionId: Id,
    channel: Channel,
    fallbackLevel: FallbackLevel,
  }),
  "session.offer_accepted": z.object({
    sessionId: Id,
    subscriptionId: Id,
    offer: Offer,
    consent: Consent,
    actionIds: z.array(Id).min(1),
  }),
  "session.offer_declined": z.object({ sessionId: Id, subscriptionId: Id, offerId: OfferId }),
  "session.closed": z.object({
    sessionId: Id,
    subscriptionId: Id,
    outcome: SessionOutcome,
    reason: ReasonCategory,
  }),
} as const;
