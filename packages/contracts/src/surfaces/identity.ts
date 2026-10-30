import { z } from "zod";
import { Id, IsoDateTime } from "../shared.js";
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
