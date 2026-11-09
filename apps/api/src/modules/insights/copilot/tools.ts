import { z } from "zod";
import { Money, ReasonCategory, type InsightAction } from "@keepwell/contracts";
import { DateRange, type InsightsResponse, type OverviewKpis } from "../queries.js";
import { proposeAction, type ProposeActionDeps } from "./propose.js";

// The copilot's tools are fixed, parameterised and read-only (except propose_action, which only
// writes a `proposed` row). Enums map to fixed SQL in ../queries; there is no free-form SQL.
// list_at_risk is merchant-MCP only for now (it needs the dunning queries).

export const ToolName = z.enum([
  "query_metric",
  "search_quotes",
  "compare_cohorts",
  "list_plans",
  "propose_action",
]);
export type ToolName = z.infer<typeof ToolName>;

const Metric = z.enum(["saves", "cancels", "save_rate", "recovered_revenue", "mrr_at_risk", "insight_count"]);
const GroupBy = z.enum(["none", "week", "plan", "reason", "outcome"]);

const QueryMetricArgs = z
  .object({ metric: Metric, range: DateRange, groupBy: GroupBy.default("none") })
  .refine((a) => a.groupBy === "none" || a.metric === "insight_count", {
    message: "groupBy is only supported for insight_count",
  });
const SearchQuotesArgs = z.object({
  theme: ReasonCategory,
  limit: z.number().int().min(1).max(10).default(5),
});
const Cohort = z.object({ label: z.string().min(1).max(40), range: DateRange });
const CompareArgs = z.object({ a: Cohort, b: Cohort });
const NoArgs = z.object({}).strict();
const ProposeArgs = z.object({
  kind: z.string(),
  params: z.record(z.string(), z.unknown()),
  rationale: z.string().min(1).max(500),
});

const MetricResult = z.object({
  metric: Metric,
  range: DateRange,
  groupBy: GroupBy,
  rows: z.array(z.object({ key: z.string(), value: z.union([z.number(), z.string()]).nullable() })),
});
const QuoteResult = z.object({
  theme: ReasonCategory,
  quotes: z.array(z.object({ quote: z.string(), sentiment: z.string().nullable(), createdAt: z.string() })),
});
const CohortSummary = z.object({
  label: z.string(),
  range: DateRange,
  saves: z.number(),
  cancels: z.number(),
  saveRate: z.number().nullable(),
  insightCount: z.number(),
});
const CompareResult = z.object({
  a: CohortSummary,
  b: CohortSummary,
  /** b minus a, computed here so the model never subtracts. */
  delta: z.object({
    saves: z.number(),
    cancels: z.number(),
    insightCount: z.number(),
    saveRate: z.number().nullable(),
  }),
});
const PlansResult = z.object({
  plans: z.array(
    z.object({
      paypalPlanId: z.string(),
      name: z.string(),
      price: Money,
      interval: z.object({ unit: z.string(), count: z.number() }),
      status: z.string(),
    }),
  ),
});

export type Quotes = z.infer<typeof QuoteResult>["quotes"];
export type Plans = z.infer<typeof PlansResult>["plans"];

/** Merchant-scoped reads. In production: DrizzleCopilotData over db.forMerchant. */
export interface CopilotData {
  overview(merchantId: string, range: DateRange): Promise<OverviewKpis>;
  insights(merchantId: string, range: DateRange): Promise<InsightsResponse>;
  quotes(merchantId: string, theme: ReasonCategory, limit: number): Promise<Quotes>;
  plans(merchantId: string): Promise<Plans>;
}

export interface ToolDeps extends ProposeActionDeps {
  data: CopilotData;
}

/** What the model is told about each tool. */
export const TOOL_HELP = `- query_metric {"metric": "saves|cancels|save_rate|recovered_revenue|mrr_at_risk|insight_count", "range": {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}, "groupBy": "none|week|plan|reason|outcome"}  (groupBy only with insight_count)
- search_quotes {"theme": "${ReasonCategory.options.join("|")}", "limit": 1-10}
- compare_cohorts {"a": {"label": "...", "range": {...}}, "b": {"label": "...", "range": {...}}}  (two date ranges side by side, with deltas)
- list_plans {}
- propose_action {"kind": "create_plan|update_policy|send_winback_batch", "params": {...}, "rationale": "..."}  (only creates a proposal the merchant must approve)`;

