import type { MerchantSubscriptionListItem } from "@keepwell/contracts";
import { moneyLabel } from "./format.js";

/** The list contract's risk object is a band and a score. There is no separate factor array. */
export function riskLevel(risk: { score: number; band: string } | null): string {
  if (!risk) return "Not scored";
  return `${risk.band} (${risk.score}/100)`;
}

/**
 * Signals already on the subscription row. These are not a second score: the points model
 * stays on the server, and this list only repeats fields the subscribers API returned.
 */
export function riskFactors(item: MerchantSubscriptionListItem): string[] {
  const { subscription } = item;
  const factors: string[] = [];
  if (subscription.failedPaymentsCount > 0) {
    const count = subscription.failedPaymentsCount;
    factors.push(`${count} failed ${count === 1 ? "payment" : "payments"}`);
  }
  const outstanding = subscription.outstandingBalance;
  if (outstanding && outstanding.value !== "0.00") {
    const label = moneyLabel(outstanding);
    if (label) factors.push(`Outstanding ${label}`);
  }
  if (subscription.lastFailure) factors.push(`Last failure ${subscription.lastFailure.reasonCode}`);
  return factors;
}
