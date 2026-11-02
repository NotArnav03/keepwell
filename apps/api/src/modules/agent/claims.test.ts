import { describe, expect, it } from "vitest";
import type { Offer } from "@keepwell/contracts";
import { checkClaims, type ClaimKind } from "./claims.js";
import { LOCALES, TEMPLATES } from "./i18n.js";

const usd = (value: string) => ({ value, currency: "USD" });
const OFFERS = {
  pause: { id: "pause-1", kind: "pause", cycles: 1, resumesOn: "2026-12-28T10:00:00.000Z" },
  downgrade: {
    id: "downgrade-P-LITE",
    kind: "downgrade",
    toPlanId: "P-LITE",
    toPlanName: "Lite",
    newPrice: usd("6.00"),
  },
  discount: {
    id: "discount-25",
    kind: "discount",
    percent: 25,
    cycles: 3,
    newPrice: usd("9.00"),
    firstAffectedBilling: "2026-11-28T10:00:00.000Z",
  },
} satisfies Record<string, Offer>;

const kinds = (text: string, offer: Offer | null) =>
  [...new Set(checkClaims(text, offer).map((v) => v.kind))].sort();

describe("checkClaims rejects adversarial model text", () => {
  const cases: [string, Offer | null, ClaimKind[]][] = [
    // Figures, in digits, signs and words, in any script
    ["Pause for 2 months!", OFFERS.pause, ["duration", "figure"]],
    ["Get three months at half price.", OFFERS.discount, ["duration", "figure"]],
    ["That's $5 off, or 20% less.", OFFERS.discount, ["figure"]],
    ["२ महीने के लिए रोकें।", OFFERS.pause, ["duration", "figure"]],
    ["३० दिनों तक", null, ["duration", "figure"]],
    ["Pausa de dos meses.", OFFERS.pause, ["duration", "figure"]],
    ["Fifteen percent off for a couple of months.", OFFERS.discount, ["duration", "figure"]],
    ["Ninety, or zero.", null, ["figure"]],
    ["Un descuento del quince.", OFFERS.discount, ["figure"]],
    ["Son cuarenta, o dieciséis.", OFFERS.pause, ["figure"]],
    // Dates
    ["Your plan renews on November 28.", null, ["date", "figure"]],
    ["Next Tuesday nothing is charged.", OFFERS.pause, ["date"]],
    ["Se reanuda el 28 de noviembre.", OFFERS.pause, ["date", "figure"]],
    ["दिसंबर में बिलिंग फिर शुरू होगी।", OFFERS.pause, ["date"]],
    // Promises the card doesn't make
    ["It's free while you're away.", OFFERS.pause, ["promise"]],
    ["We guarantee you'll love it.", null, ["promise"]],
    ["Es gratis durante tu viaje.", OFFERS.pause, ["promise"]],
    ["यह मुफ़्त है।", OFFERS.pause, ["promise"]],
    ["यह मुफ़्त है।", OFFERS.pause, ["promise"]], // फ़ as one code point (U+095E): NFC folds it
    // Pressure and guilt
    ["Hurry, this is your last chance!", OFFERS.discount, ["pressure"]],
    ["We’ll miss you. Are you sure?", null, ["pressure"]],
    ["¡Última oportunidad!", OFFERS.discount, ["pressure"]],
    ["आखिरी मौका! जल्दी करें।", OFFERS.discount, ["pressure"]],
    // Talking about an offer that isn't the one presented, or any offer when none is
    ["You could also get a refund.", OFFERS.pause, ["other_offer"]],
    ["How about a discount instead?", null, ["other_offer"]],
    ["A cheaper plan might suit you.", OFFERS.pause, ["other_offer"]],
    ["Downgrading to a smaller plan could help.", OFFERS.discount, ["other_offer"]],
    ["Switching to annual billing helps.", OFFERS.downgrade, ["other_offer"]],
    ["Te ofrezco un descuento.", OFFERS.pause, ["other_offer"]],
    ["आप रिफंड ले सकते हैं।", OFFERS.pause, ["other_offer"]],
  ];

  it.each(cases)("%s", (text, offer, expected) => {
    expect(kinds(text, offer)).toEqual(expected);
  });

  it("reports what matched, once each", () => {
    expect(checkClaims("Two pauses, two months, free free free.", OFFERS.pause)).toEqual([
      { kind: "figure", match: "two" },
      { kind: "duration", match: "months" },
      { kind: "promise", match: "free" },
    ]);
  });
});

describe("checkClaims lets honest text through", () => {
  const clean: [string, Offer | null][] = [
    ["A pause could fit your travels better.", OFFERS.pause],
    ["Pausing might suit you while you're away.", OFFERS.pause],
    ["A cheaper plan might suit you better.", OFFERS.downgrade],
    ["A lower price for a while might help.", OFFERS.discount],
    ["Understood. You can cancel with the button below.", null],
    ["Is it mostly the price, or how often you use it?", null],
    ["Thanks for being with us, and have a good day.", null],
    ["Here's one option that might help.", OFFERS.pause],
    ["Entendido. Puedes cancelar con el botón de abajo.", null],
    ["Una pausa podría venirte bien.", OFFERS.pause],
    ["Puedes dejarlo sobre la mesa.", null], // "mes" inside "mesa" is not a duration
    ["समझ गया। नीचे Cancel बटन है।", null],
    ["थोड़ा विराम आपकी यात्रा के लिए ठीक रहेगा।", OFFERS.pause],
  ];

  it.each(clean)("%s", (text, offer) => {
    expect(checkClaims(text, offer)).toEqual([]);
  });

  it("passes every template reply, in every language", () => {
    for (const locale of LOCALES) {
      for (const text of Object.values(TEMPLATES[locale])) expect(checkClaims(text, null)).toEqual([]);
    }
  });
});