export type ToolOutcome =
  { ok: true; result: unknown; insightActionId?: string } | { ok: false; error: string };

/** Validates args, runs the tool, validates the output. Bad input comes back to the model as an error. */
export async function executeTool(
  deps: ToolDeps,
  merchantId: string,
  tool: ToolName,
  rawArgs: unknown,
  proposedBy: InsightAction["proposedBy"] = "copilot",
): Promise<ToolOutcome> {
  const bad = (e: z.ZodError): ToolOutcome => ({
    ok: false,
    error: `invalid arguments: ${z.prettifyError(e)}`,
  });
  const { data } = deps;
  switch (tool) {
    case "query_metric": {
      const a = QueryMetricArgs.safeParse(rawArgs);
      if (!a.success) return bad(a.error);
      return { ok: true, result: MetricResult.parse(await queryMetric(data, merchantId, a.data)) };
    }
    case "search_quotes": {
      const a = SearchQuotesArgs.safeParse(rawArgs);
      if (!a.success) return bad(a.error);
      const quotes = await data.quotes(merchantId, a.data.theme, a.data.limit);
      return { ok: true, result: QuoteResult.parse({ theme: a.data.theme, quotes }) };
    }
    case "compare_cohorts": {
      const a = CompareArgs.safeParse(rawArgs);
      if (!a.success) return bad(a.error);
      return { ok: true, result: CompareResult.parse(await compare(data, merchantId, a.data)) };
    }
    case "list_plans": {
      const a = NoArgs.safeParse(rawArgs);
      if (!a.success) return bad(a.error);
      return { ok: true, result: PlansResult.parse({ plans: await data.plans(merchantId) }) };
    }
    case "propose_action": {
      const a = ProposeArgs.safeParse(rawArgs);
      if (!a.success) return bad(a.error);
      return proposeAction(deps, merchantId, a.data, proposedBy);
    }
  }
}

async function queryMetric(
  data: CopilotData,
  merchantId: string,
  { metric, range, groupBy }: z.infer<typeof QueryMetricArgs>,
): Promise<z.infer<typeof MetricResult>> {
  const rows = async (): Promise<z.infer<typeof MetricResult>["rows"]> => {
    if (metric === "insight_count") {
      const i = await data.insights(merchantId, range);
      switch (groupBy) {
        case "none":
          return [{ key: "all", value: i.total }];
        case "week":
          return i.byWeek.map((r) => ({ key: r.week, value: r.count }));
        case "plan":
          return i.byPlan.map((r) => ({ key: r.plan, value: r.count }));
        case "reason":
          return i.byReason.map((r) => ({ key: r.reason, value: r.count }));
        case "outcome":
          return i.byOutcome.map((r) => ({ key: r.outcome, value: r.count }));
      }
    }
    const k = await data.overview(merchantId, range);
    switch (metric) {
      case "saves":
        return [{ key: "all", value: k.saves }];
      case "cancels":
        return [{ key: "all", value: k.cancels }];
      case "save_rate":
        return [{ key: "all", value: k.saveRate }];
      case "recovered_revenue":
        return k.recoveredRevenue.map((m) => ({ key: m.currency, value: m.value }));
      case "mrr_at_risk":
        return k.mrrAtRisk.map((m) => ({ key: m.currency, value: m.value }));
    }
  };
  return { metric, range, groupBy, rows: await rows() };
}

async function compare(
  data: CopilotData,
  merchantId: string,
  { a, b }: z.infer<typeof CompareArgs>,
): Promise<z.infer<typeof CompareResult>> {
  const summarise = async (c: z.infer<typeof Cohort>): Promise<z.infer<typeof CohortSummary>> => {
    const k = await data.overview(merchantId, c.range);
    const i = await data.insights(merchantId, c.range);
    return {
      label: c.label,
      range: c.range,
      saves: k.saves,
      cancels: k.cancels,
      saveRate: k.saveRate,
      insightCount: i.total,
    };
  };
  const sa = await summarise(a);
  const sb = await summarise(b);
  return {
    a: sa,
    b: sb,
    delta: {
      saves: sb.saves - sa.saves,
      cancels: sb.cancels - sa.cancels,
      insightCount: sb.insightCount - sa.insightCount,
      saveRate:
        sa.saveRate !== null && sb.saveRate !== null
          ? Math.round((sb.saveRate - sa.saveRate) * 10000) / 10000
          : null,
    },
  };
}
