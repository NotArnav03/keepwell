import type { PlanInfo } from "@keepwell/contracts";
import { PANTRY_PLAN } from "@keepwell/contracts/fakes";
import type {
  MerchantFixture,
  PlanRecord,
  SubscriptionRecord,
  SubscriptionStatus,
  TransactionRecord,
} from "./records.js";
import { addInterval, money, paypalTime, toCents, type PayPalMoney } from "./units.js";

// The fictional Pantry Plan merchant and its 12 subscribers (CONTRACTS.md §6). Ids match
// @keepwell/contracts/fakes, so FakeSessionsApi, the policy fixtures and this mock agree. Dates
// are relative to `now`, so a long-running dev server never shows a renewal in the past.

export const PANTRY_PLAN_CREDENTIALS = { clientId: "pantry-plan-mock-client", clientSecret: "mock-secret" };
export const PANTRY_PLAN_PRODUCT_ID = "PROD-PANTRYPLAN";

/** A one-dollar daily plan, so renewals and failures can be seen within a day (spike Q5). */
export const DAILY_PLAN: PlanInfo = {
  planId: "P-PANTRY-DAILY",
  name: "Daily test",
  price: { value: "1.00", currency: "USD" },
  interval: { unit: "DAY", count: 1 },
};

const DAY_MS = 86_400_000;

interface Subscriber {
  key: string;
  givenName: string;
  surname: string;
  plan: PlanInfo;
  status: SubscriptionStatus;
  /** Days from now to the next due cycle (negative = already passed). */
  nextCycleInDays: number;
  /** Completed payments before any failures. */
  paid: number;
  /** Consecutive failed renewals after those payments. */
  failed?: number;
  /** When the status last changed, in days ago; defaults to the start. */
  statusChangedDaysAgo?: number;
  /** A running discount (PATCHed fixed_price). */
  priceOverride?: string;
}

const SUBSCRIBERS: Subscriber[] = [
  // Pauses in the demo: on Standard for eight months, paid 10 days ago.
  {
    key: "maya",
    givenName: "Maya",
    surname: "Rao",
    plan: PANTRY_PLAN.standard,
    status: "ACTIVE",
    nextCycleInDays: 20,
    paid: 8,
  },
  // Two failed renewals: the recovery story.
  {
    key: "raj",
    givenName: "Raj",
    surname: "Mehta",
    plan: PANTRY_PLAN.standard,
    status: "ACTIVE",
    nextCycleInDays: 27,
    paid: 4,
    failed: 2,
  },
  // Paused through Keepwell 12 days ago.
  {
    key: "ana",
    givenName: "Ana",
    surname: "Silva",
    plan: PANTRY_PLAN.standard,
    status: "SUSPENDED",
    nextCycleInDays: 18,
    paid: 6,
    statusChangedDaysAgo: 12,
  },
  // Cancelled inside PayPal yesterday: the win-back story.
  {
    key: "tom",
    givenName: "Tom",
    surname: "Becker",
    plan: PANTRY_PLAN.standard,
    status: "CANCELLED",
    nextCycleInDays: 9,
    paid: 5,
    statusChangedDaysAgo: 1,
  },
  {
    key: "lena",
    givenName: "Lena",
    surname: "Novak",
    plan: PANTRY_PLAN.lite,
    status: "ACTIVE",
    nextCycleInDays: 25,
    paid: 3,
  },
  {
    key: "noor",
    givenName: "Noor",
    surname: "Haddad",
    plan: PANTRY_PLAN.annual,
    status: "ACTIVE",
    nextCycleInDays: 65,
    paid: 1,
  },
  // Two weeks in: too new for a discount (60-day tenure rule).
  {
    key: "priya",
    givenName: "Priya",
    surname: "Nair",
    plan: PANTRY_PLAN.standard,
    status: "ACTIVE",
    nextCycleInDays: 16,
    paid: 1,
  },
  // Already on a 25% discount.
  {
    key: "diego",
    givenName: "Diego",
    surname: "Torres",
    plan: PANTRY_PLAN.standard,
    status: "ACTIVE",
    nextCycleInDays: 22,
    paid: 6,
    priceOverride: "9.00",
  },
  {
    key: "kenji",
    givenName: "Kenji",
    surname: "Sato",
    plan: DAILY_PLAN,
    status: "ACTIVE",
    nextCycleInDays: 1,
    paid: 6,
  },
  // Clicked subscribe but never approved in PayPal.
  {
    key: "sara",
    givenName: "Sara",
    surname: "Lind",
    plan: PANTRY_PLAN.standard,
    status: "APPROVAL_PENDING",
    nextCycleInDays: 1,
    paid: 0,
  },
  // Suspended by PayPal after three failed renewals.
  {
    key: "ben",
    givenName: "Ben",
    surname: "Okafor",
    plan: PANTRY_PLAN.lite,
    status: "SUSPENDED",
    nextCycleInDays: 10,
    paid: 2,
    failed: 3,
    statusChangedDaysAgo: 2,
  },
  // Renews in 5 days: too close for a price change (10-day rule).
  {
    key: "chloe",
    givenName: "Chloe",
    surname: "Martin",
    plan: PANTRY_PLAN.standard,
    status: "ACTIVE",
    nextCycleInDays: 5,
    paid: 13,
  },
];

