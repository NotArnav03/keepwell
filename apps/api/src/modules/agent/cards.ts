import { createHash } from "node:crypto";
import type { Offer } from "@keepwell/contracts";
import { formatDay, formatMoney, formatPercent, type Locale } from "./i18n.js";

// Offer cards render from the Offer object, never from model text (design law). Every figure on a
// card comes from the offer and is formatted with Intl for the subscriber's language.

type Money = { value: string; currency: string };
interface Fmt {
  money: (m: Money) => string;
  day: (iso: string) => string;
  percent: (p: number) => string;
}

const CARDS: Record<Locale, (offer: Offer, f: Fmt) => string> = {
  en: (offer, { money, day, percent }) => {
    const cycles = (n: number) => `${n} billing cycle${n === 1 ? "" : "s"}`;
    switch (offer.kind) {
      case "pause":
        return `Pause for ${cycles(offer.cycles)}. Billing resumes on ${day(offer.resumesOn)}.`;
      case "downgrade":
        return `Switch to ${offer.toPlanName} for ${money(offer.newPrice)}.`;
      case "switch_annual":
        return `Switch to annual billing: ${money(offer.newPrice)} a year (${money(offer.effectiveMonthly)} a month).`;
      case "discount":
        return `${percent(offer.percent)} off for ${cycles(offer.cycles)}: ${money(offer.newPrice)} from ${day(offer.firstAffectedBilling)}.`;
      case "refund_partial":
        return `A refund of ${money(offer.amount)} on your payment of ${day(offer.ofPaymentOn)}.`;
    }
  },
  es: (offer, { money, day, percent }) => {
    const cycles = (n: number) => `${n} ciclo${n === 1 ? "" : "s"} de facturación`;
    switch (offer.kind) {
      case "pause":
        return `Pausa durante ${cycles(offer.cycles)}. La facturación se reanuda el ${day(offer.resumesOn)}.`;
      case "downgrade":
        return `Cambia a ${offer.toPlanName} por ${money(offer.newPrice)}.`;
      case "switch_annual":
        return `Cambia a facturación anual: ${money(offer.newPrice)} al año (${money(offer.effectiveMonthly)} al mes).`;
      case "discount":
        return `${percent(offer.percent)} de descuento durante ${cycles(offer.cycles)}: ${money(offer.newPrice)} a partir del ${day(offer.firstAffectedBilling)}.`;
      case "refund_partial":
        return `Un reembolso de ${money(offer.amount)} sobre tu pago del ${day(offer.ofPaymentOn)}.`;
    }
  },
  hi: (offer, { money, day, percent }) => {
    const cycles = (n: number) => `${n} बिलिंग चक्र`;
    switch (offer.kind) {
      case "pause":
        return `${cycles(offer.cycles)} के लिए रोकें। बिलिंग ${day(offer.resumesOn)} से फिर शुरू होगी।`;
      case "downgrade":
        return `${money(offer.newPrice)} में ${offer.toPlanName} पर जाएँ।`;
      case "switch_annual":
        return `सालाना बिलिंग पर जाएँ: ${money(offer.newPrice)} प्रति वर्ष (${money(offer.effectiveMonthly)} प्रति माह)।`;
      case "discount":
        return `${cycles(offer.cycles)} के लिए ${percent(offer.percent)} की छूट: ${day(offer.firstAffectedBilling)} से ${money(offer.newPrice)}।`;
      case "refund_partial":
        return `${day(offer.ofPaymentOn)} के आपके भुगतान पर ${money(offer.amount)} का रिफंड।`;
    }
  },
};

export function renderCardText(offer: Offer, locale: Locale = "en"): string {
  return CARDS[locale](offer, {
    money: (m) => formatMoney(m, locale),
    day: (iso) => formatDay(iso, locale),
    percent: (p) => formatPercent(p, locale),
  });
}

/** sha256 of exactly what the subscriber saw; the accept click sends it back as consent. */
export function shownTextHash(message: string, cardText: string): string {
  return createHash("sha256").update(`${message}\n${cardText}`).digest("hex");
}
