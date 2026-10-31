import { randomUUID } from "node:crypto";
import { invalidRequest, notFound, PayPalApiError, unprocessable } from "./errors.js";
import type {
  MerchantFixture,
  MerchantRecord,
  PlanRecord,
  SubscriptionRecord,
  TransactionRecord,
  WebhookEvent,
  WebhookRecord,
} from "./records.js";
import { addInterval, looseMoney, money, paypalId, paypalTime, toCents, type PayPalMoney } from "./units.js";

// The mock's whole world, in memory. Each mutation follows PayPal's status rules and announces
// itself through `onEvent`, which the server turns into signed webhook deliveries. Behaviour that
// the day-1 spikes (docs/spikes/) haven't confirmed yet is marked "assumed" in a comment.

const TOKEN_TTL_SECONDS = 32_400;
/** PayPal retries a failed renewal after about five days (spike Q5 will confirm). */
const RETRY_AFTER_DAYS = 5;

export type EventSink = (merchantId: string, event: WebhookEvent) => void;

interface MerchantState {
  merchant: MerchantRecord;
  plans: Map<string, PlanRecord>;
  subscriptions: Map<string, SubscriptionRecord>;
  priceOverrides: Map<string, PayPalMoney>;
  transactions: TransactionRecord[];
  webhooks: WebhookRecord[];
  events: Map<string, WebhookEvent>;
  /** PayPal-Request-Id → the first response, replayed for a repeat. */
  idempotency: Map<string, unknown>;
}

interface PendingRevision {
  merchantId: string;
  subscriptionId: string;
  planId: string;
  returnUrl: string | null;
  cancelUrl: string | null;
}

export interface ListQuery {
  page: number;
  pageSize: number;
}

export interface Page<T> {
  items: T[];
  totalItems: number;
  totalPages: number;
}

export class PayPalState {
  onEvent: EventSink = () => {};
  private merchants = new Map<string, MerchantState>();
  private tokens = new Map<string, { merchantId: string; expiresAt: number }>();
  private revisions = new Map<string, PendingRevision>();

  constructor(
    fixtures: MerchantFixture[],
    private readonly clock: () => Date,
  ) {
    this.load(fixtures);
  }

  /** Replaces everything with these fixtures; tokens, approvals and events are dropped too. */
  load(fixtures: MerchantFixture[]): void {
    this.merchants = new Map(
      structuredClone(fixtures).map((f) => [
        f.merchant.id,
        {
          merchant: f.merchant,
          plans: new Map(f.plans.map((p) => [p.id, p])),
          subscriptions: new Map(f.subscriptions.map((s) => [s.id, s])),
          priceOverrides: new Map(Object.entries(f.priceOverrides ?? {})),
          transactions: f.transactions,
          webhooks: [],
          events: new Map(),
          idempotency: new Map(),
        },
      ]),
    );
    this.tokens.clear();
    this.revisions.clear();
  }

  // ---------- OAuth ----------

  issueToken(clientId: string, clientSecret: string): { token: string; expiresIn: number } | null {
    const found = [...this.merchants.values()].find(
      (m) => m.merchant.clientId === clientId && m.merchant.clientSecret === clientSecret,
    );
    if (!found) return null;
    const token = `A21AA${randomUUID().replaceAll("-", "")}`;
    this.tokens.set(token, {
      merchantId: found.merchant.id,
      expiresAt: this.clock().getTime() + TOKEN_TTL_SECONDS * 1000,
    });
    return { token, expiresIn: TOKEN_TTL_SECONDS };
  }

  /** The merchant a bearer token belongs to, or null if it is unknown or expired. */
  merchantForToken(token: string): string | null {
    const entry = this.tokens.get(token);
    if (!entry || entry.expiresAt <= this.clock().getTime()) return null;
    return entry.merchantId;
  }

  /** Every issued token stops working, so tests can exercise refresh-on-401. */
  expireTokens(): void {
    this.tokens.clear();
  }

