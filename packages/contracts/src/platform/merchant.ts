import { z } from "zod";
import { Action } from "./actions.js";
import { AuditEntry, AuditKind, AuditVerifyResult } from "./audit.js";
import { DomainEventEnvelope } from "./events.js";
import { Id, IsoDateTime, Money, ReasonCategory } from "../shared.js";
import { OfferKind } from "../brain/offers.js";
import { Session, SessionStreamEvent } from "../surfaces/sessions.js";
import { SubscriptionSnapshot, SubscriptionStatus } from "./subscriptions.js";

// Merchant-facing dashboard API contracts (CONTRACTS.md §4, owner M4).

export const MerchantLoginRequest = z.strictObject({
  email: z.email(),
  /** Optional when the email uniquely identifies a merchant account. */
  merchantSlug: z.string().trim().min(1).max(80).optional(),
  // Passwords are intentionally not trimmed or normalized at the API boundary.
  password: z.string().min(1),
});
export type MerchantLoginRequest = z.infer<typeof MerchantLoginRequest>;

export const MerchantMeResponse = z.object({
  merchant: z.object({ id: Id, slug: z.string().min(1), name: z.string().min(1) }),
  user: z.object({ id: Id, email: z.email(), role: z.enum(["owner", "admin", "viewer"]) }),
  /** Sent in the JSON response, never in a cookie, and required as a header on unsafe requests. */
  csrfToken: z.string().min(32),
});
export type MerchantMeResponse = z.infer<typeof MerchantMeResponse>;

export const MerchantOverviewResponse = z.object({
  from: IsoDateTime,
  to: IsoDateTime,
  mrrSaved: Money,
  saveRate: z.object({ savedSessions: z.number().int().min(0), eligibleSessions: z.number().int().min(0) }),
  recoveredRevenue: Money,
  outcomesByOffer: z.array(z.object({ offer: OfferKind, count: z.number().int().min(0) })),
  outcomesByReason: z.array(z.object({ reason: ReasonCategory, count: z.number().int().min(0) })),
});
export type MerchantOverviewResponse = z.infer<typeof MerchantOverviewResponse>;

export const MerchantOverviewQuery = z
  .strictObject({ from: IsoDateTime, to: IsoDateTime })
  .refine((range) => range.from <= range.to, { message: "from must be before or equal to to" });
export type MerchantOverviewQuery = z.infer<typeof MerchantOverviewQuery>;

export const MerchantRisk = z.object({
  score: z.number().int().min(0).max(100),
  band: z.enum(["low", "medium", "high"]),
});
export type MerchantRisk = z.infer<typeof MerchantRisk>;

export const MerchantSubscriptionListItem = z.object({
  subscription: SubscriptionSnapshot,
  risk: MerchantRisk.nullable(),
});
export type MerchantSubscriptionListItem = z.infer<typeof MerchantSubscriptionListItem>;

export const MerchantSubscriptionListQuery = z.strictObject({
  query: z.string().trim().max(200).optional(),
  status: SubscriptionStatus.optional(),
  risk: MerchantRisk.shape.band.optional(),
  cursor: z.string().min(1).optional(),
});
export type MerchantSubscriptionListQuery = z.infer<typeof MerchantSubscriptionListQuery>;

export const MerchantSubscriptionListResponse = z.object({
  subscriptions: z.array(MerchantSubscriptionListItem),
  nextCursor: z.string().min(1).nullable(),
});
export type MerchantSubscriptionListResponse = z.infer<typeof MerchantSubscriptionListResponse>;

export const MerchantSessionDetail = Session.extend({ events: z.array(SessionStreamEvent) });
export type MerchantSessionDetail = z.infer<typeof MerchantSessionDetail>;

export const MerchantSubscriptionDetailResponse = z.object({
  subscription: SubscriptionSnapshot,
  sessions: z.array(MerchantSessionDetail),
  actions: z.array(Action),
});
export type MerchantSubscriptionDetailResponse = z.infer<typeof MerchantSubscriptionDetailResponse>;

export const MerchantAuditQuery = z.strictObject({
  cursor: z.string().min(1).optional(),
  kind: AuditKind.optional(),
  subject: z.string().trim().min(1).max(200).optional(),
});
export type MerchantAuditQuery = z.infer<typeof MerchantAuditQuery>;

export const MerchantAuditResponse = z.object({
  entries: z.array(AuditEntry),
  nextCursor: z.string().min(1).nullable(),
});
export type MerchantAuditResponse = z.infer<typeof MerchantAuditResponse>;

