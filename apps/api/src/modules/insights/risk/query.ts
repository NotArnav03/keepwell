import { sql } from "drizzle-orm";
import { z } from "zod";
import { Id, SubscriptionStatus } from "@keepwell/contracts";
import type { Db } from "@keepwell/db";
import { RISK_WEIGHTS, scoreChurnRisk, type ChurnSignals } from "./score.js";

// Backs the dashboard's at-risk list and the merchant MCP tool `list_at_risk` (CONTRACTS.md §4).

/**
 * PROPOSED CONTRACT: CONTRACTS.md names `list_at_risk` but does not give its item shape, so this
 * one is defined here. If it is adopted it should move to packages/contracts (label the PR
 * `contract-change`). The subscriber is a subscription id and a first name only: no email.
 */
export const RiskFactorSchema = z.object({
  id: z.string(),
  label: z.string(),
  points: z.number().int().positive(),
  detail: z.string(),
});

export const AtRiskItem = z.object({
  subscriptionId: Id,
  firstName: z.string().nullable(),
  planName: z.string(),
  status: SubscriptionStatus,
  score: z.number().int().min(0).max(100),
  band: z.enum(["low", "medium", "high"]),
  factors: z.array(RiskFactorSchema),
});
export type AtRiskItem = z.infer<typeof AtRiskItem>;

export interface ListAtRiskOptions {
  /** Default 50, at most 200. */
  limit?: number;
  /** Default 25, the bottom of the medium band. */
  minScore?: number;
  /** For tests; defaults to the current time. */
  now?: Date;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_MIN_SCORE = 25;
const DAY_MS = 86_400_000;
const INTERVAL_DAYS = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 } as const;

// Drizzle's raw execute hands timestamptz back as text, not Date, so the SQL formats them as ISO
// UTC and this turns them into Dates.
const IsoDate = z.iso.datetime().transform((v) => new Date(v));

const Row = z.object({
  id: Id,
  subscriber_first_name: z.string().nullable(),
  plan_name: z.string(),
  status: SubscriptionStatus,
  interval_unit: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]),
  interval_count: z.number().int(),
  started_at: IsoDate,
  next_billing_time: IsoDate.nullable(),
  last_payment_at: IsoDate.nullable(),
  outstanding_value: z.string().nullable(),
  failed_payments_count: z.number().int(),
  last_failure_at: IsoDate.nullable(),
  prior_pauses: z.number().int(),
  prior_downgrades: z.number().int(),
  prior_discounts: z.number().int(),
  recent_revise: z.boolean(),
});
export type RiskRow = z.infer<typeof Row>;

const daysBetween = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / DAY_MS;

export function signalsFromRow(row: RiskRow, now: Date): ChurnSignals {
  return {
    status: row.status,
    failedPaymentsCount: row.failed_payments_count,
    daysSinceLastFailure: row.last_failure_at === null ? null : daysBetween(row.last_failure_at, now),
    outstandingValue: row.outstanding_value,
    daysSinceLastPayment: row.last_payment_at === null ? null : daysBetween(row.last_payment_at, now),
    billingIntervalDays: INTERVAL_DAYS[row.interval_unit] * Math.max(1, row.interval_count),
    tenureDays: daysBetween(row.started_at, now),
    priorPauses: row.prior_pauses,
    priorDowngrades: row.prior_downgrades,
    priorDiscounts: row.prior_discounts,
    recentRevise: row.recent_revise,
    daysToNextBilling: row.next_billing_time === null ? null : daysBetween(now, row.next_billing_time),
  };
}

export async function listAtRisk(
  db: Db,
  merchantId: string,
  options: ListAtRiskOptions = {},
): Promise<AtRiskItem[]> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const now = options.now ?? new Date();
  const reviseCutoff = new Date(now.getTime() - RISK_WEIGHTS.recentReviseDays * DAY_MS).toISOString();
  const mid = Id.parse(merchantId);

  // Fixed SQL, no string building. A "retention save" is an applied pause/downgrade/discount whose
  // origin is a session or insight, so dunning's own suspends are not counted as saves. A revise
  // inside the recent window is the separate recent_revise signal, not also a past downgrade.
  const rows = await db.forMerchant(mid, async (tx) => {
    const result = await tx.execute(sql`
      SELECT s.id,
             s.subscriber_first_name,
             s.plan_name,
             s.status,
             s.interval_unit,
             s.interval_count,
             to_char(s.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
             to_char(s.next_billing_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next_billing_time,
             to_char(s.last_payment_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_payment_at,
             s.outstanding_value,
             s.failed_payments_count,
             to_char(s.last_failure_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_failure_at,
             count(a.id) FILTER (WHERE a.type = 'suspend' AND a.origin IN ('session', 'insight'))::int AS prior_pauses,
             count(a.id) FILTER (WHERE a.type = 'revise' AND a.origin IN ('session', 'insight')
                                  AND a.created_at < ${reviseCutoff}::timestamptz)::int AS prior_downgrades,
             count(a.id) FILTER (WHERE a.type = 'patch_price' AND a.origin IN ('session', 'insight'))::int AS prior_discounts,
             COALESCE(bool_or(a.type = 'revise' AND a.created_at >= ${reviseCutoff}::timestamptz), false) AS recent_revise
        FROM subscriptions s
        LEFT JOIN actions a
               ON a.subscription_id = s.id
              AND a.merchant_id = s.merchant_id
              AND a.state IN ('APPLIED', 'CONFIRMED')
       WHERE s.merchant_id = ${mid}::uuid
         AND s.status IN ('ACTIVE', 'SUSPENDED')
       GROUP BY s.id
    `);
    return z.array(Row).parse(result.rows);
  });

  return rows
    .map((row) => {
      const risk = scoreChurnRisk(signalsFromRow(row, now));
      return AtRiskItem.parse({
        subscriptionId: row.id,
        firstName: row.subscriber_first_name,
        planName: row.plan_name,
        status: row.status,
        score: risk.score,
        band: risk.band,
        factors: risk.factors,
      });
    })
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score || a.subscriptionId.localeCompare(b.subscriptionId))
    .slice(0, limit);
}
