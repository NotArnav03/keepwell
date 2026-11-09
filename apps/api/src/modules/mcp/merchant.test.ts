import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FakeAudit, FakeDomainEvents, uuidv7 } from "@keepwell/contracts/fakes";
import type { MerchantApiKeyScope } from "@keepwell/contracts";
import { loadEnv } from "../../env.js";
import { buildServer } from "../../server.js";
import type { DateRange, InsightsResponse, OverviewKpis } from "../insights/queries.js";
import {
  nullEstimates,
  type InsightActionStore,
  type NewInsightAction,
} from "../insights/copilot/propose.js";
import type { CopilotData } from "../insights/copilot/tools.js";
import { RateLimiter } from "../portal/rate-limit.js";
import { merchantMcpRoutes, type AtRiskSubscription } from "./merchant.js";

// The merchant MCP server through the SDK's own client over HTTP, as Claude Desktop would reach it.
// Copilot data and the key store are faked; api-keys.db.test.ts covers the keys on Postgres.

const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const mine = uuidv7(1);
const other = uuidv7(2);
const ALL: MerchantApiKeyScope[] = [
  "query_metric",
  "search_quotes",
  "compare_cohorts",
  "list_plans",
  "list_at_risk",
  "propose_action",
];

const kpis = (merchantId: string, range: DateRange): OverviewKpis => ({
  range,
  saves: merchantId === mine ? 10 : 99,
  cancels: 20,
  saveRate: 0.3333,
  recoveredRevenue: [{ value: "120.00", currency: "USD" }],
  mrrAtRisk: [],
});
const insights = (range: DateRange): InsightsResponse => ({
  range,
  total: 4,
  byWeek: [],
  byPlan: [],
  byReason: [],
  byOutcome: [],
  topQuotes: [],
});
class FakeData implements CopilotData {
  readonly seen: string[] = [];
  overview(m: string, range: DateRange) {
    this.seen.push(m);
    return Promise.resolve(kpis(m, range));
  }
  insights(m: string, range: DateRange) {
    this.seen.push(m);
    return Promise.resolve(insights(range));
  }
  quotes() {
    return Promise.resolve([
      { quote: "too pricey", sentiment: "negative", createdAt: "2026-10-02T00:00:00.000Z" },
    ]);
  }
  plans() {
    return Promise.resolve([
      {
        paypalPlanId: "P-1",
        name: "Pantry Plan",
        price: { value: "9.00", currency: "USD" },
        interval: { unit: "MONTH", count: 1 },
        status: "ACTIVE",
      },
    ]);
  }
}
class FakeStore implements InsightActionStore {
  readonly rows: { merchantId: string; row: NewInsightAction }[] = [];
  async insert(
    merchantId: string,
    row: NewInsightAction,
    onStored: (tx: unknown, id: string) => Promise<void>,
  ) {
    const id = uuidv7(Date.now());
    this.rows.push({ merchantId, row });
    await onStored(undefined, id);
    return id;
  }
}

const atRisk: AtRiskSubscription = {
  subscriptionId: uuidv7(9),
  planName: "Standard",
  monthlyValue: { value: "12.00", currency: "USD" },
  failedPayments: 2,
  nextRetryAt: "2026-11-12T00:00:00.000Z",
  lastFailureReason: "INSUFFICIENT_FUNDS",
};

let app: FastifyInstance | undefined;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await app?.close();
  app = undefined;
});

async function start(
  keys: Record<string, { merchantId: string; scopes: MerchantApiKeyScope[] }>,
  limits?: { perIp?: RateLimiter; perKey?: RateLimiter },
) {
  const data = new FakeData();
  const store = new FakeStore();
  const events = new FakeDomainEvents();
  const audit = new FakeAudit();
  const revoked = new Set<string>();
  app = buildServer(env);
  await app.register(merchantMcpRoutes, {
    keys: {
      authenticate: (token) => {
        const key = keys[token];
        return Promise.resolve(
          key && !revoked.has(token) ? { merchantId: key.merchantId, keyId: "k1", scopes: key.scopes } : null,
        );
      },
    },
    tools: { data, store, estimates: nullEstimates, events, audit },
    atRisk: { list: (m, limit) => Promise.resolve(m === mine ? [atRisk].slice(0, limit) : []) },
    ...(limits === undefined ? {} : { limits }),
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    data,
    store,
    events,
    audit,
    url: new URL(`${address}/mcp/merchant`),
    revoke: (t: string) => revoked.add(t),
  };
}

async function connect(url: URL, token: string) {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
}

const text = (result: unknown) => {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]?.text ?? "null") as Record<string, unknown>;
};
const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;