export function pantryPlanFixture(now: Date): MerchantFixture {
  const created = paypalTime(new Date(now.getTime() - 400 * DAY_MS));
  const plans = [PANTRY_PLAN.lite, PANTRY_PLAN.standard, PANTRY_PLAN.annual, DAILY_PLAN].map((p) =>
    planRecord(p, created),
  );
  const subscriptions: SubscriptionRecord[] = [];
  const transactions: TransactionRecord[] = [];
  const priceOverrides: Record<string, PayPalMoney> = {};

  for (const s of SUBSCRIBERS) {
    const built = buildSubscriber(s, now);
    subscriptions.push(built.subscription);
    transactions.push(...built.transactions);
    if (s.priceOverride) priceOverrides[built.subscription.id] = usd(s.priceOverride);
  }

  return {
    merchant: { id: PANTRY_PLAN.merchantId, name: PANTRY_PLAN.name, ...PANTRY_PLAN_CREDENTIALS },
    plans,
    subscriptions,
    priceOverrides,
    transactions,
  };
}

/** Our PayPal subscription id for a named fixture subscriber, e.g. "maya" → I-FAKEMAYA00001. */
export function fixtureSubscriptionId(key: string): string {
  return `I-FAKE${key.toUpperCase()}${"0".repeat(Math.max(0, 8 - key.length))}1`;
}

function buildSubscriber(s: Subscriber, now: Date) {
  const { unit, count } = s.plan.interval;
  const next = new Date(now.getTime() + s.nextCycleInDays * DAY_MS);
  const back = (cycles: number) => addInterval(next, unit, -cycles * count);
  const failed = s.failed ?? 0;
  const start = s.paid + failed > 0 ? back(s.paid + failed) : new Date(now.getTime() - DAY_MS);
  const id = fixtureSubscriptionId(s.key);
  const price = toCents(s.plan.price.value);
  const paidPrice = s.priceOverride ? toCents(s.priceOverride) : price;

  const transactions: TransactionRecord[] = [];
  for (let i = 0; i < s.paid; i++) {
    transactions.push({
      id: `${s.key.toUpperCase()}TXN${String(i + 1).padStart(14 - s.key.length, "0")}`,
      subscriptionId: id,
      status: "COMPLETED",
      grossCents: paidPrice,
      currency: "USD",
      refundedCents: 0,
      time: paypalTime(back(s.paid + failed - i)),
    });
  }
  const lastPayment = transactions.at(-1);
  const lastFailure = failed > 0 ? back(1) : null;
  const statusTime =
    s.statusChangedDaysAgo === undefined ? start : new Date(now.getTime() - s.statusChangedDaysAgo * DAY_MS);

  const subscription: SubscriptionRecord = {
    id,
    plan_id: s.plan.planId,
    status: s.status,
    status_update_time: paypalTime(statusTime),
    start_time: paypalTime(start),
    create_time: paypalTime(start),
    update_time: paypalTime(statusTime),
    quantity: "1",
    plan_overridden: s.priceOverride !== undefined,
    subscriber: {
      name: { given_name: s.givenName, surname: s.surname },
      email_address: `${s.key}@example.com`,
      payer_id: `${s.key.toUpperCase()}PAYER`.padEnd(13, "0"),
    },
  };
  if (s.status !== "APPROVAL_PENDING") {
    subscription.billing_info = {
      outstanding_balance: money(failed * price, "USD"),
      cycle_executions: [
        {
          tenure_type: "REGULAR",
          sequence: 1,
          cycles_completed: s.paid,
          cycles_remaining: 0,
          total_cycles: 0,
        },
      ],
      failed_payments_count: failed,
      ...(lastPayment && {
        last_payment: { amount: money(lastPayment.grossCents, "USD"), time: lastPayment.time },
      }),
      // Assumed: only an active subscription shows its next billing time.
      ...(s.status === "ACTIVE" && { next_billing_time: paypalTime(next) }),
      ...(lastFailure && {
        last_failed_payment: {
          amount: money(price, "USD"),
          time: paypalTime(lastFailure),
          reason_code: "PAYER_CANNOT_PAY",
          ...(s.status === "ACTIVE" && {
            next_payment_retry_time: paypalTime(new Date(lastFailure.getTime() + 5 * DAY_MS)),
          }),
        },
      }),
    };
  }
  return { subscription, transactions };
}

function planRecord(plan: PlanInfo, created: string): PlanRecord {
  return {
    id: plan.planId,
    product_id: PANTRY_PLAN_PRODUCT_ID,
    name: plan.name,
    status: "ACTIVE",
    description: `Pantry Plan ${plan.name}`,
    usage_type: "LICENSED",
    billing_cycles: [
      {
        frequency: { interval_unit: plan.interval.unit, interval_count: plan.interval.count },
        tenure_type: "REGULAR",
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: usd(plan.price.value), version: 1 },
      },
    ],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee_failure_action: "CONTINUE",
      payment_failure_threshold: 3,
    },
    create_time: created,
    update_time: created,
  };
}

function usd(value: string): PayPalMoney {
  return { currency_code: "USD", value };
}
