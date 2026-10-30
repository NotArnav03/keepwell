import { PolicyContext, type PolicyDocument, type SubscriptionSnapshot } from "@keepwell/contracts";
import { pantryPlanPolicy } from "./defaults.js";

// Pantry Plan test data (CONTRACTS.md §6). Test-only: excluded from the build.

export const NOW = "2026-10-29T10:00:00.000Z";
export const usd = (value: string) => ({ value, currency: "USD" });
export const PLAN_IDS = { lite: "P-LITE", standard: "P-STANDARD", standardAnnual: "P-ANNUAL" };

export const plans = [
  { planId: "P-LITE", name: "Lite", price: usd("6.00"), interval: { unit: "MONTH", count: 1 } },
  { planId: "P-STANDARD", name: "Standard", price: usd("12.00"), interval: { unit: "MONTH", count: 1 } },
  {
    planId: "P-ANNUAL",
    name: "Standard Annual",
    price: usd("120.00"),
    interval: { unit: "YEAR", count: 1 },
  },
] as const;

/** Maya: ACTIVE on Standard for 8 months, paid yesterday, next billing in 30 days. */
export const maya: SubscriptionSnapshot = {
  id: "01972f3e-8c4a-7b1e-9d2a-000000000001",
  merchantId: "01972f3e-8c4a-7b1e-9d2a-3f4b5c6d7e8f",
  paypalSubscriptionId: "I-BW452GLLEP1G",
  paypalPlanId: "P-STANDARD",
  planName: "Standard",
  price: usd("12.00"),
  priceOverride: null,
  interval: { unit: "MONTH", count: 1 },
  status: "ACTIVE",
  startedAt: "2026-02-28T10:00:00Z",
  nextBillingTime: "2026-11-28T10:00:00Z",
  lastPayment: { amount: usd("12.00"), time: "2026-10-28T10:00:00Z" },
  outstandingBalance: null,
  failedPaymentsCount: 0,
  lastFailure: null,
  subscriberFirstName: "Maya",
  syncedAt: NOW,
};

export const policy: PolicyDocument = pantryPlanPolicy(PLAN_IDS);

type Overrides = Omit<Partial<PolicyContext>, "subscription" | "history"> & {
  subscription?: Partial<SubscriptionSnapshot>;
  history?: Partial<PolicyContext["history"]>;
};

/** A valid context for Maya at NOW with reason "unknown", plus overrides. */
export function context(overrides: Overrides = {}): PolicyContext {
  const { subscription, history, ...rest } = overrides;
  return PolicyContext.parse({
    now: NOW,
    channel: "widget",
    reason: "unknown",
    cancelIntent: false,
    offersPresentedThisSession: 0,
    plans,
    ...rest,
    subscription: { ...maya, ...subscription },
    history: {
      savesLast365d: 0,
      pausesLast365d: 0,
      lastPauseEndedAt: null,
      refundedLast30d: usd("0.00"),
      ...history,
    },
  });
}

type Offers = PolicyDocument["offers"];

/** `policy` with some offer settings replaced. */
export function withOffers(patch: { [K in keyof Offers]?: Partial<Offers[K]> }): PolicyDocument {
  const o = policy.offers;
  return {
    ...policy,
    offers: {
      pause: { ...o.pause, ...patch.pause },
      downgrade: { ...o.downgrade, ...patch.downgrade },
      switch_annual: { ...o.switch_annual, ...patch.switch_annual },
      discount: { ...o.discount, ...patch.discount },
      refund_partial: { ...o.refund_partial, ...patch.refund_partial },
    },
  };
}
