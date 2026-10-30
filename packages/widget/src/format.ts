import type { BillingInterval, Money, Offer, SubscriptionSummary } from "@keepwell/contracts";

// Offer headlines and plan lines, built from structured data only (design law 4): the model never
// supplies a price, a date or a duration the widget shows.

export function money(m: Money, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: m.currency }).format(Number(m.value));
}

export function day(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso));
}

function per(interval: BillingInterval): string {
  const unit = interval.unit.toLowerCase();
  return interval.count === 1 ? unit : `${interval.count} ${unit}s`;
}

export function planLine(s: SubscriptionSummary, locale: string): string {
  return `${s.planName} · ${money(s.price, locale)} / ${per(s.interval)}`;
}

export function offerHeadline(offer: Offer, locale: string): string {
  switch (offer.kind) {
    case "pause":
      return `Pause until ${day(offer.resumesOn, locale)}`;
    case "downgrade":
      return `Switch to ${offer.toPlanName} for ${money(offer.newPrice, locale)}`;
    case "switch_annual":
      return `Pay yearly: ${money(offer.newPrice, locale)} (${money(offer.effectiveMonthly, locale)} a month)`;
    case "discount":
      return `${offer.percent}% off: ${money(offer.newPrice, locale)} from ${day(offer.firstAffectedBilling, locale)}`;
    case "refund_partial":
      return `${money(offer.amount, locale)} back on your last payment`;
  }
}

/** What happens on Accept, so nobody is surprised by PayPal's own approval page. */
export function acceptNote(offer: Offer): string | null {
  return offer.kind === "downgrade" || offer.kind === "switch_annual"
    ? "PayPal will ask you to approve the change."
    : null;
}
