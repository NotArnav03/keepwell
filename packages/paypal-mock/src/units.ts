// Money and time in PayPal's own formats: decimal strings and second-precision UTC timestamps.

export interface PayPalMoney {
  currency_code: string;
  value: string;
}

export type IntervalUnit = "DAY" | "WEEK" | "MONTH" | "YEAR";

/** "12.00" → 1200. Integer cents, so sums and refunds never drift. */
export function toCents(value: string): number {
  const [whole = "0", fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
}

export function money(cents: number, currency: string): PayPalMoney {
  return { currency_code: currency, value: (cents / 100).toFixed(2) };
}

/** PayPal sends times without milliseconds: 2026-10-30T10:00:00Z. */
export function paypalTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function addInterval(date: Date, unit: IntervalUnit, count: number): Date {
  const next = new Date(date);
  if (unit === "DAY") next.setUTCDate(next.getUTCDate() + count);
  else if (unit === "WEEK") next.setUTCDate(next.getUTCDate() + 7 * count);
  else if (unit === "MONTH") next.setUTCMonth(next.getUTCMonth() + count);
  else next.setUTCFullYear(next.getUTCFullYear() + count);
  return next;
}

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** An id shaped like PayPal's (e.g. transaction ids are 17 upper-case characters). */
export function paypalId(length: number, random: () => number = Math.random): string {
  let id = "";
  for (let i = 0; i < length; i++) id += ALPHANUMERIC[Math.floor(random() * ALPHANUMERIC.length)];
  return id;
}
