import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { DomainEvents, Money, PayPalSubscription, SubscriptionSnapshot } from "@keepwell/contracts";
import { actions, plans, subscriptions, type Db, type Tx } from "@keepwell/db";
import type { PayPalPlan } from "../paypal/client.js";
import { toMoney } from "../paypal/money.js";

// Diff-of-truth (ARCHITECTURE.md §6.2–6.3): fetch the subscription from PayPal, store it as our
// snapshot, and emit domain events from what changed between the stored and the fetched version.
// Never from a webhook's event type, so out-of-order, duplicate and missing webhooks can't confuse
// anything: whatever triggers a sync, the events say what is true now. The webhook pipeline and
// the reconciler both call this.

export interface SyncPayPal {
  getSubscription(merchantId: string, paypalSubscriptionId: string): Promise<PayPalSubscription>;
  getPlan(merchantId: string, paypalPlanId: string): Promise<PayPalPlan>;
}

type SubscriptionRow = typeof subscriptions.$inferSelect;
type PlanRow = typeof plans.$inferSelect;

/** Statuses a Keepwell cancel counts for: a cancel underway or done means it wasn't PayPal-side. */
const OUR_CANCEL_STATES = ["PENDING", "EXECUTING", "RETRY_WAIT", "APPLIED", "CONFIRMED"] as const;

