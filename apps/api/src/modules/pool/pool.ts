import { and, asc, count, eq, inArray, lt } from "drizzle-orm";
import type {
  Action,
  JudgePool,
  PoolLease,
  PoolReturn,
  PoolState,
  SubscriptionSnapshot,
} from "@keepwell/contracts";
import {
  actions,
  merchants,
  plans,
  poolSubscriptions,
  scheduledResumes,
  subscriptions,
  type Db,
} from "@keepwell/db";
import type { DbActionEngine } from "../actions/engine.js";
import type { DbAudit } from "../audit/log.js";
import type { SubscriptionSync } from "../reconcile/sync.js";

// The judge pool (ARCHITECTURE.md §6.17): pre-approved sandbox subscriptions that Judge Mode lends
// out, because only a buyer can approve a subscription and judges arrive with none.
//
// A returned subscription is judged by PayPal's state, read fresh, never by what the judge says
// happened: cancelled or moved to another plan → consumed; paused → activate; discounted → the
// plan price back. Those fixes are Actions, so they retry, serialise and audit like any other;
// the entry is "restoring" until PayPal shows it whole again. The pool.health job does the rest:
// it takes back expired leases, finishes restores, and alerts below 40 available.

/** Below this many available, pool.health logs an error (Sentry's alert). */
export const POOL_LOW_WATER = 40;
const LEASE_MINUTES = 30;
const OPEN_STATES = ["PENDING", "EXECUTING", "RETRY_WAIT", "AWAITING_BUYER", "APPLIED"] as const;
const FAILED_STATES: readonly Action["state"][] = ["FAILED", "SUPERSEDED", "ABANDONED"];

export interface PoolLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface PoolOptions {
  db: Db;
  engine: Pick<DbActionEngine, "create">;
  sync: Pick<SubscriptionSync, "sync">;
  audit: Pick<DbAudit, "append">;
  log: PoolLogger;
  clock?: () => Date;
  /** The plan every pooled subscription is on; a subscription on any other plan was downgraded. */
  planName?: string;
}

export class PoolEntryNotFound extends Error {
  constructor(poolEntryId: string) {
    super(`No pool entry ${poolEntryId}`);
  }
}

type Why = "returned" | "expired" | "restoring";

export class DbJudgePool implements JudgePool {
  private readonly clock: () => Date;
  private readonly planName: string;

  constructor(private readonly o: PoolOptions) {
    this.clock = o.clock ?? (() => new Date());
    this.planName = o.planName ?? "Standard";
  }

  async lease(merchantId: string, input: { minutes?: number } = {}): Promise<PoolLease | null> {
    const leasedUntil = new Date(this.clock().getTime() + (input.minutes ?? LEASE_MINUTES) * 60_000);
    return this.o.db.forMerchant(merchantId, async (tx) => {
      // SKIP LOCKED: two judges arriving together get two different subscriptions.
      const [entry] = await tx
        .select({
          id: poolSubscriptions.id,
          subscriptionId: subscriptions.id,
          paypalSubscriptionId: subscriptions.paypalSubscriptionId,
        })
        .from(poolSubscriptions)
        .innerJoin(subscriptions, eq(subscriptions.id, poolSubscriptions.subscriptionId))
        .where(
          and(
            eq(poolSubscriptions.merchantId, merchantId),
            eq(poolSubscriptions.state, "available"),
            eq(subscriptions.status, "ACTIVE"),
          ),
        )
        .orderBy(asc(poolSubscriptions.createdAt))
        .limit(1)
        .for("update", { of: poolSubscriptions, skipLocked: true });
      if (!entry) return null;
      await tx
        .update(poolSubscriptions)
        .set({ state: "leased", leasedUntil })
        .where(eq(poolSubscriptions.id, entry.id));
      const lease = {
        poolEntryId: entry.id,
        subscriptionId: entry.subscriptionId,
        paypalSubscriptionId: entry.paypalSubscriptionId,
        leasedUntil: leasedUntil.toISOString(),
      };
      await this.o.audit.append(
        {
          merchantId,
          actor: "demo",
          kind: "pool.leased",
          subjectIds: subjects(lease),
          payload: { leasedUntil: lease.leasedUntil },
        },
        tx,
      );
      return lease;
    });
  }

  release(merchantId: string, poolEntryId: string): Promise<PoolReturn> {
    return this.settle(merchantId, poolEntryId, "returned");
  }