describe("merchant MCP server", () => {
  it("lists exactly the tools the key's scopes allow", async () => {
    const { url } = await start({
      kwk_all: { merchantId: mine, scopes: ALL },
      kwk_read: { merchantId: mine, scopes: ["query_metric", "list_plans"] },
    });
    expect((await (await connect(url, "kwk_all")).listTools()).tools.map((t) => t.name).sort()).toEqual([
      "compare_cohorts",
      "list_at_risk",
      "list_plans",
      "propose_action",
      "query_metric",
      "search_quotes",
    ]);
    expect((await (await connect(url, "kwk_read")).listTools()).tools.map((t) => t.name).sort()).toEqual([
      "list_plans",
      "query_metric",
    ]);
  });

  it("answers from the key's own merchant and never another's", async () => {
    const { url, data } = await start({
      kwk_mine: { merchantId: mine, scopes: ALL },
      kwk_other: { merchantId: other, scopes: ALL },
    });
    const args = { metric: "saves", range: { from: "2026-10-01", to: "2026-10-31" } };
    const a = text(
      await (await connect(url, "kwk_mine")).callTool({ name: "query_metric", arguments: args }),
    );
    const b = text(
      await (await connect(url, "kwk_other")).callTool({ name: "query_metric", arguments: args }),
    );
    expect(a).toMatchObject({ metric: "saves", rows: [{ key: "all", value: 10 }] });
    expect(b).toMatchObject({ rows: [{ key: "all", value: 99 }] });
    expect(data.seen).toEqual([mine, other]);
  });

  it("serves quotes, plans, comparisons and at-risk subscriptions", async () => {
    const { url } = await start({ kwk_all: { merchantId: mine, scopes: ALL } });
    const client = await connect(url, "kwk_all");
    expect(
      text(await client.callTool({ name: "search_quotes", arguments: { theme: "price" } })),
    ).toMatchObject({
      quotes: [{ quote: "too pricey" }],
    });
    expect(text(await client.callTool({ name: "list_plans", arguments: {} }))).toMatchObject({
      plans: [{ name: "Pantry Plan" }],
    });
    const range = { from: "2026-10-01", to: "2026-10-31" };
    expect(
      text(
        await client.callTool({
          name: "compare_cohorts",
          arguments: { a: { label: "Oct", range }, b: { label: "Oct again", range } },
        }),
      ),
    ).toMatchObject({ delta: { saves: 0 } });
    expect(text(await client.callTool({ name: "list_at_risk", arguments: { limit: 5 } }))).toEqual({
      subscriptions: [atRisk],
    });
  });

  it("a proposal lands as proposed, marked as coming from the MCP, and nothing executes", async () => {
    const { url, store, events, audit } = await start({ kwk_all: { merchantId: mine, scopes: ALL } });
    const result = await (
      await connect(url, "kwk_all")
    ).callTool({
      name: "propose_action",
      arguments: {
        kind: "create_plan",
        rationale: "price leavers",
        params: {
          name: "Basics",
          description: null,
          price: { value: "4.00", currency: "USD" },
          interval: { unit: "MONTH", count: 1 },
          basedOnPaypalPlanId: "P-1",
        },
      },
    });
    expect(isError(result)).toBe(false);
    expect(text(result)).toMatchObject({ state: "proposed" });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      merchantId: mine,
      row: { kind: "create_plan", rationale: "price leavers", proposedBy: "merchant_mcp" },
    });
    expect(events.emitted).toMatchObject([{ type: "insight_action.proposed", merchantId: mine }]);
    expect(audit.entries).toMatchObject([
      { kind: "insight_action.proposed", payload: { proposedBy: "merchant_mcp" } },
    ]);
  });

  it("refuses a bad proposal (a free plan, an unknown kind) without storing anything", async () => {
    const { url, store } = await start({ kwk_all: { merchantId: mine, scopes: ALL } });
    const client = await connect(url, "kwk_all");
    const free = await client.callTool({
      name: "propose_action",
      arguments: {
        kind: "create_plan",
        rationale: "free!",
        params: {
          name: "Free",
          description: null,
          price: { value: "0.00", currency: "USD" },
          interval: { unit: "MONTH", count: 1 },
          basedOnPaypalPlanId: "P-1",
        },
      },
    });
    const unknown = await client.callTool({
      name: "propose_action",
      arguments: { kind: "delete_everything", rationale: "r", params: {} },
    });
    expect(isError(free)).toBe(true);
    expect(isError(unknown)).toBe(true);
    expect(store.rows).toHaveLength(0);
  });

  it("refuses bad arguments as a tool error, not a crash", async () => {
    const { url } = await start({ kwk_all: { merchantId: mine, scopes: ALL } });
    const result = await (
      await connect(url, "kwk_all")
    ).callTool({
      name: "query_metric",
      arguments: { metric: "saves", range: { from: "2026-10-01", to: "2026-10-31" }, groupBy: "week" },
    });
    expect(isError(result)).toBe(true);
  });

  it("answers 401 to a missing, unknown or non-bearer key", async () => {
    const { url } = await start({ kwk_all: { merchantId: mine, scopes: ALL } });
    const post = (headers: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer kwk_nope" })).status).toBe(401);
    expect((await post({ authorization: "Basic abc" })).status).toBe(401);
    expect((await post({ authorization: "Bearer kwk_all" })).status).toBe(200);
  });

  it("stops a key that is revoked mid-session", async () => {
    const { url, revoke } = await start({ kwk_all: { merchantId: mine, scopes: ALL } });
    const client = await connect(url, "kwk_all");
    expect(isError(await client.callTool({ name: "list_plans", arguments: {} }))).toBe(false);
    revoke("kwk_all");
    // The next HTTP request already fails at the door.
    await expect(client.callTool({ name: "list_plans", arguments: {} })).rejects.toThrow();
  });

  it("rate-limits per key and per IP", async () => {
    const { url } = await start(
      { kwk_all: { merchantId: mine, scopes: ALL } },
      { perKey: new RateLimiter({ limit: 1, windowMs: 60_000 }) },
    );
    const post = () =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer kwk_all",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await post()).status).toBe(200);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });

  it("does not answer GET or DELETE", async () => {
    const { url } = await start({ kwk_all: { merchantId: mine, scopes: ALL } });
    expect((await fetch(url, { method: "GET" })).status).toBe(405);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(405);
  });
});