export class SubscriptionSync {
  constructor(
    private readonly db: Db,
    private readonly paypal: SyncPayPal,
    private readonly events: DomainEvents<Tx>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Syncs one subscription; returns the snapshot now stored. */
  async sync(merchantId: string, paypalSubscriptionId: string): Promise<SubscriptionSnapshot> {
    // PayPal is read outside any transaction: a slow call mustn't hold locks.
    const raw = await this.paypal.getSubscription(merchantId, paypalSubscriptionId);
    const plan = await this.planFor(merchantId, raw.plan_id);
    return this.db.forMerchant(merchantId, async (tx) => {
      const [previous] = await tx
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.merchantId, merchantId), eq(subscriptions.paypalSubscriptionId, raw.id)))
        .for("update");
      const fields = toColumns(raw, plan, this.clock());
      const [row] = previous
        ? await tx.update(subscriptions).set(fields).where(eq(subscriptions.id, previous.id)).returning()
        : await tx
            .insert(subscriptions)
            .values({ merchantId, paypalSubscriptionId: raw.id, ...fields })
            .returning();
      if (!row) throw new Error(`Could not store subscription ${raw.id}`);
      const snapshot = toSnapshot(row);
      await this.emitDiff(tx, previous, row, snapshot);
      return snapshot;
    });
  }

  private async emitDiff(
    tx: Tx,
    previous: SubscriptionRow | undefined,
    row: SubscriptionRow,
    snapshot: SubscriptionSnapshot,
  ): Promise<void> {
    const merchantId = row.merchantId;
    const subscriptionId = row.id;
    const emit = this.events.emit.bind(this.events);
    const changed = previous === undefined || meaningfulChange(previous, row);
    if (changed) {
      await emit({ type: "subscription.synced", merchantId, payload: { subscriptionId, snapshot } }, tx);
    }
    // First sight: nothing to compare with, so no change events.
    if (previous === undefined) return;

    if (previous.status !== row.status) {
      await emit(
        {
          type: "subscription.status_changed",
          merchantId,
          payload: { subscriptionId, from: previous.status, to: row.status },
        },
        tx,
      );
      if (row.status === "CANCELLED" && !(await this.cancelledByUs(tx, subscriptionId))) {
        await emit(
          { type: "subscription.cancelled_externally", merchantId, payload: { subscriptionId } },
          tx,
        );
      }
    }
    if (previous.paypalPlanId !== row.paypalPlanId) {
      await emit(
        {
          type: "subscription.plan_changed",
          merchantId,
          payload: { subscriptionId, fromPlanId: previous.paypalPlanId, toPlanId: row.paypalPlanId },
        },
        tx,
      );
    }
    if (row.failedPaymentsCount > previous.failedPaymentsCount && row.lastFailureReason !== null) {
      await emit(
        {
          type: "subscription.payment_failed",
          merchantId,
          payload: {
            subscriptionId,
            reasonCode: row.lastFailureReason,
            failedCount: row.failedPaymentsCount,
            nextRetryTime: row.nextRetryTime?.toISOString() ?? null,
          },
        },
        tx,
      );
    }
    const paidAgain =
      row.lastPaymentAt !== null &&
      (previous.lastPaymentAt === null || row.lastPaymentAt.getTime() > previous.lastPaymentAt.getTime());
    if (paidAgain && snapshot.lastPayment) {
      await emit(
        {
          type: "subscription.payment_completed",
          merchantId,
          payload: { subscriptionId, amount: snapshot.lastPayment.amount },
        },
        tx,
      );
    }
  }

  private async cancelledByUs(tx: Tx, subscriptionId: string): Promise<boolean> {
    const [ours] = await tx
      .select({ id: actions.id })
      .from(actions)
      .where(
        and(
          eq(actions.subscriptionId, subscriptionId),
          eq(actions.type, "cancel"),
          inArray(actions.state, OUR_CANCEL_STATES),
        ),
      )
      .limit(1);
    return ours !== undefined;
  }

  /** The plan's name, price and interval: from our `plans` table, else from PayPal (then stored). */
  private async planFor(merchantId: string, paypalPlanId: string): Promise<PlanRow> {
    const [known] = await this.db.forMerchant(merchantId, (tx) =>
      tx
        .select()
        .from(plans)
        .where(and(eq(plans.merchantId, merchantId), eq(plans.paypalPlanId, paypalPlanId))),
    );
    if (known) return known;
    const fetched = await this.paypal.getPlan(merchantId, paypalPlanId);
    const cycle = regularCycle(fetched.billing_cycles);
    const price = toMoney(cycle?.pricing_scheme?.fixed_price ?? { currency_code: "USD", value: "0" });
    return this.db.forMerchant(merchantId, async (tx) => {
      const [row] = await tx
        .insert(plans)
        .values({
          merchantId,
          paypalPlanId: fetched.id,
          productId: fetched.product_id ?? "",
          name: fetched.name,
          intervalUnit: cycle?.frequency.interval_unit ?? "MONTH",
          intervalCount: cycle?.frequency.interval_count ?? 1,
          priceValue: price.value,
          priceCurrency: price.currency,
          status:
            fetched.status === "INACTIVE" ? "INACTIVE" : fetched.status === "CREATED" ? "CREATED" : "ACTIVE",
          syncedAt: this.clock(),
        })
        .onConflictDoUpdate({
          target: [plans.merchantId, plans.paypalPlanId],
          set: { syncedAt: this.clock() },
        })
        .returning();
      if (!row) throw new Error(`Could not store plan ${fetched.id}`);
      return row;
    });
  }
}

function regularCycle(cycles: PayPalPlan["billing_cycles"]) {
  return cycles.find((c) => c.tenure_type === "REGULAR") ?? cycles[0];
}

/** The fields we keep, from PayPal's JSON. All money goes through toMoney (spike Q1's "1.0"). */
function toColumns(raw: PayPalSubscription, plan: PlanRow, now: Date) {
  const billing = raw.billing_info;
  const lastPayment = billing?.last_payment ? toMoney(billing.last_payment.amount) : null;
  const outstanding = billing?.outstanding_balance ? toMoney(billing.outstanding_balance) : null;
  const failure = billing?.last_failed_payment;
  const override = priceOverride(raw, plan);
  const email = raw.subscriber?.email_address;
  return {
    paypalPlanId: raw.plan_id,
    planName: plan.name,
    status: raw.status,
    intervalUnit: plan.intervalUnit,
    intervalCount: plan.intervalCount,
    priceValue: plan.priceValue,
    priceCurrency: plan.priceCurrency,
    overrideValue: override?.value ?? null,
    overrideCurrency: override?.currency ?? null,
    startedAt: new Date(raw.start_time ?? raw.create_time ?? now.toISOString()),
    nextBillingTime: billing?.next_billing_time ? new Date(billing.next_billing_time) : null,
    lastPaymentValue: lastPayment?.value ?? null,
    lastPaymentCurrency: lastPayment?.currency ?? null,
    lastPaymentAt: billing?.last_payment ? new Date(billing.last_payment.time) : null,
    outstandingValue: outstanding?.value ?? null,
    outstandingCurrency: outstanding?.currency ?? null,
    failedPaymentsCount: billing?.failed_payments_count ?? 0,
    lastFailureReason: failure?.reason_code ?? null,
    lastFailureAt: failure ? new Date(failure.time) : null,
    nextRetryTime: failure?.next_payment_retry_time ? new Date(failure.next_payment_retry_time) : null,
    // Only a hash of the email, to match a portal login; the subscriber's address isn't stored.
    subscriberEmailHash: email ? createHash("sha256").update(email.trim().toLowerCase()).digest("hex") : null,
    subscriberFirstName: raw.subscriber?.name?.given_name ?? null,
    snapshot: withoutContactDetails(raw),
    syncedAt: now,
  };
}