export const MerchantAuditVerifyResponse = AuditVerifyResult;
export type MerchantAuditVerifyResponse = z.infer<typeof MerchantAuditVerifyResponse>;

/** One JSON payload in the SSE feed. Consumers must handle unknown event types gracefully. */
export const MerchantFeedEvent = DomainEventEnvelope;
export type MerchantFeedEvent = z.infer<typeof MerchantFeedEvent>;

/**
 * POST /v1/m/feed/ticket: where to open the live feed. An absolute URL on the API's own host with a
 * read-only ticket, because a proxy in front of the dashboard (Render's static-site rewrite) can
 * buffer a stream. Use it as is, never log it, and ask again once the stream is refused.
 */
export const MerchantFeedTicketResponse = z.strictObject({
  streamUrl: z.url({ protocol: /^https?$/ }),
  expiresAt: IsoDateTime,
});
export type MerchantFeedTicketResponse = z.infer<typeof MerchantFeedTicketResponse>;

export const MerchantTimelineQuery = z
  .strictObject({
    from: IsoDateTime,
    to: IsoDateTime,
  })
  .refine((range) => range.from <= range.to, { message: "from must be before or equal to to" });
export type MerchantTimelineQuery = z.infer<typeof MerchantTimelineQuery>;

export const MerchantTimelineResponse = z.object({
  resources: z.array(z.object({ id: Id, name: z.string(), subscriptionId: Id })),
  events: z.array(
    z.object({
      id: z.string().min(1),
      resourceId: Id,
      startDate: IsoDateTime,
      endDate: IsoDateTime.nullable(),
      name: z.string(),
      kind: z.string().min(1),
      auditSeq: z.number().int().min(1).nullable(),
      paypalSubscriptionId: z.string().min(1),
      simulated: z.boolean(),
    }),
  ),
});
export type MerchantTimelineResponse = z.infer<typeof MerchantTimelineResponse>;

export const MerchantOnboardingCredentialsRequest = z.strictObject({
  clientId: z.string().trim().min(4).max(256),
  // Never trim, log, or return the secret; PayPal client secrets are opaque values.
  clientSecret: z.string().min(1).max(512),
});
export type MerchantOnboardingCredentialsRequest = z.infer<typeof MerchantOnboardingCredentialsRequest>;

export const MerchantOnboardingCredentialsResponse = z.strictObject({
  verified: z.literal(true),
  clientIdSuffix: z.string().min(4).max(4),
  storedAt: IsoDateTime,
});
export type MerchantOnboardingCredentialsResponse = z.infer<typeof MerchantOnboardingCredentialsResponse>;

export const MerchantOnboardingWebhookResponse = z.object({
  registered: z.literal(true),
  webhookId: z.string().min(1),
});
export type MerchantOnboardingWebhookResponse = z.infer<typeof MerchantOnboardingWebhookResponse>;

export const MerchantOnboardingBackfillResponse = z.object({ jobIds: z.array(Id) });
export type MerchantOnboardingBackfillResponse = z.infer<typeof MerchantOnboardingBackfillResponse>;

export const MerchantApiKeyScope = z.enum([
  "query_metric",
  "search_quotes",
  "compare_cohorts",
  "list_plans",
  "list_at_risk",
  "propose_action",
]);
export type MerchantApiKeyScope = z.infer<typeof MerchantApiKeyScope>;

export const MerchantApiKeySummary = z.object({
  id: Id,
  name: z.string().min(1),
  prefix: z.string().min(1),
  scopes: z.array(MerchantApiKeyScope),
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime.nullable(),
});
export type MerchantApiKeySummary = z.infer<typeof MerchantApiKeySummary>;

export const MerchantApiKeyListResponse = z.object({ keys: z.array(MerchantApiKeySummary) });
export type MerchantApiKeyListResponse = z.infer<typeof MerchantApiKeyListResponse>;

export const MerchantCreateApiKeyRequest = z.strictObject({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(MerchantApiKeyScope).min(1),
});
export type MerchantCreateApiKeyRequest = z.infer<typeof MerchantCreateApiKeyRequest>;

/** The token is returned exactly once at creation and must never be stored by the dashboard. */
export const MerchantCreateApiKeyResponse = z.object({
  key: MerchantApiKeySummary,
  token: z.string().min(1),
});
export type MerchantCreateApiKeyResponse = z.infer<typeof MerchantCreateApiKeyResponse>;
