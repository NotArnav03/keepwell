import type { Offer, OfferKind } from "@keepwell/contracts";

// The claims checker (#25, ARCHITECTURE.md §6.5, law 4). The offer card carries every term, so the
// model's own text may carry none: no figures, dates or durations, no promises, no pressure, and no
// talk of an offer kind other than the one it presented. Deterministic on purpose: it runs on every
// reply, costs nothing, and can't be argued with. A violation sends the reply back once, then the
// runtime uses template text.
//
// Word lists cover en, hi and es. They're matched as whole words with Unicode-aware boundaries
// (JS's \b only knows ASCII), after NFC normalisation and lower-casing.

export type ClaimKind = "figure" | "date" | "duration" | "promise" | "pressure" | "other_offer";

export interface ClaimViolation {
  kind: ClaimKind;
  /** The text that broke the rule, for logs and evals. */
  match: string;
}

const NUMBER_WORDS = [
  // en ("one" and "a" are left out: "one option" and "a break" are fine; ordinals too, since
  // "first, can I ask why?" is ordinary, and "your second month" is caught by "month")
  "zero",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "half",
  "dozen",
  "couple",
  "double",
  "twice",
  // es ("uno/una" are articles; "once" is English too; "medio" also means "means")
  "dos",
  "tres",
  "cuatro",
  "cinco",
  "seis",
  "siete",
  "ocho",
  "nueve",
  "diez",
  "cero",
  "doce",
  "trece",
  "catorce",
  "quince",
  "dieciséis",
  "diecisiete",
  "dieciocho",
  "diecinueve",
  "veinte",
  "treinta",
  "cuarenta",
  "cincuenta",
  "sesenta",
  "setenta",
  "ochenta",
  "noventa",
  "cien",
  "ciento",
  "mil",
  "mitad",
  "doble",
  // hi ("एक" also means "a")
  "दो",
  "तीन",
  "चार",
  "पांच",
  "पाँच",
  "छह",
  "छः",
  "सात",
  "आठ",
  "नौ",
  "दस",
  "बीस",
  "सौ",
  "हज़ार",
  "हजार",
  "आधा",
  "आधे",
  "दोगुना",
];

const DATE_WORDS = [
  "january",
  "february",
  "march",
  "april",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december", // "may" is left out: it's a verb
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "tomorrow",
  "tonight",
  "yesterday", // "today" is left out: "how can I help today?"
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "setiembre",
  "octubre",
  "noviembre",
  "diciembre",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
  "domingo",
  "mañana",
  "ayer",
  "जनवरी",
  "फरवरी",
  "फ़रवरी",
  "मार्च",
  "अप्रैल",
  "मई",
  "जून",
  "जुलाई",
  "अगस्त",
  "सितंबर",
  "सितम्बर",
  "अक्टूबर",
  "नवंबर",
  "नवम्बर",
  "दिसंबर",
  "दिसम्बर",
  "सोमवार",
  "मंगलवार",
  "बुधवार",
  "गुरुवार",
  "शुक्रवार",
  "शनिवार",
  "रविवार",
  "कल",
];

const DURATION_WORDS = [
  // The singular "day" (and día, दिन) is left out: "have a good day" is a pleasantry, not a term.
  "days",
  "week",
  "weeks",
  "fortnight",
  "month",
  "months",
  "year",
  "years",
  "días",
  "semana",
  "semanas",
  "quincena",
  "mes",
  "meses",
  "año",
  "años",
  "दिनों",
  "हफ्ता",
  "हफ्ते",
  "हफ़्ता",
  "हफ़्ते",
  "सप्ताह",
  "महीना",
  "महीने",
  "महीनों",
  "माह",
  "साल",
  "सालों",
  "वर्ष",
];

const PROMISE_WORDS = [
  "free",
  "freebie",
  "gift",
  "bonus",
  "guarantee",
  "guaranteed",
  "guarantees",
  "forever",
  "lifetime",
  "for life",
  "on us",
  "no charge",
  "no cost",
  "at no cost",
  "unlimited",
  "upgrade",
  "gratis",
  "gratuito",
  "gratuita",
  "regalo",
  "bono",
  "garantía",
  "garantizado",
  "garantizada",
  "garantizamos",
  "para siempre",
  "de por vida",
  "sin costo",
  "sin cargo",
  "ilimitado",
  "ilimitada",
  "मुफ़्त",
  "मुफ्त",
  "फ्री",
  "फ़्री",
  "उपहार",
  "तोहफ़ा",
  "तोहफा",
  "बोनस",
  "गारंटी",
  "हमेशा के लिए",
  "जीवन भर",
];