  async counts(merchantId: string): Promise<Record<PoolState, number>> {
    const rows = await this.o.db.forMerchant(merchantId, (tx) =>
      tx
        .select({ state: poolSubscriptions.state, n: count() })
        .from(poolSubscriptions)
        .where(eq(poolSubscriptions.merchantId, merchantId))
        .groupBy(poolSubscriptions.state),
    );
    const counts: Record<PoolState, number> = { available: 0, leased: 0, restoring: 0, consumed: 0 };
    for (const row of rows) counts[row.state] = row.n;
    return counts;
  }

  /**
   * Adds an approved subscription to the pool (pool refill). It must be ACTIVE on the pool's plan,
   * as PayPal shows it now. Returns false when it was already pooled.
   */
  async enroll(merchantId: string, paypalSubscriptionId: string): Promise<boolean> {
    const snapshot = await this.o.sync.sync(merchantId, paypalSubscriptionId);
    const planId = await this.poolPlanId(merchantId);
    if (snapshot.status !== "ACTIVE" || snapshot.paypalPlanId !== planId) {
      throw new Error(
        `${paypalSubscriptionId} is ${snapshot.status} on ${snapshot.planName}; the pool takes ACTIVE ${this.planName} subscriptions`,
      );
    }
    return this.o.db.forMerchant(merchantId, async (tx) => {
      const [row] = await tx
        .insert(poolSubscriptions)
        .values({ merchantId, subscriptionId: snapshot.id })
        .onConflictDoNothing({ target: poolSubscriptions.subscriptionId })
        .returning({ id: poolSubscriptions.id });
      if (!row) return false;
      await this.o.audit.append(
        {
          merchantId,
          actor: "system",
          kind: "pool.enrolled",
          subjectIds: { poolEntryId: row.id, subscriptionId: snapshot.id, paypalSubscriptionId },
          payload: {},
        },
        tx,
      );
      return true;
    });
  }

  /**
   * The pool.health job for one merchant: expired leases come back, restores finish, and a pool
   * running low is an error-level log. One bad entry doesn't stop the rest.
   */
  async sweep(merchantId: string): Promise<Record<PoolState, number>> {
    const now = this.clock();
    const due = await this.o.db.forMerchant(merchantId, (tx) =>
      tx
        .select({ id: poolSubscriptions.id, state: poolSubscriptions.state })
        .from(poolSubscriptions)
        .where(
          and(
            eq(poolSubscriptions.merchantId, merchantId),
            inArray(poolSubscriptions.state, ["leased", "restoring"]),
          ),
        ),
    );
    for (const entry of due) {
      const expired = entry.state === "leased";
      if (expired) {
        const [row] = await this.o.db.forMerchant(merchantId, (tx) =>
          tx
            .select({ id: poolSubscriptions.id })
            .from(poolSubscriptions)
            .where(and(eq(poolSubscriptions.id, entry.id), lt(poolSubscriptions.leasedUntil, now))),
        );
        if (!row) continue;
      }
      try {
        await this.settle(merchantId, entry.id, expired ? "expired" : "restoring");
      } catch (err) {
        // PayPal down or a sync error: the entry stays as it is and the next run tries again.
        this.o.log.warn({ err, merchantId, poolEntryId: entry.id }, "pool entry not settled");
      }
    }
    const counts = await this.counts(merchantId);
    if (counts.available < POOL_LOW_WATER) {
      this.o.log.error(
        { merchantId, ...counts },
        `judge pool below ${POOL_LOW_WATER} available: run pool refill`,
      );
    }
    return counts;
  }

  /** pool.health across every demo merchant. */
  async health(): Promise<void> {
    const demo = await this.o.db.acrossMerchants((tx) =>
      tx.select({ id: merchants.id }).from(merchants).where(eq(merchants.mode, "demo")),
    );
    for (const { id } of demo) await this.sweep(id);
  }

  // ---------- internals ----------

