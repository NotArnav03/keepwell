import type { IntervalUnit, PayPalMoney } from "./units.js";

// What the mock stores, in PayPal's own JSON shapes (snake_case), so GET responses are the records
// themselves plus `links`. Fields Keepwell never reads are left out.

export type SubscriptionStatus =
  "APPROVAL_PENDING" | "APPROVED" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED";

export interface BillingCycle {
  frequency: { interval_unit: IntervalUnit; interval_count: number };
  tenure_type: "REGULAR" | "TRIAL";
  sequence: number;
  /** 0 means the cycle repeats until cancelled. */
  total_cycles: number;
  pricing_scheme: { fixed_price: PayPalMoney; version: number };
}

export interface PlanRecord {
  id: string;
  product_id: string;
  name: string;
  status: "CREATED" | "ACTIVE" | "INACTIVE";
  description: string;
  usage_type: "LICENSED";
  billing_cycles: BillingCycle[];
  payment_preferences: {
    auto_bill_outstanding: boolean;
    setup_fee_failure_action: "CONTINUE" | "CANCEL";
    /** Failed payments in a row before PayPal suspends the subscription. */
    payment_failure_threshold: number;
  };
  create_time: string;
  update_time: string;
}

export interface BillingInfo {
  outstanding_balance: PayPalMoney;
  cycle_executions: {
    tenure_type: "REGULAR";
    sequence: number;
    cycles_completed: number;
    cycles_remaining: number;
    total_cycles: number;
  }[];
  last_payment?: { amount: PayPalMoney; time: string };
  next_billing_time?: string;
  failed_payments_count: number;
  last_failed_payment?: {
    amount: PayPalMoney;
    time: string;
    reason_code: string;
    next_payment_retry_time?: string;
  };
}

export interface SubscriptionRecord {
  id: string;
  plan_id: string;
  status: SubscriptionStatus;
  status_update_time: string;
  start_time: string;
  create_time: string;
  update_time: string;
  quantity: string;
  plan_overridden: boolean;
  custom_id?: string;
  subscriber: {
    name: { given_name: string; surname: string };
    email_address: string;
    payer_id: string;
  };
  /** Absent until the buyer approves the subscription. */
  billing_info?: BillingInfo;
}

export interface TransactionRecord {
  id: string;
  subscriptionId: string;
  status: "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "REFUNDED";
  grossCents: number;
  currency: string;
  refundedCents: number;
  time: string;
}

export interface MerchantRecord {
  id: string;
  name: string;
  /** Mock credentials only; the OAuth endpoint checks them. */
  clientId: string;
  clientSecret: string;
}

export interface WebhookRecord {
  id: string;
  url: string;
  /** "*" subscribes to every event type. */
  eventTypes: string[];
}

export interface WebhookEvent {
  id: string;
  event_version: "1.0";
  create_time: string;
  resource_type: "subscription" | "sale" | "plan" | "refund";
  resource_version: string;
  event_type: string;
  summary: string;
  resource: Record<string, unknown>;
}

/** One merchant's starting state. Fixtures and tests build these. */
export interface MerchantFixture {
  merchant: MerchantRecord;
  plans: PlanRecord[];
  subscriptions: SubscriptionRecord[];
  /** Discount overrides set by an earlier PATCH, keyed by subscription id. */
  priceOverrides?: Record<string, PayPalMoney>;
  transactions: TransactionRecord[];
}
