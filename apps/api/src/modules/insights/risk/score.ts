import type { SubscriptionStatus } from "@keepwell/contracts";

// Churn-risk score (ARCHITECTURE.md §6.12, X5): a transparent weighted sum over signals PayPal and
// our own database already give us. It is a hand-set heuristic, not a trained model: nothing here
// learns, calls an LLM or draws a random number, so the same inputs always give the same score and
// every point can be explained to the merchant.

/**
 * Every weight in one table, each with the reason it is what it is. The numbers are judgement
 * calls, tuned so that the bands below read sensibly; change them here and the tests, the README
 * and the dashboard all follow.
 */
export const RISK_WEIGHTS = {
  /** Failed payments are the strongest PayPal-visible leading indicator: each one is a billing
   * cycle the subscriber did not pay for. Capped at three so a long dunning tail doesn't drown
   * every other signal. */
  failedPaymentPoints: 12,
  failedPaymentCap: 3,
  /** A failure this week is still unresolved and the subscriber is probably looking at the
   * problem now; an old one has either been fixed or given up on. */
  failureWithin7DaysPoints: 8,
  failureWithin30DaysPoints: 4,
  /** Money PayPal could not collect. A flat amount: the failure count already scales with severity. */
  outstandingBalancePoints: 8,
  /** Overdue relative to the billing interval (a yearly plan with a 40-day gap is normal; a
   * weekly plan is not). */
  overdue125Points: 6,
  overdue200Points: 12,
  /** Early-life churn: the first cycles are where most voluntary cancellations happen, before the
   * subscriber has formed a habit. */
  tenureUnder30DaysPoints: 12,
  tenureUnder90DaysPoints: 8,
  tenureUnder180DaysPoints: 4,
  /** A subscriber who already used a retention lever once has shown they are weighing the cost.
   * Downgrades weigh most (they already pay less and still wavered), then pauses, then discounts.
   * Each is capped at two so a serial saver is not scored without limit. */
  priorPausePoints: 6,
  priorDowngradePoints: 7,
  priorDiscountPoints: 5,
  priorSaveCap: 2,
  /** A plan change in the last 30 days means the subscription is in flux. */
  recentReviseDays: 30,
  recentRevisePoints: 8,
  /** Suspended means billing is already stopped; coming back is not guaranteed. */
  suspendedPoints: 15,
  /** A charge is imminent, which is when a cancel is most likely. Small: on its own it is not risk. */
  renewalSoonDays: 3,
  renewalSoonPoints: 4,
} as const;

export const RISK_BANDS = { mediumMin: 25, highMin: 50 } as const;

export type RiskBand = "low" | "medium" | "high";

export interface ChurnSignals {
  status: SubscriptionStatus;
  failedPaymentsCount: number;
  /** Null when there has been no failure. */
  daysSinceLastFailure: number | null;
  /** Decimal string such as "12.00", or null when nothing is owed. Never a float. */
  outstandingValue: string | null;
  /** Null when no payment has succeeded yet. */
  daysSinceLastPayment: number | null;
  /** Length of one billing cycle, to judge how overdue a payment is. */
  billingIntervalDays: number;
  tenureDays: number;
  priorPauses: number;
  priorDowngrades: number;
  priorDiscounts: number;
  /** An applied revise within RISK_WEIGHTS.recentReviseDays. */
  recentRevise: boolean;
  /** Null when no further billing is scheduled. */
  daysToNextBilling: number | null;
}

export interface RiskFactor {
  id: string;
  label: string;
  points: number;
  detail: string;
}

export interface ChurnRisk {
  score: number;
  band: RiskBand;
  factors: RiskFactor[];
}

const W = RISK_WEIGHTS;

/** Counts and day-gaps come from SQL, but a negative or NaN must not lower or poison a score. */
const nonNegative = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);
const whole = (n: number): number => Math.floor(nonNegative(n));
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** True when a decimal string is above zero, checked as text so no float is involved. */
function isPositiveDecimal(value: string | null): value is string {
  return value !== null && /^\d+(\.\d+)?$/.test(value) && /[1-9]/.test(value);
}

export function bandFor(score: number): RiskBand {
  if (score >= RISK_BANDS.highMin) return "high";
  if (score >= RISK_BANDS.mediumMin) return "medium";
  return "low";
}

