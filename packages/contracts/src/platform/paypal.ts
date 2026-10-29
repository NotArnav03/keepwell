import { z } from "zod";
import { SubscriptionStatus } from "./subscriptions.js";

// Raw PayPal shapes, as returned by GET /v1/billing/subscriptions. Only the fields Keepwell reads
// are listed; loose objects keep the rest, because PayPal adds fields without notice. #8 refines
// these against PayPal's OpenAPI spec. Normalising into SubscriptionSnapshot is the gateway's job.

// PayPal sometimes sends offsets instead of "Z", so raw times accept both.
const PayPalTime = z.iso.datetime({ offset: true });
const PayPalMoney = z.looseObject({ currency_code: z.string().length(3), value: z.string() });

export const PayPalSubscription = z.looseObject({
  id: z.string().min(1),
  plan_id: z.string().min(1),
  status: SubscriptionStatus,
  status_update_time: PayPalTime.optional(),
  start_time: PayPalTime.optional(),
  create_time: PayPalTime.optional(),
  update_time: PayPalTime.optional(),
  plan_overridden: z.boolean().optional(),
  subscriber: z
    .looseObject({
      name: z.looseObject({ given_name: z.string().optional(), surname: z.string().optional() }).optional(),
      email_address: z.string().optional(),
      payer_id: z.string().optional(),
    })
    .optional(),
  billing_info: z
    .looseObject({
      outstanding_balance: PayPalMoney.optional(),
      last_payment: z.looseObject({ amount: PayPalMoney, time: PayPalTime }).optional(),
      next_billing_time: PayPalTime.optional(),
      failed_payments_count: z.number().int().min(0).optional(),
      last_failed_payment: z
        .looseObject({
          amount: PayPalMoney.optional(),
          time: PayPalTime,
          reason_code: z.string().optional(),
          next_payment_retry_time: PayPalTime.optional(),
        })
        .optional(),
    })
    .optional(),
  links: z
    .array(z.looseObject({ href: z.string(), rel: z.string(), method: z.string().optional() }))
    .optional(),
});
export type PayPalSubscription = z.infer<typeof PayPalSubscription>;

export interface Page<T> {
  items: T[];
  /** 1-based, like PayPal's `page` parameter. */
  page: number;
  totalItems: number | null;
  totalPages: number | null;
}

export const PayPalErrorKind = z.enum([
  "not_found", // 404
  "unauthorized", // 401/403 after one token refresh
  "rate_limited", // 429
  "unavailable", // network error, timeout or 5xx
  "invalid_request", // 400
  "unprocessable", // 422: a business rule, e.g. SUBSCRIPTION_STATUS_INVALID
]);
export type PayPalErrorKind = z.infer<typeof PayPalErrorKind>;

/** The one error type the gateway throws, so callers can branch on `kind` and `retryable`. */
export class PayPalGatewayError extends Error {
  override readonly name = "PayPalGatewayError";

  constructor(
    readonly kind: PayPalErrorKind,
    message: string,
    readonly details: {
      status: number | null;
      /** PayPal's `issue` code from the error body, e.g. "SUBSCRIPTION_STATUS_INVALID". */
      issue: string | null;
      /** `PayPal-Debug-Id` header: what PayPal support needs. */
      debugId: string | null;
    } = { status: null, issue: null, debugId: null },
  ) {
    super(message);
  }

  /** Worth retrying later; the action engine moves the Action to RETRY_WAIT. */
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "unavailable";
  }
}