  // ---------- plans ----------

  listPlans(merchantId: string, productId: string | null, query: ListQuery): Page<PlanRecord> {
    const plans = [...this.of(merchantId).plans.values()].filter(
      (p) => productId === null || p.product_id === productId,
    );
    return paginate(plans, query);
  }

  getPlan(merchantId: string, planId: string): PlanRecord {
    const plan = this.of(merchantId).plans.get(planId);
    if (!plan) throw notFound(`Plan ${planId}`);
    return plan;
  }

  createPlan(
    merchantId: string,
    input: Omit<PlanRecord, "id" | "status" | "create_time" | "update_time"> & {
      status?: PlanRecord["status"];
    },
  ): PlanRecord {
    const now = this.now();
    const plan: PlanRecord = {
      ...input,
      id: `P-${paypalId(24)}`,
      status: input.status ?? "ACTIVE",
      create_time: now,
      update_time: now,
    };
    this.of(merchantId).plans.set(plan.id, plan);
    this.emit(merchantId, "BILLING.PLAN.CREATED", "plan", "A billing plan was created.", plan);
    return plan;
  }

  // ---------- subscriptions ----------

  getSubscription(merchantId: string, id: string): SubscriptionRecord {
    const subscription = this.of(merchantId).subscriptions.get(id);
    if (!subscription) throw notFound(`Subscription ${id}`);
    return subscription;
  }

  /** The plan as this subscriber pays it: the PATCHed `fixed_price` override, if any. */
  effectivePlan(merchantId: string, subscription: SubscriptionRecord): PlanRecord {
    const plan = this.getPlan(merchantId, subscription.plan_id);
    const override = this.of(merchantId).priceOverrides.get(subscription.id);
    if (!override) return plan;
    return {
      ...plan,
      billing_cycles: plan.billing_cycles.map((cycle) =>
        cycle.sequence === 1
          ? { ...cycle, pricing_scheme: { ...cycle.pricing_scheme, fixed_price: override } }
          : cycle,
      ),
    };
  }

  /**
   * GET /v1/billing/subscriptions, as ARCHITECTURE.md §6.3 uses it for the reconciler sweep.
   * Assumed shape until the sandbox confirms the list endpoint and its filters.
   */
  listSubscriptions(
    merchantId: string,
    filter: { planIds: string[] | null; statuses: string[] | null; statusUpdatedAfter: string | null },
    query: ListQuery,
  ): Page<SubscriptionRecord> {
    const after = filter.statusUpdatedAfter === null ? null : Date.parse(filter.statusUpdatedAfter);
    const matching = [...this.of(merchantId).subscriptions.values()].filter(
      (s) =>
        (filter.planIds === null || filter.planIds.includes(s.plan_id)) &&
        (filter.statuses === null || filter.statuses.includes(s.status)) &&
        (after === null || Date.parse(s.status_update_time) > after),
    );
    return paginate(matching, query);
  }

  suspend(merchantId: string, id: string): void {
    const subscription = this.getSubscription(merchantId, id);
    requireStatus(subscription, ["ACTIVE"], "suspend");
    this.setStatus(merchantId, subscription, "SUSPENDED");
  }

  activate(merchantId: string, id: string): void {
    const subscription = this.getSubscription(merchantId, id);
    requireStatus(subscription, ["SUSPENDED"], "activate");
    // Assumed (spike Q2): billing resumes on the original anchor; a date already passed moves
    // forward whole intervals, so nothing is charged at the moment of activation.
    const billing = subscription.billing_info;
    if (billing?.next_billing_time !== undefined) {
      const { interval_unit, interval_count } = this.cycleOf(merchantId, subscription).frequency;
      let next = new Date(billing.next_billing_time);
      while (next <= this.clock()) next = addInterval(next, interval_unit, interval_count);
      billing.next_billing_time = paypalTime(next);
    }
    this.setStatus(merchantId, subscription, "ACTIVE");
  }

