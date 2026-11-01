// Deterministic post-check for the copilot's final text (ARCHITECTURE.md §6.12: every number comes
// from SQL, never from the model). Ishan's claims checker covers offer terms for subscribers and
// exports nothing reusable for merchant analytics, so this is a small standalone check: every
// numeric token in the reply must appear in a tool result or in what the merchant typed.

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

const normalise = (token: string): string => {
  const plain = token.replace(/,/g, "");
  return plain.includes(".") ? plain.replace(/0+$/, "").replace(/\.$/, "") : plain;
};

/** Every numeric token in a string, normalised ("1,250.50" -> "1250.5"). */
export function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map(normalise);
}

function collect(value: unknown, into: Set<string>): void {
  if (typeof value === "number") {
    into.add(normalise(String(value)));
    // A rate of 0.1234 may be written as 12.34%.
    if (value > 0 && value <= 1) into.add(normalise((value * 100).toFixed(2)));
  } else if (typeof value === "string") {
    for (const n of numbersIn(value)) into.add(n);
  } else if (Array.isArray(value)) {
    for (const v of value) collect(v, into);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collect(v, into);
  }
}

/** Numbers in `text` that appear in none of `sources`. Percent forms and whole-number rounding pass. */
export function unsupportedNumbers(text: string, sources: readonly unknown[]): string[] {
  const allowed = new Set<string>();
  for (const s of sources) collect(s, allowed);
  for (const a of [...allowed]) {
    const n = Number(a);
    if (Number.isFinite(n)) allowed.add(String(Math.round(n)));
  }
  return [...new Set(numbersIn(text))].filter((n) => !allowed.has(n));
}
