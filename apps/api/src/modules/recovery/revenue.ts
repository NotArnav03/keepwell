import { and, eq, gte, lt, sql } from "drizzle-orm";
import { dunningCases, type Tx } from "@keepwell/db";
import { Money } from "@keepwell/contracts";

// Recovered-revenue KPI for the dashboard (M4 wires it). One Money per currency, summed by
// Postgres on numeric(12,2), so there is no float anywhere.

export interface RecoveredRevenue {
  total: Money;
  /** Number of recovered cases. */
  cases: number;
}

interface Row {
  currency: string | null;
  total: string | null;
  cases: number;
}

/** Pure: turns aggregate rows into Money, dropping rows with no amount. Exported for tests. */
export function rowsToRevenue(rows: Row[]): RecoveredRevenue[] {
  return rows.flatMap((r) =>
    r.currency && r.total !== null
      ? [{ total: Money.parse({ value: r.total, currency: r.currency }), cases: r.cases }]
      : [],
  );
}

/** Run inside db.forMerchant. The merchant filter is repeated so a wrong scope shows up in tests. */
export async function recoveredRevenue(
  tx: Tx,
  merchantId: string,
  range: { from: Date; to: Date },
): Promise<RecoveredRevenue[]> {
  const rows = await tx
    .select({
      currency: dunningCases.recoveredCurrency,
      total: sql<string | null>`sum(${dunningCases.recoveredValue})::numeric(14,2)::text`,
      cases: sql<number>`count(*)::int`,
    })
    .from(dunningCases)
    .where(
      and(
        eq(dunningCases.merchantId, merchantId),
        eq(dunningCases.state, "recovered"),
        gte(dunningCases.closedAt, range.from),
        lt(dunningCases.closedAt, range.to),
      ),
    )
    .groupBy(dunningCases.recoveredCurrency);
  return rowsToRevenue(rows);
}