  cancel(merchantId: string, id: string): void {
    const subscription = this.getSubscription(merchantId, id);
    requireStatus(subscription, ["ACTIVE", "SUSPENDED"], "cancel");
    if (subscription.billing_info) delete subscription.billing_info.next_billing_time;
    this.setStatus(merchantId, subscription, "CANCELLED");
  }

  /** Starts a plan change. Nothing changes until the buyer approves on the returned link. */
  revise(
    merchantId: string,
    id: string,
    planId: string,
    urls: { returnUrl: string | null; cancelUrl: string | null },
  ): string {
    const subscription = this.getSubscription(merchantId, id);
    requireStatus(subscription, ["ACTIVE", "SUSPENDED"], "revise");
    const plan = this.of(merchantId).plans.get(planId);
    if (!plan || plan.status !== "ACTIVE") {
      throw unprocessable("INVALID_PLAN_ID", `Plan ${planId} is not an active plan of this merchant.`);
    }
    const token = `BA-${paypalId(17)}`;
    this.revisions.set(token, { merchantId, subscriptionId: id, planId, ...urls });
    return token;
  }

  /** The buyer's answer on PayPal's approval page. Returns where PayPal would redirect them. */
  decideRevision(token: string, approve: boolean): string | null {
    const revision = this.revisions.get(token);
    if (!revision) throw notFound(`Approval token ${token}`);
    this.revisions.delete(token);
    const { merchantId, subscriptionId, planId } = revision;
    if (!approve) return withQuery(revision.cancelUrl, { subscription_id: subscriptionId, ba_token: token });
    const subscription = this.getSubscription(merchantId, subscriptionId);
    subscription.plan_id = planId;
    subscription.plan_overridden = false;
    this.of(merchantId).priceOverrides.delete(subscriptionId);
    this.touch(subscription);
    this.announce(
      merchantId,
      subscription,
      "BILLING.SUBSCRIPTION.UPDATED",
      "A billing subscription was updated.",
    );
    return withQuery(revision.returnUrl, { subscription_id: subscriptionId, ba_token: token });
  }

  /** PATCH with JSON Patch operations. Only the paths Keepwell uses are supported. */
  patch(merchantId: string, id: string, operations: { op: string; path: string; value?: unknown }[]): void {
    const subscription = this.getSubscription(merchantId, id);
    requireStatus(subscription, ["ACTIVE", "SUSPENDED"], "patch");
    const state = this.of(merchantId);
    for (const { op, path, value } of operations) {
      if (op !== "replace" && op !== "add") {
        throw unprocessable("INVALID_PATCH_OPERATION", `Operation ${op} is not supported for ${path}.`);
      }
      if (path === "/plan/billing_cycles/@sequence==1/pricing_scheme/fixed_price") {
        state.priceOverrides.set(id, parseMoney(value, path));
        subscription.plan_overridden = true;
      } else if (path === "/billing_info/outstanding_balance" && subscription.billing_info) {
        subscription.billing_info.outstanding_balance = parseMoney(value, path);
      } else if (path === "/custom_id" && typeof value === "string") {
        subscription.custom_id = value;
      } else {
        // The real API accepts more paths; the mock only knows the ones Keepwell sends.
        throw unprocessable("INVALID_PATCH_PATH", `The mock does not support PATCH ${path}.`);
      }
    }
    this.touch(subscription);
    this.announce(
      merchantId,
      subscription,
      "BILLING.SUBSCRIPTION.UPDATED",
      "A billing subscription was updated.",
    );
  }

