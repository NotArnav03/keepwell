import { z } from "zod";
import { BillingInterval, Id, IsoDateTime, Money } from "../shared.js";

export const SubscriptionStatus = z.enum([
  "APPROVAL_PENDING",
  "APPROVED",
  "ACTIVE",
  "SUSPENDED",
  "CANCELLED",
  "EXPIRED",
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

// Our read model of a PayPal subscription, rebuilt from a GET after every webhook or sweep.
// Everything outside M1 reads subscriptions through this, never through raw PayPal JSON.
export const SubscriptionSnapshot = z.object({
  id: Id,
  merchantId: Id,
  paypalSubscriptionId: z.string().min(1),
  paypalPlanId: z.string().min(1),
  planName: z.string(),
  /** The plan's list price. */
  price: Money,
  /** A discount offer's `fixed_price` override; null when the subscriber pays the plan price. */
  priceOverride: Money.nullable(),
  interval: BillingInterval,
  status: SubscriptionStatus,
  startedAt: IsoDateTime,
  nextBillingTime: IsoDateTime.nullable(),
  lastPayment: z.object({ amount: Money, time: IsoDateTime }).nullable(),
  outstandingBalance: Money.nullable(),
  failedPaymentsCount: z.number().int().min(0),
  lastFailure: z
    .object({ reasonCode: z.string(), time: IsoDateTime, nextRetryTime: IsoDateTime.nullable() })
    .nullable(),
  subscriberFirstName: z.string().nullable(),
  syncedAt: IsoDateTime,
});
export type SubscriptionSnapshot = z.infer<typeof SubscriptionSnapshot>;
