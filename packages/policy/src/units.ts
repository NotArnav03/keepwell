import type { BillingInterval, Money } from "@keepwell/contracts";

// Money in integer cents and time in UTC milliseconds, so no float ever touches a price.

const DAY_MS = 86_400_000;

/** "12.34" → 1234. The contracts guarantee the /^\d+\.\d{2}$/ shape. */
export function toCents(money: Money): number {
  const [whole = "0", cents = "00"] = money.value.split(".");
  return Number(whole) * 100 + Number(cents);
}

export function fromCents(cents: number, currency: string): Money {
  const whole = Math.floor(cents / 100);
  return { value: `${whole}.${String(cents % 100).padStart(2, "0")}`, currency };
}

/** Fractional days from `fromIso` to `toIso` (negative if `toIso` is earlier). */
export function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS;
}

export function sameInterval(a: BillingInterval, b: BillingInterval): boolean {
  return a.unit === b.unit && a.count === b.count;
}

/** `iso` plus `times` billing intervals. A month end clamps: 31 Jan + 1 month = 28 or 29 Feb. */
export function addIntervals(iso: string, interval: BillingInterval, times: number): string {
  const date = new Date(iso);
  const n = interval.count * times;
  switch (interval.unit) {
    case "DAY":
      date.setUTCDate(date.getUTCDate() + n);
      break;
    case "WEEK":
      date.setUTCDate(date.getUTCDate() + 7 * n);
      break;
    case "MONTH":
      addMonths(date, n);
      break;
    case "YEAR":
      addMonths(date, 12 * n);
      break;
  }
  return date.toISOString();
}

function addMonths(date: Date, months: number): void {
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
}