  /** Charges the outstanding balance, as `POST …/capture` with capture_type OUTSTANDING_BALANCE. */
  capture(merchantId: string, id: string, amount: PayPalMoney): TransactionRecord {
    const subscription = this.getSubscription(merchantId, id);
    const billing = subscription.billing_info;
    const outstanding = billing ? toCents(billing.outstanding_balance.value) : 0;
    if (!billing || outstanding === 0) {
      throw unprocessable("ZERO_OUTSTANDING_BALANCE", "The subscription has no outstanding balance.");
    }
    const requested = toCents(amount.value);
    if (requested > outstanding) {
      throw unprocessable("INVALID_AMOUNT", "The amount is more than the outstanding balance.");
    }
    billing.outstanding_balance = money(outstanding - requested, amount.currency_code);
    if (outstanding === requested) billing.failed_payments_count = 0;
    const transaction = this.recordPayment(merchantId, subscription, requested, amount.currency_code);
    this.touch(subscription);
    return transaction;
  }

  transactions(merchantId: string, id: string, start: string, end: string): TransactionRecord[] {
    this.getSubscription(merchantId, id);
    const from = Date.parse(start);
    const to = Date.parse(end);
    return this.of(merchantId).transactions.filter(
      (t) => t.subscriptionId === id && Date.parse(t.time) >= from && Date.parse(t.time) <= to,
    );
  }

  /** Refunds part or all of a completed subscription payment. null refunds what is left. */
  refund(
    merchantId: string,
    transactionId: string,
    cents: number | null,
  ): { transaction: TransactionRecord; refundId: string; cents: number } {
    const transaction = this.of(merchantId).transactions.find((t) => t.id === transactionId);
    if (!transaction) throw notFound(`Transaction ${transactionId}`);
    const left = transaction.grossCents - transaction.refundedCents;
    if (transaction.status === "DECLINED" || left === 0) {
      throw unprocessable("TRANSACTION_ALREADY_REFUNDED", "Nothing is left to refund on this transaction.");
    }
    const amount = cents ?? left;
    if (amount <= 0 || amount > left) {
      throw unprocessable("REFUND_AMOUNT_EXCEEDED", "The refund is more than what is left to refund.");
    }
    transaction.refundedCents += amount;
    transaction.status =
      transaction.refundedCents === transaction.grossCents ? "REFUNDED" : "PARTIALLY_REFUNDED";
    const refundId = paypalId(17);
    this.emit(merchantId, "PAYMENT.SALE.REFUNDED", "refund", "A sale was refunded.", {
      id: refundId,
      state: "completed",
      amount: { total: money(amount, transaction.currency).value, currency: transaction.currency },
      sale_id: transaction.id,
      billing_agreement_id: transaction.subscriptionId,
      create_time: this.now(),
    });
    return { transaction, refundId, cents: amount };
  }

  // ---------- what PayPal does on its own (tests and /__mock drive these) ----------

  /** A renewal: charges the cycle price, or fails with `failReason` (e.g. PAYER_CANNOT_PAY). */
  renew(subscriptionId: string, failReason: string | null = null): void {
    const { merchantId, subscription } = this.find(subscriptionId);
    requireStatus(subscription, ["ACTIVE"], "renew");
    const billing = subscription.billing_info;
    if (!billing) throw unprocessable("SUBSCRIPTION_STATUS_INVALID", "The subscription has no billing info.");
    const cycle = this.cycleOf(merchantId, subscription);
    const price = cycle.pricing_scheme.fixed_price;
    const due = billing.next_billing_time ?? this.now();
    billing.next_billing_time = paypalTime(
      addInterval(new Date(due), cycle.frequency.interval_unit, cycle.frequency.interval_count),
    );

    if (failReason === null) {
      billing.failed_payments_count = 0;
      const execution = billing.cycle_executions[0];
      if (execution) execution.cycles_completed++;
      this.recordPayment(merchantId, subscription, toCents(price.value), price.currency_code);
      this.touch(subscription);
      return;
    }

    const now = this.clock();
    billing.failed_payments_count++;
    billing.outstanding_balance = money(
      toCents(billing.outstanding_balance.value) + toCents(price.value),
      price.currency_code,
    );
    billing.last_failed_payment = {
      amount: price,
      time: paypalTime(now),
      reason_code: failReason,
      next_payment_retry_time: paypalTime(addInterval(now, "DAY", RETRY_AFTER_DAYS)),
    };
    this.of(merchantId).transactions.push({
      id: paypalId(17),
      subscriptionId,
      status: "DECLINED",
      grossCents: toCents(price.value),
      currency: price.currency_code,
      refundedCents: 0,
      time: paypalTime(now),
    });
    this.touch(subscription);
    this.announce(
      merchantId,
      subscription,
      "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
      "Subscription payment failed.",
    );
    const threshold = this.getPlan(merchantId, subscription.plan_id).payment_preferences
      .payment_failure_threshold;
    if (threshold > 0 && billing.failed_payments_count >= threshold) {
      this.setStatus(merchantId, subscription, "SUSPENDED");
    }
  }

