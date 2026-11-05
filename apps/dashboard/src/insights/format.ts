import { InsightActionKind, ReasonCategory } from "@keepwell/contracts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const REASON_LABELS: Record<ReasonCategory, string> = {
  price: "Price",
  low_usage: "Low usage",
  missing_feature: "Missing feature",
  quality_issue: "Quality issue",
  temporary: "Temporary",
  switching_competitor: "Switching competitor",
  payment_problem: "Payment problem",
  other: "Other",
  unknown: "Unknown",
};

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  saved_pause: "Saved with a pause",
  saved_downgrade: "Saved with a downgrade",
  saved_annual: "Saved with annual billing",
  saved_discount: "Saved with a discount",
  saved_refund: "Saved with a refund",
  cancelled: "Cancelled",
  abandoned: "Abandoned",
  kept_without_offer: "Stayed without an offer",
  winback_reply: "Win-back reply",
  none: "No outcome",
};

const KIND_LABELS: Record<InsightActionKind, string> = {
  create_plan: "Create plan",
  update_policy: "Update policy",
  send_winback_batch: "Send win-back batch",
};

/** Inclusive UTC calendar days ending today. `days` of 30 is today and the 29 days before it. */
export function utcDateRange(days: number, now: Date = new Date()): { from: string; to: string } {
  const span = Math.max(1, Math.trunc(days));
  const toDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const fromDate = new Date(toDate.getTime() - (span - 1) * 86_400_000);
  return { from: fromDate.toISOString().slice(0, 10), to: toDate.toISOString().slice(0, 10) };
}

/** Format the UTC calendar day of an ISO date or timestamp, without shifting into a local zone. */
export function formatUtcDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const year = match[1];
  const month = MONTHS[Number(match[2]) - 1];
  const day = Number(match[3]);
  if (!year || !month || !Number.isInteger(day) || day < 1 || day > 31) return iso;
  return `${day} ${month} ${year}`;
}

/** Percentage of two counts the API already returned. Tenths stay in integer arithmetic. */
export function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "0%";
  const tenths = Math.round((numerator * 1000) / denominator);
  const whole = Math.trunc(tenths / 10);
  const frac = Math.abs(tenths % 10);
  if (frac === 0) return `${whole}%`;
  return `${whole}.${frac}%`;
}

/** Width of a bar in a 0–100 viewBox. The count itself is what the screen reader reads. */
export function barWidth(count: number, max: number): number {
  if (max <= 0 || count <= 0) return 0;
  return Math.max(1, Math.round((count / max) * 100));
}

export function maxCount(rows: readonly { count: number }[]): number {
  let max = 0;
  for (const row of rows) if (row.count > max) max = row.count;
  return max;
}

export function reasonLabel(reason: string): string {
  const known = ReasonCategory.safeParse(reason);
  if (!known.success) return reason.replaceAll("_", " ");
  return REASON_LABELS[known.data];
}

export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome.replaceAll("_", " ");
}

export function kindLabel(kind: string): string {
  const known = InsightActionKind.safeParse(kind);
  if (!known.success) return kind;
  return KIND_LABELS[known.data];
}

/** Money exactly as the API sent it. Anything that is not a decimal string is left unshown. */
export function moneyLabel(money: { value: string; currency: string } | null | undefined): string | null {
  if (!money) return null;
  if (!/^\d+\.\d{2}$/.test(money.value) || !/^[A-Za-z]{3}$/.test(money.currency)) return null;
  return `${money.value} ${money.currency}`;
}

export function moneyFromUnknown(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("value" in value) || !("currency" in value)) {
    return null;
  }
  const amount = value.value;
  const currency = value.currency;
  if (typeof amount !== "string" || typeof currency !== "string") return null;
  return moneyLabel({ value: amount, currency });
}

export function intervalLabel(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("unit" in value) || !("count" in value)) {
    return null;
  }
  const unit = value.unit;
  const count = value.count;
  if (typeof unit !== "string" || typeof count !== "number" || !Number.isInteger(count)) return null;
  return `${count} ${unit}`;
}

export function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value : null;
}
