import type { Offer, SessionOutcome } from "@keepwell/contracts";

// The line the widget shows when a session closes: from the outcome and the Offer object, never
// from the model (CONTRACTS.md §4). English only for now; hi and es follow the card templates.

// Formatted like the offer card just above it in the widget ("$12.00", "January 11, 2027"), so the
// same date doesn't appear in two styles. Intl formats the decimal string; it never becomes a float.
const LOCALE = "en-US";
const money = (m: { value: string; currency: string }) =>
  new Intl.NumberFormat(LOCALE, { style: "currency", currency: m.currency }).format(
    m.value as unknown as number,
  );
// Billing dates are UTC instants, shown as the UTC calendar day, as the cards do.
const day = (iso: string) =>
  new Intl.DateTimeFormat(LOCALE, { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso));

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