  /** The subscriber cancels from their PayPal account, without Keepwell (the win-back path). */
  cancelInPayPal(subscriptionId: string): void {
    const { merchantId } = this.find(subscriptionId);
    this.cancel(merchantId, subscriptionId);
  }

  // ---------- webhooks ----------

  registerWebhook(merchantId: string, url: string, eventTypes: string[]): WebhookRecord {
    const webhook = { id: paypalId(17), url, eventTypes };
    this.of(merchantId).webhooks.push(webhook);
    return webhook;
  }

  webhooks(merchantId: string): WebhookRecord[] {
    return this.of(merchantId).webhooks;
  }

  deleteWebhook(merchantId: string, id: string): void {
    const state = this.of(merchantId);
    const before = state.webhooks.length;
    state.webhooks = state.webhooks.filter((w) => w.id !== id);
    if (state.webhooks.length === before) throw notFound(`Webhook ${id}`);
  }

  /** The merchant that registered this webhook id, for signature verification. */
  merchantForWebhook(webhookId: string): string | null {
    for (const state of this.merchants.values()) {
      if (state.webhooks.some((w) => w.id === webhookId)) return state.merchant.id;
    }
    return null;
  }

  event(merchantId: string, eventId: string): WebhookEvent {
    const event = this.of(merchantId).events.get(eventId);
    if (!event) throw notFound(`Webhook event ${eventId}`);
    return event;
  }

  // ---------- idempotency ----------

  /** Runs `fn` once per PayPal-Request-Id; a repeat returns the first result without re-running. */
  idempotent<T>(merchantId: string, requestId: string | undefined, fn: () => T): T {
    return this.idempotentCall(merchantId, requestId, fn).result;
  }

  /** The same, also saying whether this was a replay: PayPal answers a replayed refund 200, not 201 (Q1). */
  idempotentCall<T>(
    merchantId: string,
    requestId: string | undefined,
    fn: () => T,
  ): { result: T; replayed: boolean } {
    if (requestId === undefined) return { result: fn(), replayed: false };
    const store = this.of(merchantId).idempotency;
    if (store.has(requestId)) return { result: store.get(requestId) as T, replayed: true };
    const result = fn();
    store.set(requestId, result);
    return { result, replayed: false };
  }

  // ---------- internals ----------

  private of(merchantId: string): MerchantState {
    const state = this.merchants.get(merchantId);
    // Tokens are only issued for known merchants, so this is a mock bug, not a client error.
    if (!state) throw new PayPalApiError(500, null, `Unknown merchant ${merchantId}`);
    return state;
  }

  private find(subscriptionId: string): { merchantId: string; subscription: SubscriptionRecord } {
    for (const [merchantId, state] of this.merchants) {
      const subscription = state.subscriptions.get(subscriptionId);
      if (subscription) return { merchantId, subscription };
    }
    throw notFound(`Subscription ${subscriptionId}`);
  }

