import type { Offer, SessionOutcome } from "@keepwell/contracts";

// The line the widget shows when a session closes: from the outcome and the Offer object, never
// from the model (CONTRACTS.md §4). English only for now; hi and es follow the card templates.

const money = (m: { value: string; currency: string }) => `${m.value} ${m.currency}`;
const day = (iso: string) => iso.slice(0, 10);

export function closingSummary(outcome: SessionOutcome, offer: Offer | null): string {
  if (outcome === "cancelled") return "Your subscription is cancelled. You won't be charged again.";
  if (outcome === "kept_without_offer") return "Nothing has changed. Your subscription continues as before.";
  if (outcome === "abandoned" || offer === null) return "This conversation ended without any change.";
  switch (offer.kind) {
    case "pause":
      return `Your subscription is paused. Billing restarts on ${day(offer.resumesOn)}.`;
    case "downgrade":
      return `You're now on ${offer.toPlanName} at ${money(offer.newPrice)}.`;
    case "switch_annual":
      return `You're now on annual billing at ${money(offer.newPrice)} a year.`;
    case "discount":
      return `${offer.percent}% off applies from ${day(offer.firstAffectedBilling)}.`;
    case "refund_partial":
      return `A refund of ${money(offer.amount)} is on its way.`;
  }
}