const PRESSURE_WORDS = [
  "hurry",
  "last chance",
  "only today",
  "today only",
  "act now",
  "limited time",
  "limited-time",
  "expires",
  "expiring",
  "don't miss",
  "miss out",
  "you'll lose",
  "you will lose",
  "you'll regret",
  "you will regret",
  "before it's too late",
  "are you sure",
  "we'll miss you",
  "we will miss you",
  "date prisa",
  "última oportunidad",
  "solo hoy",
  "sólo hoy",
  "por tiempo limitado",
  "no te lo pierdas",
  "perderás",
  "te arrepentirás",
  "estás seguro",
  "estás segura",
  "te echaremos de menos",
  "जल्दी करें",
  "जल्दी कीजिए",
  "आखिरी मौका",
  "आख़िरी मौका",
  "सिर्फ आज",
  "केवल आज",
  "पछताएंगे",
  "पछताएँगे",
  "पछताओगे",
  "क्या आप सच में",
  "हम आपको याद करेंगे",
];

type Offerable = Exclude<OfferKind, "none">;
const CHEAPER: Offerable[] = ["downgrade", "discount", "switch_annual"];

/** Words that point at an offer kind: allowed only when the presented offer is one of those kinds. */
const OFFER_WORDS: [Offerable[], string[]][] = [
  [
    ["pause"],
    [
      "pause",
      "pausing",
      "paused",
      "take a break",
      "pausa",
      "pausar",
      "pausarla",
      "pausarlo",
      "un descanso",
      "रोक",
      "रोकें",
      "रोकना",
      "रोकने",
      "विराम",
      "पॉज़",
      "पॉज",
      "ब्रेक",
    ],
  ],
  [
    ["downgrade"],
    [
      "downgrade",
      "downgrading",
      "cheaper plan",
      "smaller plan",
      "lower plan",
      "plan más barato",
      "plan más económico",
      "सस्ता प्लान",
      "सस्ते प्लान",
      "छोटा प्लान",
      "छोटे प्लान",
    ],
  ],
  [["switch_annual"], ["annual", "annually", "yearly", "anual", "anualmente", "सालाना", "वार्षिक"]],
  [
    ["discount"],
    [
      "discount",
      "discounted",
      "reduced price",
      "price cut",
      "descuento",
      "rebaja",
      "precio reducido",
      "छूट",
      "डिस्काउंट",
    ],
  ],
  [
    ["refund_partial"],
    [
      "refund",
      "refunded",
      "refunding",
      "money back",
      "reimburse",
      "reembolso",
      "reembolsar",
      "devolución",
      "रिफंड",
      "धनवापसी",
      "पैसे वापस",
    ],
  ],
  [CHEAPER, ["cheaper", "lower price", "save money", "más barato", "más barata", "ahorrar", "सस्ता", "बचत"]],
];

const norm = (s: string) => s.normalize("NFC").replace(/[’‘]/g, "'").toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole words in any script: no letter, mark or digit right before or after. */
function words(terms: string[]): RegExp {
  const alternatives = [...new Set(terms.map(norm))].sort((a, b) => b.length - a.length).map(escape);
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{M}\\p{N}])`, "gu");
}

const CHECKS: [ClaimKind, RegExp][] = [
  // Any digit in any script, any currency sign, a percent sign.
  ["figure", /[\p{Nd}\p{Sc}%]/gu],
  ["figure", words(NUMBER_WORDS)],
  ["date", words(DATE_WORDS)],
  ["duration", words(DURATION_WORDS)],
  ["promise", words(PROMISE_WORDS)],
  ["pressure", words(PRESSURE_WORDS)],
];
const OFFER_CHECKS = OFFER_WORDS.map(([kinds, terms]) => [kinds, words(terms)] as const);

/** Every rule the text breaks, given the offer it accompanies (null when it presents none). */
export function checkClaims(text: string, offer: Offer | null): ClaimViolation[] {
  const t = norm(text);
  const found: ClaimViolation[] = [];
  const add = (kind: ClaimKind, match: string) => {
    if (!found.some((v) => v.kind === kind && v.match === match)) found.push({ kind, match });
  };
  for (const [kind, re] of CHECKS) for (const m of t.matchAll(re)) add(kind, m[0]);
  for (const [kinds, re] of OFFER_CHECKS) {
    if (offer && kinds.includes(offer.kind)) continue;
    for (const m of t.matchAll(re)) add("other_offer", m[0]);
  }
  return found;
}