  private cycleOf(merchantId: string, subscription: SubscriptionRecord) {
    const plan = this.effectivePlan(merchantId, subscription);
    const cycle = plan.billing_cycles.find((c) => c.tenure_type === "REGULAR") ?? plan.billing_cycles[0];
    if (!cycle) throw new PayPalApiError(500, null, `Plan ${plan.id} has no billing cycles`);
    return cycle;
  }

  private recordPayment(
    merchantId: string,
    subscription: SubscriptionRecord,
    cents: number,
    currency: string,
  ): TransactionRecord {
    const time = this.now();
    const transaction: TransactionRecord = {
      id: paypalId(17),
      subscriptionId: subscription.id,
      status: "COMPLETED",
      grossCents: cents,
      currency,
      refundedCents: 0,
      time,
    };
    this.of(merchantId).transactions.push(transaction);
    if (subscription.billing_info) {
      subscription.billing_info.last_payment = { amount: looseMoney(cents, currency), time };
    }
    this.emit(merchantId, "PAYMENT.SALE.COMPLETED", "sale", "Payment completed.", {
      id: transaction.id,
      state: "completed",
      amount: { total: money(cents, currency).value, currency },
      billing_agreement_id: subscription.id,
      create_time: time,
    });
    return transaction;
  }

  private setStatus(
    merchantId: string,
    subscription: SubscriptionRecord,
    status: SubscriptionRecord["status"],
  ) {
    subscription.status = status;
    subscription.status_update_time = this.now();
    const words = status.toLowerCase();
    this.touch(subscription);
    // PayPal names the event after the change, not the status: ACTIVE arrives as ACTIVATED.
    const eventType =
      status === "ACTIVE" ? "BILLING.SUBSCRIPTION.ACTIVATED" : `BILLING.SUBSCRIPTION.${status}`;
    this.announce(merchantId, subscription, eventType, `Subscription ${words}.`);
  }

  private touch(subscription: SubscriptionRecord): void {
    subscription.update_time = this.now();
  }

  private announce(
    merchantId: string,
    subscription: SubscriptionRecord,
    eventType: string,
    summary: string,
  ): void {
    this.emit(merchantId, eventType, "subscription", summary, subscription);
  }

  private emit(
    merchantId: string,
    eventType: string,
    resourceType: WebhookEvent["resource_type"],
    summary: string,
    resource: object,
  ): void {
    const event: WebhookEvent = {
      id: `WH-${paypalId(17)}`,
      event_version: "1.0",
      create_time: this.now(),
      resource_type: resourceType,
      resource_version: resourceType === "subscription" || resourceType === "plan" ? "2.0" : "1.0",
      event_type: eventType,
      summary,
      resource: structuredClone(resource) as Record<string, unknown>,
    };
    this.of(merchantId).events.set(event.id, event);
    this.onEvent(merchantId, event);
  }

  private now(): string {
    return paypalTime(this.clock());
  }
}

function requireStatus(
  subscription: SubscriptionRecord,
  allowed: SubscriptionRecord["status"][],
  action: string,
): void {
  if (!allowed.includes(subscription.status)) {
    throw unprocessable(
      "SUBSCRIPTION_STATUS_INVALID",
      `Invalid subscription status for ${action} action; subscription status should be ${allowed.join(" or ").toLowerCase()}.`,
    );
  }
}

function parseMoney(value: unknown, path: string): PayPalMoney {
  if (
    typeof value === "object" &&
    value !== null &&
    "currency_code" in value &&
    "value" in value &&
    typeof value.currency_code === "string" &&
    typeof value.value === "string" &&
    /^\d+(\.\d{1,2})?$/.test(value.value)
  ) {
    return { currency_code: value.currency_code, value: value.value };
  }
  throw invalidRequest("INVALID_PARAMETER_VALUE", `${path} needs { currency_code, value }.`);
}

function paginate<T>(items: T[], { page, pageSize }: ListQuery): Page<T> {
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    totalItems: items.length,
    totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
  };
}

function withQuery(url: string | null, params: Record<string, string>): string | null {
  if (url === null) return null;
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.toString();
}