/** PayPal's JSON as stored: the subscriber's email and payer id are dropped, never kept (§10). */
function withoutContactDetails(raw: PayPalSubscription): PayPalSubscription {
  if (!raw.subscriber) return raw;
  const { email_address: _email, payer_id: _payer, ...subscriber } = raw.subscriber;
  return { ...raw, subscriber };
}

/** A discount's fixed_price, visible with fields=plan, when it differs from the plan's price. */
function priceOverride(raw: PayPalSubscription, plan: PlanRow): Money | null {
  if (!raw.plan_overridden) return null;
  const cycles = (raw as { plan?: { billing_cycles?: PayPalPlan["billing_cycles"] } }).plan?.billing_cycles;
  const fixed = cycles ? regularCycle(cycles)?.pricing_scheme?.fixed_price : undefined;
  if (!fixed) return null;
  const price = toMoney(fixed);
  return price.value === plan.priceValue && price.currency === plan.priceCurrency ? null : price;
}

const COMPARED: (keyof SubscriptionRow)[] = [
  "status",
  "paypalPlanId",
  "overrideValue",
  "nextBillingTime",
  "lastPaymentAt",
  "outstandingValue",
  "failedPaymentsCount",
  "lastFailureAt",
];

function meaningfulChange(a: SubscriptionRow, b: SubscriptionRow): boolean {
  return COMPARED.some((key) => {
    const x = a[key];
    const y = b[key];
    if (x instanceof Date && y instanceof Date) return x.getTime() !== y.getTime();
    return x !== y;
  });
}

export function toSnapshot(row: SubscriptionRow): SubscriptionSnapshot {
  const money = (value: string | null, currency: string | null): Money | null =>
    value !== null && currency !== null ? { value, currency } : null;
  const lastPaymentAmount = money(row.lastPaymentValue, row.lastPaymentCurrency);
  return {
    id: row.id,
    merchantId: row.merchantId,
    paypalSubscriptionId: row.paypalSubscriptionId,
    paypalPlanId: row.paypalPlanId,
    planName: row.planName,
    price: { value: row.priceValue, currency: row.priceCurrency },
    priceOverride: money(row.overrideValue, row.overrideCurrency),
    interval: { unit: row.intervalUnit, count: row.intervalCount },
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    nextBillingTime: row.nextBillingTime?.toISOString() ?? null,
    lastPayment:
      lastPaymentAmount && row.lastPaymentAt
        ? { amount: lastPaymentAmount, time: row.lastPaymentAt.toISOString() }
        : null,
    outstandingBalance: money(row.outstandingValue, row.outstandingCurrency),
    failedPaymentsCount: row.failedPaymentsCount,
    lastFailure:
      row.lastFailureReason !== null && row.lastFailureAt !== null
        ? {
            reasonCode: row.lastFailureReason,
            time: row.lastFailureAt.toISOString(),
            nextRetryTime: row.nextRetryTime?.toISOString() ?? null,
          }
        : null,
    subscriberFirstName: row.subscriberFirstName,
    syncedAt: row.syncedAt.toISOString(),
  };
}
