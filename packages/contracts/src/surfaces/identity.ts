import { z } from "zod";
import { BillingInterval, Id, IsoDateTime, Money } from "../shared.js";
import { SubscriptionStatus } from "../platform/subscriptions.js";

// Who may change which subscription (ARCHITECTURE.md §6.7, owner M3), and Pantry Plan's own small
// "backend", which lives in the API because the demo store is a static site.

const PayPalSubscriptionId = z.string().regex(/^I-[A-Z0-9-]{4,64}$/);

/**
 * The widget token a merchant's backend signs (HS256, with the merchant's Keepwell secret) so the
 * widget can open a session for exactly one subscription. Times are JWT NumericDates (seconds).
 */
export const WidgetTokenClaims = z.object({
  /** Our merchant id. */
  mid: Id,
  /** The PayPal subscription id the token is bound to. */
  sid: PayPalSubscriptionId,
  iat: z.number().int(),
  /** At most 10 minutes after iat. */
  exp: z.number().int(),
  /** Unique per token, so a leaked one can be recognised in logs. */
  nonce: z.string().min(16).max(64),
});
export type WidgetTokenClaims = z.infer<typeof WidgetTokenClaims>;

/** The longest a widget token may live, in seconds. */
export const WIDGET_TOKEN_TTL_SECONDS = 600;

/** POST /v1/demo-store/subscriptions: the PayPal button's onApprove hands over the new subscription. */
export const DemoStoreVerifyRequest = z.object({ paypalSubscriptionId: PayPalSubscriptionId });
export type DemoStoreVerifyRequest = z.infer<typeof DemoStoreVerifyRequest>;

/** Access is granted only after the server's own GET to PayPal says the subscription is live. */
export const DemoStoreVerifyResponse = z.object({
  paypalSubscriptionId: PayPalSubscriptionId,
  status: SubscriptionStatus,
  planName: z.string().min(1),
  /** Pantry Plan's "logged-in shopper": proves the browser went through verification. */
  shopperToken: z.string().min(1),
});
export type DemoStoreVerifyResponse = z.infer<typeof DemoStoreVerifyResponse>;

/** POST /v1/demo-store/token: the account page asks for a fresh widget token. */
export const DemoStoreTokenRequest = z.object({ shopperToken: z.string().min(1) });
export type DemoStoreTokenRequest = z.infer<typeof DemoStoreTokenRequest>;

export const DemoStoreTokenResponse = z.object({ token: z.string().min(1), expiresAt: IsoDateTime });
export type DemoStoreTokenResponse = z.infer<typeof DemoStoreTokenResponse>;

/** What a magic link lives for, and how long the portal session it opens lasts. */
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;
export const PORTAL_SESSION_TTL_SECONDS = 24 * 3600;
/** Delegation tokens expire a week after the subscriber creates them. */
export const DELEGATION_TTL_SECONDS = 7 * 24 * 3600;

/** POST /v1/portal/magic-link. The answer is 202 whether or not the email matches a subscription. */
export const MagicLinkRequest = z.object({
  merchantSlug: z.string().min(1).max(64),
  // Trimmed first: people paste addresses with a stray space.
  email: z.string().trim().pipe(z.email().max(254)),
});
export type MagicLinkRequest = z.infer<typeof MagicLinkRequest>;

/**
 * The portal session cookie: who clicked a magic link. It names the merchant and the hash of the
 * email PayPal holds, not subscription ids, so it covers every subscription that email has.
 */
export const PortalClaims = z.object({
  kind: z.literal("portal"),
  mid: Id,
  /** sha256 of the lower-cased email, the same value as `subscriptions.subscriber_email_hash`. */
  eh: z.string().regex(/^[0-9a-f]{64}$/),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type PortalClaims = z.infer<typeof PortalClaims>;

/** What a subscriber's own agent may do with a delegation token. */
export const DelegationScope = z.enum(["read", "cancel", "accept_offer"]);
export type DelegationScope = z.infer<typeof DelegationScope>;

/** POST /v1/delegations ("Let my assistant manage this"). */
export const CreateDelegationRequest = z.object({
  subscriptionId: Id,
  scopes: z
    .array(DelegationScope)
    .min(1)
    .max(DelegationScope.options.length)
    .refine((scopes) => new Set(scopes).size === scopes.length, "scopes must be unique"),
});
export type CreateDelegationRequest = z.infer<typeof CreateDelegationRequest>;

export const CreateDelegationResponse = z.object({
  id: Id,
  /** Shown once. Only its hash is stored. */
  token: z.string().min(1),
  scopes: z.array(DelegationScope),
  expiresAt: IsoDateTime,
});
export type CreateDelegationResponse = z.infer<typeof CreateDelegationResponse>;

/** One subscription on the portal's list: the subscriber's own data, no email or payer id. */
export const PortalSubscription = z.object({
  id: Id,
  planName: z.string(),
  price: Money,
  interval: BillingInterval,
  status: SubscriptionStatus,
  nextBillingTime: IsoDateTime.nullable(),
});
export type PortalSubscription = z.infer<typeof PortalSubscription>;

/** A delegation as the portal lists it. Never the token: that was shown once, at creation. */
export const DelegationSummary = z.object({
  id: Id,
  subscriptionId: Id,
  scopes: z.array(DelegationScope),
  expiresAt: IsoDateTime,
  createdAt: IsoDateTime,
});
export type DelegationSummary = z.infer<typeof DelegationSummary>;

/** GET /v1/portal/me: what the signed-in subscriber sees. 401 when there is no valid session. */
export const PortalMe = z.object({
  subscriptions: z.array(PortalSubscription),
  /** Only the live ones: not revoked and not expired. */
  delegations: z.array(DelegationSummary),
});
export type PortalMe = z.infer<typeof PortalMe>;

/** POST /v1/portal/token: a token the portal's widget uses to open a session on one subscription. */
export const PortalTokenRequest = z.object({ subscriptionId: Id });
export type PortalTokenRequest = z.infer<typeof PortalTokenRequest>;

export const PortalTokenResponse = z.object({ token: z.string().min(1), expiresAt: IsoDateTime });
export type PortalTokenResponse = z.infer<typeof PortalTokenResponse>;

/**
 * What that token carries (HS256, signed with the portal secret, 10 minutes at most). The sessions
 * API accepts it as the PORTAL channel for exactly this subscription, the way it accepts a widget token.
 */
export const PortalSessionTokenClaims = z.object({
  kind: z.literal("portal_session"),
  mid: Id,
  /** Our subscription id (not PayPal's). */
  sub: Id,
  iat: z.number().int(),
  exp: z.number().int(),
  nonce: z.string().min(16).max(64),
});
export type PortalSessionTokenClaims = z.infer<typeof PortalSessionTokenClaims>;
