import { z } from "zod";
import { Id, IsoDateTime, Money } from "../shared.js";

// Template payloads carry only facts (amounts, dates, links). Haiku may personalise the
// wording around them, but the facts are always rendered from these fields.

const FirstName = z.string().max(80).nullable();

export const DunningUpdatePaymentMethodPayload = z.object({
  firstName: FirstName,
  planName: z.string(),
  amount: Money,
  retryAt: IsoDateTime.nullable(),
  updatePaymentUrl: z.url(),
});

export const DunningAccountRestrictedPayload = z.object({
  firstName: FirstName,
  planName: z.string(),
  amount: Money,
  resolutionUrl: z.url(),
});

export const DunningSendingLimitPayload = z.object({
  firstName: FirstName,
  planName: z.string(),
  amount: Money,
  retryAt: IsoDateTime.nullable(),
  // Only set when the merchant's policy allows a downgrade.
  smallerPlan: z.object({ name: z.string(), price: Money }).nullable(),
});

export const DunningGenericPayload = z.object({
  firstName: FirstName,
  planName: z.string(),
  amount: Money,
  retryAt: IsoDateTime.nullable(),
  helpUrl: z.url(),
});

export const DunningReactivatePayload = z.object({
  firstName: FirstName,
  planName: z.string(),
  portalUrl: z.url(),
});

export const WinbackAskPayload = z.object({
  firstName: FirstName,
  planName: z.string(),
  replyUrl: z.url(),
  // Only set when the policy allows inviting the subscriber back.
  resubscribeUrl: z.url().nullable(),
});

export const NotificationContent = z.discriminatedUnion("template", [
  z.object({
    template: z.literal("dunning.update_payment_method"),
    payload: DunningUpdatePaymentMethodPayload,
  }),
  z.object({
    template: z.literal("dunning.account_restricted"),
    payload: DunningAccountRestrictedPayload,
  }),
  z.object({ template: z.literal("dunning.sending_limit"), payload: DunningSendingLimitPayload }),
  z.object({ template: z.literal("dunning.generic"), payload: DunningGenericPayload }),
  z.object({ template: z.literal("dunning.reactivate"), payload: DunningReactivatePayload }),
  z.object({ template: z.literal("winback.ask"), payload: WinbackAskPayload }),
]);
export type NotificationContent = z.infer<typeof NotificationContent>;

export const TemplateId = z.enum([
  "dunning.update_payment_method",
  "dunning.account_restricted",
  "dunning.sending_limit",
  "dunning.generic",
  "dunning.reactivate",
  "winback.ask",
]);
export type TemplateId = z.infer<typeof TemplateId>;

export type TemplatePayload<T extends TemplateId> = Extract<NotificationContent, { template: T }>["payload"];

export const NotificationChannel = z.enum(["email"]);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

// What business code hands to Notifier.enqueue (inside its own transaction).
export const NotificationRequest = z.object({
  merchantId: Id,
  subscriptionId: Id.nullable(),
  to: z.email(),
  content: NotificationContent,
  // Omitted means "send as soon as caps allow".
  dueAt: IsoDateTime.optional(),
  simulated: z.boolean().default(false),
});
export type NotificationRequest = z.input<typeof NotificationRequest>;

export const NotificationStatus = z.enum(["queued", "sending", "sent", "failed", "suppressed"]);
export type NotificationStatus = z.infer<typeof NotificationStatus>;

export const SuppressionReason = z.enum(["frequency_cap", "unsubscribed", "superseded"]);
export type SuppressionReason = z.infer<typeof SuppressionReason>;

export const Notification = z.object({
  id: Id,
  merchantId: Id,
  subscriptionId: Id.nullable(),
  to: z.email(),
  channel: NotificationChannel,
  content: NotificationContent,
  status: NotificationStatus,
  suppressedBecause: SuppressionReason.nullable(),
  dueAt: IsoDateTime,
  sentAt: IsoDateTime.nullable(),
  attempts: z.number().int().min(0),
  providerId: z.string().nullable(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
  simulated: z.boolean(),
  createdAt: IsoDateTime,
});
export type Notification = z.infer<typeof Notification>;

// GET /v1/m/outbox (Demo Inbox): the rendered message exactly as it was (or will be) sent.
export const OutboxItem = z.object({
  id: Id,
  subscriptionId: Id.nullable(),
  to: z.email(),
  template: TemplateId,
  subject: z.string(),
  bodyText: z.string(),
  status: NotificationStatus,
  suppressedBecause: SuppressionReason.nullable(),
  dueAt: IsoDateTime,
  sentAt: IsoDateTime.nullable(),
  simulated: z.boolean(),
});
export type OutboxItem = z.infer<typeof OutboxItem>;

export const OutboxResponse = z.object({
  items: z.array(OutboxItem),
  nextCursor: z.string().nullable(),
});
export type OutboxResponse = z.infer<typeof OutboxResponse>;
