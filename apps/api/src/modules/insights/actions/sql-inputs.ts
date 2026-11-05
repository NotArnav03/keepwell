import { and, count, eq, gte } from "drizzle-orm";
import { insights, plans, subscriptions, type Db } from "@keepwell/db";
import type { EstimateInputs, PlanFootprint } from "./estimate.js";

// The SQL behind the estimate. The insights module's aggregate queries are not on main yet, so this
// is the small helper the plan allowed; swap it for them behind the same interfaces when they land.

export class SqlEstimateInputs implements EstimateInputs {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async priceCancellations(merchantId: string, days: number): Promise<number> {
    const since = new Date(this.clock().getTime() - days * 86_400_000);
    const [row] = await this.db.forMerchant(merchantId, (tx) =>
      tx
        .select({ n: count() })
        .from(insights)
        .where(and(eq(insights.reason, "price"), gte(insights.createdAt, since))),
    );
    return row?.n ?? 0;
  }

  async planFootprints(merchantId: string, currency: string): Promise<PlanFootprint[]> {
    const rows = await this.db.forMerchant(merchantId, (tx) =>
      tx
        .select({
          planName: subscriptions.planName,
          price: subscriptions.priceValue,
          unit: subscriptions.intervalUnit,
          every: subscriptions.intervalCount,
          n: count(),
        })
        .from(subscriptions)
        .where(and(eq(subscriptions.status, "ACTIVE"), eq(subscriptions.priceCurrency, currency)))
        .groupBy(
          subscriptions.paypalPlanId,
          subscriptions.planName,
          subscriptions.priceValue,
          subscriptions.intervalUnit,
          subscriptions.intervalCount,
        ),
    );
    return rows.map((r) => ({
      planName: r.planName,
      activeSubscribers: r.n,
      price: { value: r.price, currency },
      interval: { unit: r.unit, count: r.every },
    }));
  }
}

/** Which PayPal product a plan belongs to: the new plan joins it. */
export interface PlanProductResolver {
  productIdFor(merchantId: string, paypalPlanId: string): Promise<string | null>;
}

export class DbPlanProductResolver implements PlanProductResolver {
  constructor(private readonly db: Db) {}

  async productIdFor(merchantId: string, paypalPlanId: string): Promise<string | null> {
    const [row] = await this.db.forMerchant(merchantId, (tx) =>
      tx.select({ productId: plans.productId }).from(plans).where(eq(plans.paypalPlanId, paypalPlanId)),
    );
    return row?.productId ?? null;
  }
}
