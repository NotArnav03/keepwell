import type { FastifyPluginCallback, FastifyReply } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { Money, ReasonCategory, type MerchantApiKeyScope } from "@keepwell/contracts";
import type { Db } from "@keepwell/db";
import type { ApiKeyGrant } from "../merchant/api-keys.js";
import { executeTool, type ToolDeps, type ToolName } from "../insights/copilot/tools.js";
import { RateLimiter } from "../portal/rate-limit.js";
import { hashToken } from "../portal/tokens.js";

// The merchant MCP server (ARCHITECTURE.md §6.14, #45): run retention from Claude Desktop. A merchant
// API key unlocks the copilot's read-only tools plus propose_action. A proposal only lands in the
// dashboard's queue as `proposed`: approving, and so executing, is a click by a signed-in merchant
// user. Nothing in this file changes PayPal, the policy or a subscription.
//
// Streamable HTTP, stateless (like the subscriber server): every POST carries its key and gets a
// fresh server, so any API instance can answer. Only the tools the key's scopes allow are listed.

/** Checks a merchant API key (ApiKeyService.authenticate). */
export interface ApiKeyCheck {
  authenticate(token: string): Promise<ApiKeyGrant | null>;
}

export interface AtRiskSubscription {
  subscriptionId: string;
  planName: string;
  /** Monthly value, as priced today. */
  monthlyValue: Money;
  failedPayments: number;
  nextRetryAt: string | null;
  lastFailureReason: string | null;
}

/** Subscriptions with an open failed-payment case. No names or emails: an agent doesn't need them. */
export interface AtRiskSource {
  list(merchantId: string, limit: number): Promise<AtRiskSubscription[]>;
}

export interface MerchantMcpOptions {
  keys: ApiKeyCheck;
  /** The copilot's tools: query_metric, search_quotes, compare_cohorts, list_plans, propose_action. */
  tools: ToolDeps;
  atRisk: AtRiskSource;
  /** Defaults: 300 requests a minute per IP (before the key is checked), 120 per key. */
  limits?: { perIp?: RateLimiter; perKey?: RateLimiter };
}

const Day = z.iso.date();
const Range = z.object({ from: Day, to: Day });
const Cohort = z.object({ label: z.string().min(1).max(40), range: Range });

export const merchantMcpRoutes: FastifyPluginCallback<MerchantMcpOptions> = (app, options, done) => {
  const perIp = options.limits?.perIp ?? new RateLimiter({ limit: 300, windowMs: 60_000 });
  const perKey = options.limits?.perKey ?? new RateLimiter({ limit: 120, windowMs: 60_000 });

  app.post("/mcp/merchant", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const byIp = perIp.hit(`ip:${request.ip}`);
    if (!byIp.allowed) return tooMany(reply, byIp.retryAfterSeconds);
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const grant = token === undefined ? null : await options.keys.authenticate(token);
    if (token === undefined || grant === null) return unauthorized(reply);
    const byKey = perKey.hit(hashToken(token));
    if (!byKey.allowed) return tooMany(reply, byKey.retryAfterSeconds);

    const server = buildServer(options, token, grant);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      request.log.error({ err }, "merchant MCP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }),
        );
      } else if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  });

  const notAllowed = (_request: unknown, reply: FastifyReply) =>
    reply
      .code(405)
      .header("allow", "POST")
      .send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  app.get("/mcp/merchant", notAllowed);
  app.delete("/mcp/merchant", notAllowed);

  done();
};