export function scoreChurnRisk(input: ChurnSignals): ChurnRisk {
  const factors: RiskFactor[] = [];
  const add = (id: string, label: string, points: number, detail: string): void => {
    if (points > 0) factors.push({ id, label, points, detail });
  };

  const failures = whole(input.failedPaymentsCount);
  if (failures > 0) {
    const counted = Math.min(failures, W.failedPaymentCap);
    add(
      "failed_payments",
      "Failed payments",
      counted * W.failedPaymentPoints,
      `${plural(failures, "payment")} failed${failures > counted ? ` (counted up to ${counted})` : ""}.`,
    );
    if (input.daysSinceLastFailure !== null) {
      const days = whole(input.daysSinceLastFailure);
      const detail = `The last failure was ${plural(days, "day")} ago.`;
      if (days <= 7) add("recent_failure", "Recent failure", W.failureWithin7DaysPoints, detail);
      else if (days <= 30) add("recent_failure", "Recent failure", W.failureWithin30DaysPoints, detail);
    }
  }

  if (isPositiveDecimal(input.outstandingValue)) {
    add(
      "outstanding_balance",
      "Unpaid balance",
      W.outstandingBalancePoints,
      `${input.outstandingValue} is owed and PayPal has not collected it.`,
    );
  }

  if (input.daysSinceLastPayment !== null && input.billingIntervalDays > 0) {
    const days = whole(input.daysSinceLastPayment);
    const ratio = days / input.billingIntervalDays;
    const detail = `The last successful payment was ${plural(days, "day")} ago, on a ${plural(whole(input.billingIntervalDays), "day")} billing cycle.`;
    if (ratio >= 2) add("overdue_payment", "Payment overdue", W.overdue200Points, detail);
    else if (ratio >= 1.25) add("overdue_payment", "Payment overdue", W.overdue125Points, detail);
  }

  const tenure = whole(input.tenureDays);
  const tenurePoints =
    tenure < 30
      ? W.tenureUnder30DaysPoints
      : tenure < 90
        ? W.tenureUnder90DaysPoints
        : tenure < 180
          ? W.tenureUnder180DaysPoints
          : 0;
  add(
    "early_tenure",
    "New subscriber",
    tenurePoints,
    `Subscribed ${plural(tenure, "day")} ago; the early months have the highest cancellation rate.`,
  );

  const saved = (n: number): number => Math.min(whole(n), W.priorSaveCap);
  add(
    "prior_pauses",
    "Paused before",
    saved(input.priorPauses) * W.priorPausePoints,
    `Took ${plural(whole(input.priorPauses), "pause")} as a retention offer.`,
  );
  add(
    "prior_downgrades",
    "Downgraded before",
    saved(input.priorDowngrades) * W.priorDowngradePoints,
    `Took ${plural(whole(input.priorDowngrades), "downgrade")} as a retention offer.`,
  );
  add(
    "prior_discounts",
    "Discounted before",
    saved(input.priorDiscounts) * W.priorDiscountPoints,
    `Took ${plural(whole(input.priorDiscounts), "discount")} as a retention offer.`,
  );

  if (input.recentRevise) {
    add(
      "recent_revise",
      "Plan just changed",
      W.recentRevisePoints,
      `The plan was changed in the last ${W.recentReviseDays} days.`,
    );
  }
  if (input.status === "SUSPENDED") {
    add(
      "suspended",
      "Suspended",
      W.suspendedPoints,
      "Billing is paused; the subscription is not currently active.",
    );
  }
  if (
    input.daysToNextBilling !== null &&
    input.daysToNextBilling >= 0 &&
    input.daysToNextBilling <= W.renewalSoonDays
  ) {
    add(
      "renewal_soon",
      "Renewal imminent",
      W.renewalSoonPoints,
      `The next charge is in ${plural(whole(input.daysToNextBilling), "day")}.`,
    );
  }

  const raw = factors.reduce((sum, f) => sum + f.points, 0);
  const score = Math.min(100, Math.max(0, raw));
  // Biggest contributors first; id breaks ties so the order is stable.
  factors.sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
  return { score, band: bandFor(score), factors };
}
