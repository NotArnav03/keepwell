// What a transcript keeps (ARCHITECTURE.md §10: "Messages are stored with emails and phone numbers
// redacted"). The messages table feeds insights and the dashboard, which have no business knowing
// how to reach a subscriber. The live conversation still sees the original text: only what is
// stored is redacted.

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
// Seven or more digits, allowing spaces, dots, dashes, brackets and a leading +, as phone numbers
// are written. Shorter runs (a price, a year, "3 months") are left alone.
const PHONE = /(?<![\p{L}\p{N}])\+?\(?\d(?:[\s.()-]*\d){6,}(?![\p{L}\p{N}])/gu;
// Card-like numbers (13 to 19 digits) are covered by PHONE's pattern too, but say so explicitly.
const CARD = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

export function redact(text: string): string {
  return text.replace(EMAIL, "[email]").replace(CARD, "[number]").replace(PHONE, "[phone]");
}
