// Plain-language labels and number/date formatting for the dashboard. The API speaks in enums and
// ISO timestamps; a merchant should never have to read either.

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

export function formatMoney(money: { value: string; currency: string }): string {
  const amount = Number(money.value);
  if (!Number.isFinite(amount)) return `${money.value} ${money.currency}`;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: money.currency,
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${money.value} ${money.currency}`;
  }
}

/** 0.6667 → "67%"; null → a dash, for a rate with nothing to divide yet. */
export function formatPercent(ratio: number | null): string {
  return ratio === null ? "–" : `${Math.round(ratio * 100)}%`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "just now", "5 min ago", "3 h ago", "2 d ago"; older than a month falls back to the date. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} d ago`;
  return formatDate(iso);
}

export const REASON_LABELS: Record<string, string> = {
  price: "Too expensive",
  low_usage: "Not using it enough",
  missing_feature: "Missing a feature",
  quality_issue: "Quality problems",
  temporary: "Needs a break",
  switching_competitor: "Switching to a competitor",
  payment_problem: "Payment problem",
  other: "Something else",
  unknown: "No reason given",
};

export const OFFER_LABELS: Record<string, string> = {
  pause: "Pause",
  downgrade: "Cheaper plan",
  switch_annual: "Annual billing",
  discount: "Discount",
  refund_partial: "Partial refund",
  none: "Cancelled",
};

const STATUS: Record<string, { label: string; tone: Tone }> = {
  ACTIVE: { label: "Active", tone: "good" },
  SUSPENDED: { label: "Paused", tone: "warn" },
  APPROVAL_PENDING: { label: "Awaiting approval", tone: "warn" },
  APPROVED: { label: "Approved", tone: "info" },
  CANCELLED: { label: "Cancelled", tone: "bad" },
  EXPIRED: { label: "Expired", tone: "neutral" },
};

export function statusInfo(status: string): { label: string; tone: Tone } {
  return STATUS[status] ?? { label: humanize(status), tone: "neutral" };
}

const KINDS: Record<string, { label: string; tone: Tone }> = {
  "session.started": { label: "Cancel conversation started", tone: "info" },
  "session.closed": { label: "Conversation ended", tone: "neutral" },
  "session.cancel_requested": { label: "Cancel requested", tone: "bad" },
  "offer.presented": { label: "Offer shown", tone: "info" },
  "offer.accepted": { label: "Offer accepted", tone: "good" },
  "offer.declined": { label: "Offer declined", tone: "warn" },
  "action.created": { label: "Action created", tone: "info" },
  "action.state_changed": { label: "Action updated", tone: "neutral" },
  "notification.enqueued": { label: "Email queued", tone: "neutral" },
  "notification.sent": { label: "Email sent", tone: "good" },
  "notification.suppressed": { label: "Email held back", tone: "warn" },
  "notification.failed": { label: "Email failed", tone: "bad" },
  "portal.link_sent": { label: "Sign-in link sent", tone: "neutral" },
  "portal.signed_in": { label: "Subscriber signed in", tone: "neutral" },
  "policy.published": { label: "Policy published", tone: "info" },
  "insight.fallback_used": { label: "Fallback used", tone: "warn" },
  "api_key.created": { label: "API key created", tone: "info" },
  "api_key.revoked": { label: "API key revoked", tone: "warn" },
  "insight_action.proposed": { label: "Action proposed", tone: "info" },
  "insight_action.approved": { label: "Action approved", tone: "good" },
  "insight_action.rejected": { label: "Action rejected", tone: "warn" },
  "subscription.synced": { label: "Subscription synced", tone: "neutral" },
  "subscription.status_changed": { label: "Status changed", tone: "info" },
  "subscription.plan_changed": { label: "Plan changed", tone: "info" },
  "subscription.payment_failed": { label: "Payment failed", tone: "bad" },
  "subscription.payment_completed": { label: "Payment received", tone: "good" },
  "subscription.cancelled_externally": { label: "Cancelled in PayPal", tone: "bad" },
};

/** "session.cancel_requested" → "Cancel requested"; unknown kinds are made readable, not hidden. */
export function kindInfo(kind: string): { label: string; tone: Tone } {
  return KINDS[kind] ?? { label: humanize(kind.split(".").pop() ?? kind), tone: "neutral" };
}

/** "low_usage" → "Low usage". */
export function humanize(value: string): string {
  const spaced = value
    .replace(/[_.-]+/g, " ")
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function riskTone(band: "low" | "medium" | "high"): Tone {
  return band === "high" ? "bad" : band === "medium" ? "warn" : "good";
}

/** How an Action's state reads: done, failed, waiting on someone, or simply in progress. */
export function actionTone(state: string): Tone {
  switch (state) {
    case "CONFIRMED":
    case "APPLIED":
      return "good";
    case "FAILED":
      return "bad";
    case "AWAITING_BUYER":
    case "ABANDONED":
      return "warn";
    case "SUPERSEDED":
      return "neutral";
    default:
      return "info";
  }
}

/** A menu of offers as plain words, with repeats counted: three pauses read "Pause ×3". */
export function summariseOffers(kinds: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts]
    .map(([kind, n]) => `${OFFER_LABELS[kind] ?? humanize(kind)}${n > 1 ? ` ×${n}` : ""}`)
    .join(" · ");
}