  private async settle(merchantId: string, poolEntryId: string, why: Why): Promise<PoolReturn> {
    const [entry] = await this.o.db.forMerchant(merchantId, (tx) =>
      tx
        .select({
          state: poolSubscriptions.state,
          leasedUntil: poolSubscriptions.leasedUntil,
          subscriptionId: subscriptions.id,
          paypalSubscriptionId: subscriptions.paypalSubscriptionId,
        })
        .from(poolSubscriptions)
        .innerJoin(subscriptions, eq(subscriptions.id, poolSubscriptions.subscriptionId))
        .where(and(eq(poolSubscriptions.id, poolEntryId), eq(poolSubscriptions.merchantId, merchantId))),
    );
    if (!entry) throw new PoolEntryNotFound(poolEntryId);
    if (entry.state === "available" || entry.state === "consumed") return entry.state;

    // PayPal's word, read now: the judge may have done anything, inside Keepwell or not.
    const snapshot = await this.o.sync.sync(merchantId, entry.paypalSubscriptionId);
    const planId = await this.poolPlanId(merchantId);

    return this.o.db.forMerchant(merchantId, async (tx) => {
      const [open] = await tx
        .select({ id: actions.id })
        .from(actions)
        .where(and(eq(actions.subscriptionId, entry.subscriptionId), inArray(actions.state, OPEN_STATES)))
        .limit(1);
      const fixes = needed(snapshot);
      let result: PoolReturn;
      if (isGone(snapshot, planId)) result = "consumed";
      // Something is still changing it (the judge's own pause, or our restore): look again later.
      else if (open) result = "restoring";
      else if (fixes.length === 0) result = "available";
      else {
        // One attempt per lease: the key repeats, so a restore that failed comes back FAILED.
        const lease = entry.leasedUntil?.toISOString() ?? "none";
        const created = [];
        for (const fix of fixes) {
          created.push(
            await this.o.engine.create(
              {
                merchantId,
                subscriptionId: entry.subscriptionId,
                origin: "demo",
                idempotencyKey: `pool:${poolEntryId}:${lease}:${fix}`,
                ...(fix === "activate"
                  ? { type: "activate", params: { reason: "Returned to the Keepwell judge pool" } }
                  : { type: "patch_price", params: { fixedPrice: null } }),
              },
              tx,
            ),
          );
        }
        result = created.some((a) => FAILED_STATES.includes(a.state)) ? "consumed" : "restoring";
      }

      if (why !== "restoring") {
        // The judge is done: a resume their pause scheduled must not fire on the next judge.
        await tx
          .update(scheduledResumes)
          .set({ status: "cancelled" })
          .where(
            and(
              eq(scheduledResumes.subscriptionId, entry.subscriptionId),
              inArray(scheduledResumes.status, ["waiting", "scheduled"]),
            ),
          );
      }
      await tx
        .update(poolSubscriptions)
        .set({ state: result, ...(result === "available" && { leasedUntil: null }) })
        .where(eq(poolSubscriptions.id, poolEntryId));
      if (result !== entry.state) {
        await this.o.audit.append(
          {
            merchantId,
            actor: why === "returned" ? "demo" : "system",
            kind: "pool.returned",
            subjectIds: subjects({ poolEntryId, ...entry }),
            payload: { why, result, status: snapshot.status, fixes },
          },
          tx,
        );
      }
      return result;
    });
  }

  private async poolPlanId(merchantId: string): Promise<string> {
    const [plan] = await this.o.db.forMerchant(merchantId, (tx) =>
      tx
        .select({ id: plans.paypalPlanId })
        .from(plans)
        .where(
          and(eq(plans.merchantId, merchantId), eq(plans.name, this.planName), eq(plans.status, "ACTIVE")),
        ),
    );
    if (!plan) throw new Error(`Merchant ${merchantId} has no ACTIVE "${this.planName}" plan: run pnpm seed`);
    return plan.id;
  }
}

function isGone(snapshot: SubscriptionSnapshot, poolPlanId: string): boolean {
  return (
    snapshot.status === "CANCELLED" || snapshot.status === "EXPIRED" || snapshot.paypalPlanId !== poolPlanId
  );
}

function needed(snapshot: SubscriptionSnapshot): ("activate" | "price")[] {
  const fixes: ("activate" | "price")[] = [];
  if (snapshot.status === "SUSPENDED") fixes.push("activate");
  if (snapshot.priceOverride !== null) fixes.push("price");
  return fixes;
}

function subjects(entry: { poolEntryId: string; subscriptionId: string; paypalSubscriptionId: string }) {
  return {
    poolEntryId: entry.poolEntryId,
    subscriptionId: entry.subscriptionId,
    paypalSubscriptionId: entry.paypalSubscriptionId,
  };
}
