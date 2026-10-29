import type { OfferKind, ReasonCategory } from "@keepwell/contracts";

// Built-in limits. These are NOT in the policy document: no merchant can turn them off.

/** PayPal applies a price change only to billings at least this many days away (spike Q4 checks it in sandbox). */
export const PRICE_CHANGE_MIN_DAYS = 10;

/** PayPal only refunds payments up to this old. */
export const REFUND_WINDOW_DAYS = 180;

/** Pause lengths offered, besides the policy's own maxCycles. */
export const PAUSE_CYCLES = [1, 2, 3] as const;

export type OfferableKind = Exclude<OfferKind, "none">;

/** Also the stable order of kinds in `excluded`. */
export const OFFERABLE_KINDS: readonly OfferableKind[] = [
  "pause",
  "downgrade",
  "switch_annual",
  "discount",
  "refund_partial",
];

/**
 * Used for a reason the merchant's policy doesn't rank. A ranking is also an allowlist: kinds not
 * in it are never offered for that reason, and "none" ends it. These lean towards not offering
 * something that doesn't fit the reason (no discount for a missing feature).
 */
export const DEFAULT_REASON_PREFERENCES: Readonly<Record<ReasonCategory, readonly OfferKind[]>> = {
  price: ["downgrade", "switch_annual", "discount", "pause"],
  low_usage: ["pause", "downgrade"],
  missing_feature: ["none"],
  quality_issue: ["refund_partial"],
  temporary: ["pause"],
  switching_competitor: ["discount", "downgrade"],
  payment_problem: ["pause", "downgrade"],
  other: ["pause", "downgrade", "discount"],
  unknown: ["pause", "downgrade", "switch_annual", "discount", "refund_partial"],
};

/** Stable rule ids for PolicyDecision.violations and the audit log. */
export const RULE = {
  cancelIntent: "builtin.cancel_intent",
  oneOfferPerSession: "builtin.one_offer_per_session",
  notActive: "builtin.subscription_not_active",
  noNextBilling: "builtin.no_next_billing",
  priceChangeTooSoon: "builtin.price_change_min_days",
  notCheaper: "builtin.not_cheaper",
  currencyMismatch: "builtin.currency_mismatch",
  alreadyDiscounted: "builtin.already_discounted",
  zeroPrice: "builtin.zero_price",
  noPayment: "builtin.no_payment_to_refund",
  refundTooOld: "builtin.refund_window",
  offerNotInMenu: "builtin.offer_not_in_menu",
  offerNotAllowedNow: "builtin.offer_not_allowed_now",
  policyVersion: "builtin.policy_version_mismatch",
  maxSaves: "eligibility.max_saves_per_365d",
  minTenure: "eligibility.min_tenure_for_discount",
  disabled: "policy.offer_disabled",
  noTarget: "policy.no_target_plan",
  badTarget: "policy.bad_target_plan",
  pauseCooldown: "policy.pause_cooldown",
  refundMonthlyCap: "policy.refund_monthly_cap",
  reasonPreferences: "policy.reason_preferences",
} as const;
export type RuleId = (typeof RULE)[keyof typeof RULE];
