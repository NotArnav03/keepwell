import { sql } from "drizzle-orm";
import { z } from "zod";
import { Money, ReasonCategory, SessionOutcome } from "@keepwell/contracts";
import type { Db, Tx } from "@keepwell/db";

// Every number a merchant sees on the overview and insights screens comes from these queries
// (ARCHITECTURE.md §6.12). The model never produces or touches a figure. Each function runs in
// db.forMerchant, so Postgres row-level security scopes it to one merchant.

/** Inclusive UTC calendar days. */
export const DateRange = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((r) => r.from <= r.to, { message: "from must not be after to" });
export type DateRange = z.infer<typeof DateRange>;

// ---------- overview KPIs (GET /m/overview) ----------

export const OverviewKpis = z.object({
  range: DateRange,
  saves: z.number().int().min(0),
  cancels: z.number().int().min(0),
  /** saves / (saves + cancels), 0..1 rounded to 4 places; null when no session closed in range. */
  saveRate: z.number().min(0).max(1).nullable(),
  /** Dunning cases recovered in range, one Money per currency. */
  recoveredRevenue: z.array(Money),
  /** Monthly value of subscriptions with an open dunning case, as of now, one Money per currency. */
  mrrAtRisk: z.array(Money),
});
export type OverviewKpis = z.infer<typeof OverviewKpis>;

const KpiRow = z.object({ saves: z.number(), cancels: z.number(), save_rate: z.number().nullable() });
const MoneyRow = z.object({ currency: z.string(), value: z.string() });

/** Rows from a raw query, whatever the driver wraps them in. */
async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<unknown[]> {
  const result = await tx.execute(query);
  return result.rows;
}

const toMoney = (r: unknown): Money => {
  const row = MoneyRow.parse(r);
  return Money.parse({ value: row.value, currency: row.currency });
};

// [from 00:00Z, to+1day 00:00Z). The explicit zone keeps the session's TimeZone out of it.
const lower = (r: DateRange) => sql`(${r.from}::date)::timestamp at time zone 'UTC'`;
const upper = (r: DateRange) => sql`(${r.to}::date + 1)::timestamp at time zone 'UTC'`;

export function overviewKpis(db: Db, merchantId: string, rangeInput: DateRange): Promise<OverviewKpis> {
  const range = DateRange.parse(rangeInput);
  return db.forMerchant(merchantId, async (tx) => {
    const [kpi] = (
      await rows(
        tx,
        sql`select
              (count(*) filter (where outcome like 'saved\_%'))::int as saves,
              (count(*) filter (where outcome = 'cancelled'))::int as cancels,
              round(
                (count(*) filter (where outcome like 'saved\_%'))::numeric
                  / nullif(count(*) filter (where outcome like 'saved\_%' or outcome = 'cancelled'), 0),
                4)::float8 as save_rate
            from sessions
            where closed_at >= ${lower(range)} and closed_at < ${upper(range)}`,
      )
    ).map((r) => KpiRow.parse(r));
    if (!kpi) throw new Error("overview query returned no row");

    const recovered = await rows(
      tx,
      sql`select recovered_currency::text as currency, sum(recovered_value)::numeric(14,2)::text as value
          from dunning_cases
          where state = 'recovered' and recovered_value is not null
            and closed_at >= ${lower(range)} and closed_at < ${upper(range)}
          group by 1 order by 1`,
    );
    // Price per period → per month: 30-day months for days, 52/12 weeks, 12 months a year.
    const atRisk = await rows(
      tx,
      sql`select coalesce(s.override_currency, s.price_currency)::text as currency,
                 round(sum(
                   coalesce(s.override_value, s.price_value) / s.interval_count
                   * case s.interval_unit
                       when 'DAY' then 30.0 when 'WEEK' then 52.0 / 12 when 'MONTH' then 1.0 else 1.0 / 12 end
                 ), 2)::numeric(14,2)::text as value
          from subscriptions s
          where s.status in ('ACTIVE', 'SUSPENDED')
            and exists (select 1 from dunning_cases d where d.subscription_id = s.id and d.state = 'open')
          group by 1 order by 1`,
    );

    return OverviewKpis.parse({
      range,
      saves: kpi.saves,
      cancels: kpi.cancels,
      saveRate: kpi.save_rate,
      recoveredRevenue: recovered.map(toMoney),
      mrrAtRisk: atRisk.map(toMoney),
    });
  });
}

