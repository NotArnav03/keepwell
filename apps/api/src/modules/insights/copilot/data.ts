import { and, desc, eq, isNotNull } from "drizzle-orm";
import { insightActions, insights, plans, type Db } from "@keepwell/db";
import { uuidv7 } from "../../agent/ids.js";
import { insightsOverview, overviewKpis } from "../queries.js";
import type { InsightActionStore, NewInsightAction } from "./propose.js";
import type { CopilotData, Plans, Quotes } from "./tools.js";

// Postgres-backed reads and the proposal store. Every query runs in db.forMerchant.

export class DrizzleCopilotData implements CopilotData {
  constructor(private readonly db: Db) {}

  overview: CopilotData["overview"] = (merchantId, range) => overviewKpis(this.db, merchantId, range);
  insights: CopilotData["insights"] = (merchantId, range) => insightsOverview(this.db, merchantId, range, 1);

  quotes(merchantId: string, theme: Parameters<CopilotData["quotes"]>[1], limit: number): Promise<Quotes> {
    return this.db.forMerchant(merchantId, async (tx) => {
      const rows = await tx
        .select({ quote: insights.quote, sentiment: insights.sentiment, createdAt: insights.createdAt })
        .from(insights)
        .where(and(eq(insights.reason, theme), isNotNull(insights.quote)))
        .orderBy(desc(insights.createdAt), desc(insights.id))
        .limit(limit);
      return rows.flatMap((r) =>
        r.quote === null
          ? []
          : [{ quote: r.quote, sentiment: r.sentiment, createdAt: new Date(r.createdAt).toISOString() }],
      );
    });
  }

  plans(merchantId: string): Promise<Plans> {
    return this.db.forMerchant(merchantId, async (tx) => {
      const rows = await tx.select().from(plans).orderBy(plans.name);
      return rows.map((p) => ({
        paypalPlanId: p.paypalPlanId,
        name: p.name,
        price: { value: p.priceValue, currency: p.priceCurrency },
        interval: { unit: p.intervalUnit, count: p.intervalCount },
        status: p.status,
      }));
    });
  }
}

/**
 * insight_actions has no rationale or proposed_by column yet, so both travel in the audit entry
 * (propose.ts) until M1 adds them. State starts as `proposed` by the column default.
 */
export class DrizzleInsightActionStore implements InsightActionStore {
  constructor(private readonly db: Db) {}

  insert(
    merchantId: string,
    row: NewInsightAction,
    onStored: (tx: unknown, id: string) => Promise<void>,
  ): Promise<string> {
    return this.db.forMerchant(merchantId, async (tx) => {
      const id = uuidv7(Date.now());
      await tx.insert(insightActions).values({
        id,
        merchantId,
        kind: row.kind,
        params: row.params,
        estimate: row.estimate,
        rationale: row.rationale,
        proposedBy: row.proposedBy,
        state: "proposed",
      });
      await onStored(tx, id);
      return id;
    });
  }
}
