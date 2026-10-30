import { describe, expect, it } from "vitest";
import type { Offer } from "@keepwell/contracts";
import { renderCardText } from "./cards.js";
import { formatDay, formatMoney, formatPercent, LOCALES, resolveLocale } from "./i18n.js";

const usd = (value: string) => ({ value, currency: "USD" });
const OFFERS: Offer[] = [
  { id: "pause-2", kind: "pause", cycles: 2, resumesOn: "2027-01-28T10:00:00.000Z" },
  {
    id: "downgrade-P-LITE",
    kind: "downgrade",
    toPlanId: "P-LITE",
    toPlanName: "Lite",
    newPrice: usd("6.00"),
  },
  {
    id: "switch_annual-P-ANNUAL",
    kind: "switch_annual",
    toPlanId: "P-ANNUAL",
    newPrice: usd("120.00"),
    effectiveMonthly: usd("10.00"),
  },
  {
    id: "discount-25",
    kind: "discount",
    percent: 25,
    cycles: 3,
    newPrice: usd("9.00"),
    firstAffectedBilling: "2026-11-28T10:00:00.000Z",
  },
  {
    id: "refund_partial",
    kind: "refund_partial",
    amount: usd("6.00"),
    ofPaymentOn: "2026-10-28T10:00:00.000Z",
  },
];

/** Every figure on an offer, formatted the way its card must show it. */
function figures(offer: Offer, locale: (typeof LOCALES)[number]): string[] {
  const m = (v: { value: string; currency: string }) => formatMoney(v, locale);
  const d = (iso: string) => formatDay(iso, locale);
  switch (offer.kind) {
    case "pause":
      return [String(offer.cycles), d(offer.resumesOn)];
    case "downgrade":
      return [offer.toPlanName, m(offer.newPrice)];
    case "switch_annual":
      return [m(offer.newPrice), m(offer.effectiveMonthly)];
    case "discount":
      return [
        formatPercent(offer.percent, locale),
        String(offer.cycles),
        m(offer.newPrice),
        d(offer.firstAffectedBilling),
      ];
    case "refund_partial":
      return [m(offer.amount), d(offer.ofPaymentOn)];
  }
}

describe("renderCardText", () => {
  it("states every term from the offer, formatted for each language, and nothing raw", () => {
    for (const locale of LOCALES) {
      for (const offer of OFFERS) {
        const card = renderCardText(offer, locale);
        for (const figure of figures(offer, locale)) expect(card).toContain(figure);
        expect(card).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:/); // no ISO timestamps
        expect(card).not.toContain("USD 6.00"); // money is never the raw value + code
      }
    }
  });

  it("reads naturally in each language", () => {
    const [pause, , , discount] = OFFERS as [Offer, Offer, Offer, Offer];
    expect(renderCardText(pause, "en")).toBe(
      "Pause for 2 billing cycles. Billing resumes on January 28, 2027.",
    );
    expect(renderCardText(pause, "es")).toBe(
      "Pausa durante 2 ciclos de facturación. La facturación se reanuda el 28 de enero de 2027.",
    );
    expect(renderCardText(pause, "hi")).toBe(
      "2 बिलिंग चक्र के लिए रोकें। बिलिंग 28 जनवरी 2027 से फिर शुरू होगी।",
    );
    expect(renderCardText(discount, "en")).toBe(
      "25% off for 3 billing cycles: $9.00 from November 28, 2026.",
    );
    expect(renderCardText({ ...pause, cycles: 1 } as Offer, "en")).toContain("1 billing cycle.");
  });

  it("defaults to English", () => {
    const [pause] = OFFERS as [Offer];
    expect(renderCardText(pause)).toBe(renderCardText(pause, "en"));
  });
});

describe("i18n", () => {
  it.each([
    ["hi", "hi"],
    ["hi-IN", "hi"],
    ["ES_mx", "es"],
    ["en-GB", "en"],
    ["fr", "en"],
    ["", "en"],
    [null, "en"],
  ] as const)("resolveLocale(%s) is %s", (tag, locale) => {
    expect(resolveLocale(tag)).toBe(locale);
  });

  it("formats money from the decimal string, never through a float", () => {
    // As a float this would print .94.
    expect(formatMoney(usd("90071992547409.93"), "en")).toBe("$90,071,992,547,409.93");
    expect(formatMoney({ value: "999.00", currency: "INR" }, "hi")).toBe("₹999.00");
  });

  it("shows the UTC calendar day", () => {
    expect(formatDay("2026-11-28T23:30:00.000Z", "en")).toBe("November 28, 2026");
  });
});
