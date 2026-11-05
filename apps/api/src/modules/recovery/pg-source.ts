import { and, desc, eq } from "drizzle-orm";
import {
  StoredPolicy,
  type PayPalSubscription,
  type PlanInfo,
  type PolicyStore,
  type SubscriptionSnapshot,
} from "@keepwell/contracts";
import { plans, policies, subscriptions, type Db, type Tx } from "@keepwell/db";
import { toSnapshot } from "../reconcile/sync.js";
import type { PlanCatalog, SubscriptionSource } from "./ports.js";

// The real SubscriptionSource and PlanCatalog, on M1's read model.

export interface EmailGateway {
  getSubscription(merchantId: string, paypalSubscriptionId: string): Promise<PayPalSubscription>;
}

export class PgSubscriptionSource implements SubscriptionSource<Tx> {
  constructor(
    private readonly db: Db,
    private readonly paypal: EmailGateway,
  ) {}

  async snapshot(tx: Tx, merchantId: string, subscriptionId: string): Promise<SubscriptionSnapshot | null> {
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.merchantId, merchantId), eq(subscriptions.id, subscriptionId)));
    return row ? toSnapshot(row) : null;
  }

  /** Our database keeps only a hash of the address (§10), so this re-reads it from PayPal. */
  async email(merchantId: string, subscriptionId: string): Promise<string | null> {
    const [row] = await this.db.forMerchant(merchantId, (tx) =>
      tx
        .select({ paypalId: subscriptions.paypalSubscriptionId })
        .from(subscriptions)
        .where(and(eq(subscriptions.merchantId, merchantId), eq(subscriptions.id, subscriptionId))),
    );
    if (!row) return null;
    const live = await this.paypal.getSubscription(merchantId, row.paypalId);
    return live.subscriber?.email_address ?? null;
  }
}

export class PgPlanCatalog implements PlanCatalog {
  constructor(private readonly db: Db) {}

  async plans(merchantId: string): Promise<PlanInfo[]> {
    const rows = await this.db.forMerchant(merchantId, (tx) =>
      tx
        .select()
        .from(plans)
        .where(and(eq(plans.merchantId, merchantId), eq(plans.status, "ACTIVE"))),
    );
    return rows.map((r) => ({
      planId: r.paypalPlanId,
      name: r.name,
      price: { value: r.priceValue, currency: r.priceCurrency },
      interval: { unit: r.intervalUnit, count: r.intervalCount },
    }));
  }
}

/** Read-only view of the merchant's newest published policy (the full PolicyStore is M2's). */
export class PgPolicyReader implements Pick<PolicyStore, "current"> {
  constructor(private readonly db: Db) {}

  async current(merchantId: string): Promise<StoredPolicy | null> {
    const [row] = await this.db.forMerchant(merchantId, (tx) =>
      tx
        .select()
        .from(policies)
        .where(eq(policies.merchantId, merchantId))
        .orderBy(desc(policies.version))
        .limit(1),
    );
    if (!row) return null;
    return StoredPolicy.parse({
      merchantId: row.merchantId,
      version: row.version,
      publishedAt: row.publishedAt.toISOString(),
      publishedBy: row.publishedBy,
      changeNote: row.changeNote,
      document: row.document,
    });
  }
}
