import type { DunningPlaybook } from "@keepwell/contracts";

// ARCHITECTURE.md §6.9: the playbook follows PayPal's failure reason code.
export function selectPlaybook(reasonCode: string): DunningPlaybook {
  switch (reasonCode) {
    case "PAYER_CANNOT_PAY":
    case "PAYMENT_DENIED":
      return "update_payment_method";
    case "PAYER_ACCOUNT_RESTRICTED":
      return "account_restricted";
    case "SENDING_LIMIT_EXCEEDED":
      return "sending_limit";
    case "INTERNAL_SERVER_ERROR":
      // PayPal's own fault and it retries by itself: a message would only worry the subscriber.
      return "wait_for_retry";
    default:
      return "generic";
  }
}

/** Send about this long before PayPal's retry, so the subscriber has time to fix funding. */
export const LEAD_TIME_MS = 24 * 60 * 60 * 1000;

/** When to send: 24 h before the retry, or right now when the retry is closer than that. */
export function messageDueAt(nextRetryTime: string | null, now: Date): string {
  if (nextRetryTime === null) return now.toISOString();
  const target = new Date(nextRetryTime).getTime() - LEAD_TIME_MS;
  return new Date(Math.max(target, now.getTime())).toISOString();
}

/** Money is decimal strings; compare in whole minor units without floats. */
export function isPositive(value: string): boolean {
  return BigInt(value.replace(".", "")) > 0n;
}
