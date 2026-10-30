// The languages the agent speaks with fixed text: offer cards and template replies. The model may
// reply in any language; anything it doesn't write falls back to English.

export const LOCALES = ["en", "hi", "es"] as const;
export type Locale = (typeof LOCALES)[number];

/** "hi-IN" → "hi", "es-MX" → "es", anything unsupported → "en". */
export function resolveLocale(tag: string | null | undefined): Locale {
  const base = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return LOCALES.find((l) => l === base) ?? "en";
}

/** Money stays a decimal string end to end: Intl formats the string, it never becomes a float. */
export function formatMoney(m: { value: string; currency: string }, locale: Locale): string {
  // `format` takes a decimal string exactly (Intl.NumberFormat v3, Node 20+).
  return new Intl.NumberFormat(locale, { style: "currency", currency: m.currency }).format(
    m.value as unknown as number,
  );
}

export function formatPercent(percent: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { style: "percent" }).format(percent / 100);
}

/** Billing dates are UTC instants; the card shows the UTC calendar day, like PayPal's own emails. */
export function formatDay(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso));
}

/** Template replies, used when the model is skipped, fails, or breaks a rule twice. */
export const TEMPLATES: Record<Locale, Record<"close" | "care" | "limit" | "offer" | "l1", string>> = {
  en: {
    close: "Understood. The Cancel button below ends your subscription right away.",
    care: "I'm sorry you're going through this. The Cancel button below ends your subscription right away, with nothing else to do.",
    limit:
      "Thanks for talking it through with me. Whatever you decide, the Cancel button below ends your subscription right away.",
    offer:
      "Thanks for telling me. Here's one option that might help. If it doesn't, the Cancel button below ends your subscription right away.",
    l1: "Sorry, I can't chat right now. Pick the reason that fits best, or use the Cancel button below.",
  },
  hi: {
    close: "समझ गया। नीचे दिया गया Cancel बटन आपकी सदस्यता तुरंत खत्म कर देता है।",
    care: "मुझे खेद है कि आप इस स्थिति से गुज़र रहे हैं। नीचे दिया गया Cancel बटन आपकी सदस्यता तुरंत खत्म कर देता है, और कुछ करने की ज़रूरत नहीं है।",
    limit:
      "बात करने के लिए धन्यवाद। आप जो भी तय करें, नीचे दिया गया Cancel बटन आपकी सदस्यता तुरंत खत्म कर देता है।",
    offer:
      "बताने के लिए धन्यवाद। यह एक विकल्प मदद कर सकता है। अगर नहीं, तो नीचे दिया गया Cancel बटन आपकी सदस्यता तुरंत खत्म कर देता है।",
    l1: "माफ़ कीजिए, मैं अभी बात नहीं कर सकता। सबसे सही कारण चुनें, या नीचे दिए गए Cancel बटन का इस्तेमाल करें।",
  },
  es: {
    close: "Entendido. El botón Cancelar de abajo termina tu suscripción de inmediato.",
    care: "Siento que estés pasando por esto. El botón Cancelar de abajo termina tu suscripción de inmediato, sin nada más que hacer.",
    limit:
      "Gracias por contármelo. Decidas lo que decidas, el botón Cancelar de abajo termina tu suscripción de inmediato.",
    offer:
      "Gracias por contármelo. Esta opción podría ayudarte. Si no, el botón Cancelar de abajo termina tu suscripción de inmediato.",
    l1: "Lo siento, ahora no puedo chatear. Elige el motivo que mejor encaje o usa el botón Cancelar de abajo.",
  },
};