function buildServer(options: MerchantMcpOptions, token: string, grant: ApiKeyGrant): McpServer {
  const server = new McpServer(
    { name: "keepwell-merchant", version: "1.0.0" },
    {
      instructions:
        "You can read this merchant's retention numbers and propose actions. Every figure comes from the merchant's own data: quote the numbers the tools return and never estimate or compute your own. propose_action only creates a proposal that the merchant must approve in their Keepwell dashboard; nothing you call changes a subscription, a price or the policy.",
    },
  );
  const can = (scope: MerchantApiKeyScope) => grant.scopes.includes(scope);

  // Each call re-checks the key: it may have been revoked since the request began.
  const guarded =
    <A>(scope: MerchantApiKeyScope, run: (merchantId: string, args: A) => Promise<unknown>) =>
    async (args: A) => {
      const current = await options.keys.authenticate(token);
      if (current === null || !current.scopes.includes(scope)) {
        return failure("unauthorized", "This API key has been revoked, or doesn't allow that.");
      }
      const out = await run(current.merchantId, args);
      if (isToolFailure(out)) return failure("invalid_request", out.error);
      return success(out);
    };
  const viaTool =
    (tool: ToolName, proposedBy: "merchant_mcp" | "copilot" = "merchant_mcp") =>
    async (merchantId: string, args: unknown) => {
      const outcome = await executeTool(options.tools, merchantId, tool, args, proposedBy);
      return outcome.ok ? outcome.result : { error: outcome.error };
    };

  if (can("query_metric")) {
    server.registerTool(
      "query_metric",
      {
        title: "Query a metric",
        description:
          "One number from the merchant's data over a date range (UTC, inclusive): saves, cancels, save_rate, recovered_revenue, mrr_at_risk, or insight_count (the only one that can be grouped by week, plan, reason or outcome).",
        inputSchema: {
          metric: z.enum([
            "saves",
            "cancels",
            "save_rate",
            "recovered_revenue",
            "mrr_at_risk",
            "insight_count",
          ]),
          range: Range,
          groupBy: z.enum(["none", "week", "plan", "reason", "outcome"]).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      guarded("query_metric", viaTool("query_metric")),
    );
  }
  if (can("search_quotes")) {
    server.registerTool(
      "search_quotes",
      {
        title: "Search subscriber quotes",
        description:
          "Short, scrubbed quotes from subscribers who left or nearly left, for one reason theme (up to 10).",
        inputSchema: { theme: ReasonCategory, limit: z.number().int().min(1).max(10).optional() },
        annotations: { readOnlyHint: true },
      },
      guarded("search_quotes", viaTool("search_quotes")),
    );
  }
  if (can("compare_cohorts")) {
    server.registerTool(
      "compare_cohorts",
      {
        title: "Compare two periods",
        description: "Saves, cancels, save rate and insight count for two date ranges, with the differences.",
        inputSchema: { a: Cohort, b: Cohort },
        annotations: { readOnlyHint: true },
      },
      guarded("compare_cohorts", viaTool("compare_cohorts")),
    );
  }
  if (can("list_plans")) {
    server.registerTool(
      "list_plans",
      {
        title: "List plans",
        description: "The merchant's plans with price, billing interval and status.",
        annotations: { readOnlyHint: true },
      },
      // No input schema: the SDK hands the callback its own context, not arguments.
      guarded("list_plans", (merchantId) => viaTool("list_plans")(merchantId, {})),
    );
  }
  if (can("list_at_risk")) {
    server.registerTool(
      "list_at_risk",
      {
        title: "List subscriptions at risk",
        description:
          "Subscriptions with an open failed-payment case, worst first: plan, monthly value, failed payments and next retry. No names or emails.",
        inputSchema: { limit: z.number().int().min(1).max(50).optional() },
        annotations: { readOnlyHint: true },
      },
      guarded<{ limit?: number }>("list_at_risk", async (merchantId, args) => ({
        subscriptions: await options.atRisk.list(merchantId, args.limit ?? 20),
      })),
    );
  }
  if (can("propose_action")) {
    server.registerTool(
      "propose_action",
      {
        title: "Propose an action",
        description:
          "Proposes create_plan, update_policy or send_winback_batch with a short rationale. This only creates a proposal in the merchant's dashboard queue; the merchant approves or rejects it there, and nothing happens until they do.",
        inputSchema: {
          kind: z.string(),
          params: z.record(z.string(), z.unknown()),
          rationale: z.string().min(1).max(500),
        },
      },
      guarded("propose_action", viaTool("propose_action")),
    );
  }
  return server;
}

/** At-risk subscriptions straight from Postgres, inside the merchant's row-level security. */
export class SqlAtRiskSource implements AtRiskSource {
  constructor(private readonly db: Db) {}

  list(merchantId: string, limit: number): Promise<AtRiskSubscription[]> {
    return this.db.forMerchant(merchantId, async (tx) => {
      const result = await tx.execute(
        sql`select s.id::text as id, s.plan_name,
                   coalesce(s.override_currency, s.price_currency)::text as currency,
                   round(coalesce(s.override_value, s.price_value) / s.interval_count
                     * case s.interval_unit
                         when 'DAY' then 30.0 when 'WEEK' then 52.0 / 12 when 'MONTH' then 1.0 else 1.0 / 12 end,
                     2)::numeric(14,2)::text as monthly,
                   d.failed_count, s.next_retry_time, s.last_failure_reason
            from dunning_cases d
            join subscriptions s on s.id = d.subscription_id
            where d.state = 'open' and s.status in ('ACTIVE', 'SUSPENDED')
            order by d.failed_count desc, s.id
            limit ${limit}`,
      );
      return result.rows.map((raw) => {
        const row = AtRiskRow.parse(raw);
        return {
          subscriptionId: row.id,
          planName: row.plan_name,
          monthlyValue: Money.parse({ value: row.monthly, currency: row.currency }),
          failedPayments: row.failed_count,
          nextRetryAt: row.next_retry_time ? new Date(row.next_retry_time).toISOString() : null,
          lastFailureReason: row.last_failure_reason,
        };
      });
    });
  }
}

const AtRiskRow = z.object({
  id: z.string(),
  plan_name: z.string(),
  currency: z.string(),
  monthly: z.string(),
  failed_count: z.number(),
  next_retry_time: z.union([z.string(), z.date()]).nullable(),
  last_failure_reason: z.string().nullable(),
});

function isToolFailure(out: unknown): out is { error: string } {
  return typeof out === "object" && out !== null && "error" in out && typeof out.error === "string";
}

function success(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function failure(code: string, message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }],
  };
}

function tooMany(reply: FastifyReply, retryAfterSeconds: number) {
  return reply
    .code(429)
    .header("retry-after", retryAfterSeconds)
    .send({
      jsonrpc: "2.0",
      error: { code: -32002, message: `Too many requests; try again in ${retryAfterSeconds} s` },
      id: null,
    });
}

function unauthorized(reply: FastifyReply) {
  return reply
    .code(401)
    .header("www-authenticate", 'Bearer realm="keepwell", error="invalid_token"')
    .send({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "A Keepwell merchant API key is required: create one in the dashboard under API keys.",
      },
      id: null,
    });
}
