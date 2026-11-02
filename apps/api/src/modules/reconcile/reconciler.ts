import { and, eq, gt, gte, inArray, isNull, lt, ne, notExists, or, sql } from "drizzle-orm";
import type { ListSubscriptionsQuery, Page, PayPalSubscription } from "@keepwell/contracts";
import { actions, driftReports, merchants, subscriptions, type Db } from "@keepwell/db";
import type { DbActionEngine } from "../actions/engine.js";
import type { Jobs } from "../jobs/jobs.js";
import type { SubscriptionSync } from "./sync.js";

// The safety net for everything webhooks miss (ARCHITECTURE.md §6.3), all driven from one
// every-minute job, due.sweep:
// - every minute, the due work: Actions to run or retry, lost workers' Actions, resumes that came
//   due, revise links nobody used, APPLIED Actions to confirm, and any due work modules register;
// - every 2 minutes, the hot loop: re-sync subscriptions with an Action in flight or recent activity;
// - each merchant's sweep, once its last one is 30 minutes old: what PayPal says changed since;
// - each merchant's drift report, once a day from 03:00 UTC (target zero).
// Sweeps and drift go by age, not by clock slot, so a server that slept (Render's free plan)
// catches up on its first minute awake.
// Each piece is its own job with an idempotency key, so a slow run or a second instance never
// doubles the work.

export interface ReconcilePayPal {
  listSubscriptions(merchantId: string, query: ListSubscriptionsQuery): Promise<Page<PayPalSubscription>>;
}

export interface ReconcilerLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ReconcilerOptions {
  db: Db;
  paypal: ReconcilePayPal;
  sync: SubscriptionSync;
  engine: DbActionEngine;
  /** Only send is used: every piece of work becomes its own idempotent job. */
  jobs: Pick<Jobs, "send">;
  log: ReconcilerLogger;
  clock?: () => Date;
}

const OPEN_STATES = ["PENDING", "EXECUTING", "RETRY_WAIT", "AWAITING_BUYER", "APPLIED"] as const;
const HOUR = 60 * 60_000;
/** The sweep looks a little further back than the last one, so a change at the boundary isn't missed. */
const SWEEP_OVERLAP_MS = 5 * 60_000;
/** APPLIED this long ago and still not confirmed: ask PayPal directly. */
const CONFIRM_AFTER_MS = 2 * 60_000;
const SWEEP_EVERY_MS = 30 * 60_000;

export class Reconciler {
  private readonly dueWork = new Map<string, () => Promise<void>>();
  private readonly clock: () => Date;

  constructor(private readonly o: ReconcilerOptions) {
    this.clock = o.clock ?? (() => new Date());
  }

  /** Other modules' due work (dunning sends, win-back sends) runs on the same minute. */
  registerDueWork(name: string, fn: () => Promise<void>): void {
    if (this.dueWork.has(name)) throw new Error(`Due work "${name}" is already registered`);
    this.dueWork.set(name, fn);
  }

  /** The due.sweep job: everything that should already have happened, made to happen. */
  async dueSweep(): Promise<void> {
    const now = this.clock();
    const { engine, jobs } = this.o;
    await engine.recoverStuck();
    for (const id of await engine.runDueResumes()) await jobs.send("action.execute", { actionId: id });
    for (const { actionId } of await engine.due()) await jobs.send("action.execute", { actionId });
    await engine.abandonStaleApprovals();
    for (const actionId of await this.unconfirmed(now)) await jobs.send("action.confirm", { actionId });

    if (now.getUTCMinutes() % 2 === 0) await this.hotLoop();
    // By age, not by clock slot: a server that slept through :00 and :30 (Render's free plan) sweeps
    // as soon as it wakes, and a drift report missed at night runs on the next morning's first minute.
    for (const merchantId of await this.dueForSweep(now)) await jobs.send("reconcile.sweep", { merchantId });
    if (now.getUTCHours() >= 3) {
      for (const merchantId of await this.dueForDrift(now))
        await jobs.send("reconcile.drift", { merchantId });
    }
    for (const [name, fn] of this.dueWork) {
      // One module's failure mustn't stop the others' due work.
      await fn().catch((err: unknown) => this.o.log.error({ err, dueWork: name }, "due work failed"));
    }
  }

  /**
   * Subscriptions worth a fresh look: an Action still in flight, or one that moved this hour, so the
   * webhook that should confirm it can't be missed (a buyer who approved a revise and closed the tab).
   */
  async hotLoop(): Promise<number> {
    const since = new Date(this.clock().getTime() - HOUR);
    const hot = await this.o.db.acrossMerchants((tx) =>
      tx
        .selectDistinct({ id: actions.subscriptionId })
        .from(actions)
        .where(or(inArray(actions.state, OPEN_STATES), gt(actions.updatedAt, since))),
    );
    const ids = hot.flatMap((r) => (r.id === null ? [] : [r.id]));
    for (const subscriptionId of ids) await this.o.jobs.send("reconcile.subscription", { subscriptionId });
    return ids.length;
  }

