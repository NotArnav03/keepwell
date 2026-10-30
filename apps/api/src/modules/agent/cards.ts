import { createHash } from "node:crypto";
import type { Offer } from "@keepwell/contracts";

// Offer cards render from the Offer object, never from model text (design law). English only for
// now; the en/hi/es templates arrive with the claims checker (#25).

export function renderCardText(offer: Offer): string {
  const cycles = (n: number) => `${n} billing cycle${n === 1 ? "" : "s"}`;
  switch (offer.kind) {
    case "pause":
      return `Pause for ${cycles(offer.cycles)}. Billing resumes on ${day(offer.resumesOn)}.`;
    case "downgrade":
      return `Switch to ${offer.toPlanName} for ${money(offer.newPrice)}.`;
    case "switch_annual":
      return `Switch to annual billing: ${money(offer.newPrice)} a year (${money(offer.effectiveMonthly)} a month).`;
    case "discount":
      return `${offer.percent}% off for ${cycles(offer.cycles)}: ${money(offer.newPrice)} from ${day(offer.firstAffectedBilling)}.`;
    case "refund_partial":
      return `A refund of ${money(offer.amount)} on your payment of ${day(offer.ofPaymentOn)}.`;
  }
}

/** sha256 of exactly what the subscriber saw; the accept click sends it back as consent. */
export function shownTextHash(message: string, cardText: string): string {
  return createHash("sha256").update(`${message}\n${cardText}`).digest("hex");
}

const money = (m: { value: string; currency: string }) => `${m.value} ${m.currency}`;
const day = (iso: string) => iso.slice(0, 10);
