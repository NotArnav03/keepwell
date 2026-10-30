import type { PlanInfo, PolicyDocument } from "../brain/policy.js";
import type { SubscriptionSnapshot } from "../platform/subscriptions.js";

// The fictional demo merchant for fakes, tests and the fake sessions server (CONTRACTS.md §6).
// Ids are fixed so runs are reproducible. None of this exists in PayPal.

const usd = (value: string) => ({ value, currency: "USD" });
const monthly = { unit: "MONTH", count: 1 } as const;

const lite: PlanInfo = { planId: "P-PANTRY-LITE", name: "Lite", price: usd("6.00"), interval: monthly };
const standard: PlanInfo = {
  planId: "P-PANTRY-STANDARD",
  name: "Standard",
  price: usd("12.00"),
  interval: monthly,
};
const annual: PlanInfo = {
  planId: "P-PANTRY-ANNUAL",
  name: "Standard Annual",
  price: usd("120.00"),
  interval: { unit: "YEAR", count: 1 },
};

// Same rules as packages/policy's pantryPlanPolicy, with these fake plan ids.
const policy: PolicyDocument = {
  version: 1,
  offers: {
    pause: { enabled: true, maxCycles: 3, cooldownDays: 90 },
    downgrade: { enabled: true, targets: { [standard.planId]: [lite.planId] } },
    switch_annual: { enabled: true, targets: { [standard.planId]: annual.planId } },
    discount: { enabled: true, maxPercent: 25, maxCycles: 3 },
    refund_partial: { enabled: true, maxPercentOfLastPayment: 50, maxPerMonth: usd("12.00") },
  },
  eligibility: { minTenureDaysForDiscount: 60, maxSavesPerSubscriberPer365d: 2 },
  reasonPreferences: {},
  tone: "warm",
  supportContact: "help@pantryplan.example",
};

export const PANTRY_PLAN = {
  merchantId: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
  name: "Pantry Plan",
  lite,
  standard,
  annual,
  plans: [lite, standard, annual],
  policy,
};

const DAY_MS = 86_400_000;

/**
 * Maya: on Standard for eight months, paid 10 days ago, next billing in 20. Times are relative to
 * `now`, so a long-running fake server never offers a pause that resumes in the past.
 */
export function pantryPlanSubscription(
  now: Date,
  overrides: Partial<SubscriptionSnapshot> = {},
): SubscriptionSnapshot {
  const daysFromNow = (days: number) => new Date(now.getTime() + days * DAY_MS).toISOString();
  return {
    id: "0199a1b2-c3d4-7e5f-8a6b-000000000001",
    merchantId: PANTRY_PLAN.merchantId,
    paypalSubscriptionId: "I-FAKEMAYA00001",
    paypalPlanId: standard.planId,
    planName: standard.name,
    price: standard.price,
    priceOverride: null,
    interval: standard.interval,
    status: "ACTIVE",
    startedAt: daysFromNow(-243),
    nextBillingTime: daysFromNow(20),
    lastPayment: { amount: standard.price, time: daysFromNow(-10) },
    outstandingBalance: null,
    failedPaymentsCount: 0,
    lastFailure: null,
    subscriberFirstName: "Maya",
    syncedAt: now.toISOString(),
    ...overrides,
  };
}
