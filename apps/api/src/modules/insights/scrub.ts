// Deterministic redaction for text that goes to the model and for quotes shown to merchants
// (ARCHITECTURE.md §6.12: quotes never identify anyone). No model is involved, so it can't be
// talked out of it. It catches emails, phone and card-like numbers, names the subscriber gave
// ("my name is ..."), titles ("Ms. ..."), and the names we already know from the subscription.
// It cannot find an arbitrary unannounced name; the model is also told not to quote one.

export const QUOTE_MAX_WORDS = 20;
const QUOTE_MAX_CHARS = 160;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// 8+ digits with common separators: phone numbers, and card numbers too.
const NUMBER_RUN = /\+?\d[\d\s().-]{6,}\d/g;
const NAME = "[A-Z][a-z]+(?:[ -][A-Z][a-z]+)?";
const INTRODUCED_NAME = new RegExp(
  `\\b((?:my name is|my name's|name's|call me|this is|it's|regards,|thanks,|cheers,|sincerely,)\\s+)(${NAME})`,
  "gi",
);
const TITLED_NAME = new RegExp(`\\b(?:Mr|Mrs|Ms|Miss|Mx|Dr)\\.?\\s+${NAME}`, "g");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Redacts `text`. `knownNames` are words to remove wherever they appear (first name, last name). */
export function scrubText(text: string, knownNames: readonly string[] = []): string {
  let out = text.replace(EMAIL, "[email]").replace(NUMBER_RUN, "[number]");
  // The captured name must really look like a name ("it's Maya"), so the case-insensitive
  // trigger doesn't swallow ordinary words: only Capitalised words after it are removed.
  out = out.replace(INTRODUCED_NAME, (match: string, lead: string, name: string) =>
    /^[A-Z]/.test(name) ? `${lead}[name]` : match,
  );
  out = out.replace(TITLED_NAME, "[name]");
  for (const name of knownNames) {
    const trimmed = name.trim();
    if (trimmed.length < 2) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, "gi"), "[name]");
  }
  return out;
}

/** Scrubs, collapses whitespace and cuts to 20 words / 160 characters. null when nothing is left. */
export function scrubQuote(quote: string | null, knownNames: readonly string[] = []): string | null {
  if (quote === null) return null;
  const words = scrubText(quote, knownNames).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  let capped = words.slice(0, QUOTE_MAX_WORDS).join(" ");
  if (capped.length > QUOTE_MAX_CHARS) capped = capped.slice(0, QUOTE_MAX_CHARS).trimEnd();
  return capped;
}
