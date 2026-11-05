// ARCHITECTURE.md §10: stored messages have emails and phone numbers removed. Card-like
// numbers go too, so a reply cannot keep a PAN. This is a pattern pass only: names, postal
// addresses and numbers written as words stay, and so do dates, prices and short counts.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// 13–19 digits, spaces or dashes allowed between them. A leading "+" is a phone, not a PAN.
// A dot followed by a digit is a decimal; a sentence period is not. Single-digit lists are rejected below.
const CARD = /(?<![\d.+])\d(?:[ -]?\d){12,18}(?!\d)(?!\.\d)/g;

// NANP: (415) 555-0100, 415-555-0100, 415 555 0100, and the same with a +1 country code.
const NANP = /(?<![\d])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g;

// Spaced international numbers: +44 20 7946 0958, +91 98765 43210.
const INTL = /(?<![\w])\+\d{1,3}(?:[\s-]\d{1,14}){2,6}/g;

// Compact E.164 with no separators: +14155550100.
const COMPACT = /(?<![\d])\+\d{10,15}(?![\d])/g;

function digitCount(value: string): number {
  return value.replace(/\D/g, "").length;
}

function isCardLike(match: string): boolean {
  const groups = match.split(/[ -]/);
  // "1 2 3 4 ..." is a list of small counts, not a card number.
  if (groups.length > 1 && groups.every((group) => group.length === 1)) return false;
  const count = digitCount(match);
  return count >= 13 && count <= 19;
}

/**
 * Drops a trailing 1–2 digit group when the rest is already a full number, so
 * "+44 20 7946 0958 12" redacts the phone and leaves the 12 (a price or a day).
 * Returns the prefix to replace, or null when the match is not a phone.
 */
function keepInternational(match: string): string | null {
  const parsed = /^(\+\d{1,3})((?:[\s-]\d{1,14})+)$/.exec(match);
  const country = parsed?.[1];
  const rest = parsed?.[2];
  if (!country || rest === undefined) return null;
  const groups = [...rest.matchAll(/[\s-]\d{1,14}/g)].map((found) => found[0]);
  while (groups.length > 2) {
    const last = groups[groups.length - 1] ?? "";
    const lastDigits = digitCount(last);
    const restDigits = digitCount(country) + digitCount(groups.slice(0, -1).join(""));
    if (lastDigits <= 2 && restDigits >= 10) {
      groups.pop();
      continue;
    }
    break;
  }
  const kept = country + groups.join("");
  if (!match.startsWith(kept)) return null;
  const total = digitCount(kept);
  if (groups.length < 2 || total < 10 || total > 15) return null;
  return kept;
}

function redactEmails(text: string): string {
  return text.replace(EMAIL, "[email]");
}

function redactNumbers(text: string): string {
  return text.replace(CARD, (match) => (isCardLike(match) ? "[number]" : match));
}

function redactPhones(text: string): string {
  const nanp = text.replace(NANP, "[phone]");
  const spaced = nanp.replace(INTL, (match) => {
    const kept = keepInternational(match);
    if (!kept) return match;
    return `[phone]${match.slice(kept.length)}`;
  });
  return spaced.replace(COMPACT, "[phone]");
}

/** Replaces emails, phone numbers and card-like numbers. Pure: same input, same output. */
export function redactPii(text: string): string {
  // Emails first so a long local-part is not read as a card. Numbers before phones so a PAN
  // written with spaces is not partly read as a NANP number.
  return redactPhones(redactNumbers(redactEmails(text)));
}