// ---------- insights aggregates (GET /m/insights) ----------

const Count = z.number().int().min(0);

/** Proposed contract: CONTRACTS.md §4 says only "aggregates + top quotes". */
export const InsightsResponse = z.object({
  range: DateRange,
  total: Count,
  byWeek: z.array(z.object({ week: z.iso.date(), count: Count })),
  byPlan: z.array(z.object({ plan: z.string(), count: Count })),
  byReason: z.array(z.object({ reason: ReasonCategory, count: Count })),
  /** "none" for insights without a session outcome (win-back replies). */
  byOutcome: z.array(z.object({ outcome: z.union([SessionOutcome, z.literal("none")]), count: Count })),
  topQuotes: z.array(
    z.object({
      quote: z.string(),
      reason: ReasonCategory,
      sentiment: z.enum(["negative", "neutral", "positive"]).nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type InsightsResponse = z.infer<typeof InsightsResponse>;

export const DEFAULT_QUOTE_LIMIT = 10;

type Dimension = "week" | "plan_name" | "reason" | "outcome";
const GroupRow = z.object({ key: z.string(), count: z.number() });
const QuoteRow = z.object({
  quote: z.string(),
  reason: ReasonCategory,
  sentiment: z.enum(["negative", "neutral", "positive"]).nullable(),
  created_iso: z.iso.datetime(),
});

/** Counts per dimension from the hourly-refreshed view; ties break on the key so order is stable. */
async function groupCounts(tx: Tx, dimension: Dimension, range: DateRange) {
  const key =
    dimension === "week" ? sql`date_trunc('week', day)::date::text` : sql`${sql.identifier(dimension)}::text`;
  const orderBy = dimension === "week" ? sql`1` : sql`2 desc, 1`;
  const result = await rows(
    tx,
    sql`select ${key} as key, sum(insight_count)::int as count
        from insight_daily
        where day between ${range.from}::date and ${range.to}::date
        group by 1 order by ${orderBy}`,
  );
  return result.map((r) => GroupRow.parse(r));
}

export function insightsOverview(
  db: Db,
  merchantId: string,
  rangeInput: DateRange,
  quoteLimit = DEFAULT_QUOTE_LIMIT,
): Promise<InsightsResponse> {
  const range = DateRange.parse(rangeInput);
  return db.forMerchant(merchantId, async (tx) => {
    const [week, plan, reason, outcome] = [
      await groupCounts(tx, "week", range),
      await groupCounts(tx, "plan_name", range),
      await groupCounts(tx, "reason", range),
      await groupCounts(tx, "outcome", range),
    ];
    // Quotes read the table, not the view, so a fresh one shows before the next refresh. The
    // newest come first; equal timestamps break on id (UUIDv7, so creation order).
    const quotes = await rows(
      tx,
      sql`select quote, reason, sentiment,
                 to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_iso
          from insights
          where quote is not null
            and created_at >= ${lower(range)} and created_at < ${upper(range)}
          order by created_at desc, id desc
          limit ${quoteLimit}`,
    );
    return InsightsResponse.parse({
      range,
      total: reason.reduce((sum, r) => sum + r.count, 0),
      byWeek: week.map((r) => ({ week: r.key, count: r.count })),
      byPlan: plan.map((r) => ({ plan: r.key, count: r.count })),
      byReason: reason.map((r) => ({ reason: r.key, count: r.count })),
      byOutcome: outcome.map((r) => ({ outcome: r.key, count: r.count })),
      topQuotes: quotes
        .map((q) => QuoteRow.parse(q))
        .map((q) => ({
          quote: q.quote,
          reason: q.reason,
          sentiment: q.sentiment,
          createdAt: q.created_iso,
        })),
    });
  });
}