  /** The reconcile.subscription job. */
  async syncOne(subscriptionId: string): Promise<void> {
    const [row] = await this.o.db.acrossMerchants((tx) =>
      tx
        .select({ merchantId: subscriptions.merchantId, paypalId: subscriptions.paypalSubscriptionId })
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId)),
    );
    if (row) await this.o.sync.sync(row.merchantId, row.paypalId);
  }

  /** The reconcile.sweep job: every subscription PayPal says changed since this merchant's last sweep. */
  async sweep(merchantId: string): Promise<number> {
    const startedAt = this.clock();
    const [merchant] = await this.o.db.forMerchant(merchantId, (tx) =>
      tx.select({ lastSweepAt: merchants.lastSweepAt }).from(merchants).where(eq(merchants.id, merchantId)),
    );
    if (!merchant) return 0;
    const after = merchant.lastSweepAt ? new Date(merchant.lastSweepAt.getTime() - SWEEP_OVERLAP_MS) : null;
    let synced = 0;
    for (let page = 1; ; page++) {
      const result = await this.o.paypal.listSubscriptions(merchantId, {
        page,
        ...(after && { statusUpdatedAfter: after.toISOString() }),
      });
      for (const subscription of result.items) {
        await this.o.sync.sync(merchantId, subscription.id);
        synced++;
      }
      if (result.items.length === 0 || page >= (result.totalPages ?? page)) break;
    }
    await this.o.db.forMerchant(merchantId, (tx) =>
      tx.update(merchants).set({ lastSweepAt: startedAt }).where(eq(merchants.id, merchantId)),
    );
    this.o.log.info({ merchantId, synced }, "reconcile sweep");
    return synced;
  }

  /** The reconcile.drift job: compare every live subscription with PayPal, then record the result. */
  async drift(merchantId: string): Promise<{ checked: number; drifted: number }> {
    const live = await this.o.db.forMerchant(merchantId, (tx) =>
      tx
        .select({ paypalId: subscriptions.paypalSubscriptionId })
        .from(subscriptions)
        .where(and(eq(subscriptions.merchantId, merchantId), ne(subscriptions.status, "CANCELLED"))),
    );
    const details: Record<string, string[]> = {};
    for (const { paypalId } of live) {
      try {
        const fields = await this.o.sync.checkDrift(merchantId, paypalId);
        if (fields.length > 0) details[paypalId] = fields;
      } catch (err) {
        this.o.log.warn({ err, merchantId, paypalId }, "drift check could not read a subscription");
      }
    }
    const drifted = Object.keys(details).length;
    await this.o.db.forMerchant(merchantId, (tx) =>
      tx
        .insert(driftReports)
        .values({ merchantId, checked: live.length, drifted, details, ranAt: this.clock() }),
    );
    if (drifted > 0) this.o.log.warn({ merchantId, drifted, details }, "reconciler found drift");
    return { checked: live.length, drifted };
  }

  private async unconfirmed(now: Date): Promise<string[]> {
    const before = new Date(now.getTime() - CONFIRM_AFTER_MS);
    const rows = await this.o.db.acrossMerchants((tx) =>
      tx
        .select({ id: actions.id })
        .from(actions)
        .where(and(eq(actions.state, "APPLIED"), lt(actions.updatedAt, before)))
        .limit(100),
    );
    return rows.map((r) => r.id);
  }

  /** Merchants never swept, or swept more than 30 minutes ago. */
  private async dueForSweep(now: Date): Promise<string[]> {
    const before = new Date(now.getTime() - SWEEP_EVERY_MS);
    const rows = await this.o.db.acrossMerchants((tx) =>
      tx
        .select({ id: merchants.id })
        .from(merchants)
        .where(or(isNull(merchants.lastSweepAt), lt(merchants.lastSweepAt, before))),
    );
    return rows.map((r) => r.id);
  }

  /** Merchants with no drift report yet today (UTC). */
  private async dueForDrift(now: Date): Promise<string[]> {
    const today = new Date(now.toISOString().slice(0, 10) + "T00:00:00Z");
    const rows = await this.o.db.acrossMerchants((tx) =>
      tx
        .select({ id: merchants.id })
        .from(merchants)
        .where(
          notExists(
            tx
              .select({ one: sql`1` })
              .from(driftReports)
              .where(and(eq(driftReports.merchantId, merchants.id), gte(driftReports.ranAt, today))),
          ),
        ),
    );
    return rows.map((r) => r.id);
  }
}
