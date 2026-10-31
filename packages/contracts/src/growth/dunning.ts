import { z } from "zod";
import { Id, IsoDateTime, Money } from "../shared.js";

// Playbooks from ARCHITECTURE.md §6.9, chosen by PayPal's failure reason code.
export const DunningPlaybook = z.enum([
  "update_payment_method", // PAYER_CANNOT_PAY, PAYMENT_DENIED
  "account_restricted", // PAYER_ACCOUNT_RESTRICTED
  "sending_limit", // SENDING_LIMIT_EXCEEDED
  "wait_for_retry", // INTERNAL_SERVER_ERROR: no message, PayPal retries on its own
  "generic",
]);
export type DunningPlaybook = z.infer<typeof DunningPlaybook>;

export const DunningState = z.enum([
  "open",
  "recovered",
  // PayPal suspended after the failure threshold; reactivation is offered via the portal.
  "suspended",
  // Subscription cancelled or expired while the case was open.
  "closed",
]);
export type DunningState = z.infer<typeof DunningState>;

export const DunningCase = z.object({
  id: Id,
  merchantId: Id,
  subscriptionId: Id,
  // Kept as PayPal sends it, so unknown future codes still open a (generic) case.
  reasonCode: z.string(),
  failedCount: z.number().int().min(1),
  nextRetryTime: IsoDateTime.nullable(),
  playbook: DunningPlaybook,
  state: DunningState,
  outstanding: Money.nullable(),
  recoveredAmount: Money.nullable(),
  notificationId: Id.nullable(),
  captureActionId: Id.nullable(),
  simulated: z.boolean(),
  openedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
});
export type DunningCase = z.infer<typeof DunningCase>;
