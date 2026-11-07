import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SessionError, type DelegationScope, type OfferMenu, type ReasonCategory } from "@keepwell/contracts";
import { loadEnv } from "../../env.js";
import { buildServer } from "../../server.js";
import { RateLimiter } from "../portal/rate-limit.js";
import { subscriberMcpRoutes, type SubscriberAgentApi } from "./subscriber.js";

// The MCP server through the SDK's own client over HTTP, as Claude Desktop would reach it.
// The sessions module is faked here; service.db.test.ts covers the agent methods on Postgres.

const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const M = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const SUB = "0199a1b2-0000-7000-8000-000000000001";
const pause = { id: "pause-2", kind: "pause", cycles: 2, resumesOn: "2027-01-19T10:00:00.000Z" } as const;
const menu: OfferMenu = {
  policyVersion: 1,
  computedAt: "2026-11-05T10:00:00.000Z",
  offers: [pause],
  defaultByReason: {} as OfferMenu["defaultByReason"],
  excluded: [],
};

let app: FastifyInstance | undefined;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await app?.close();
  app = undefined;
});

async function start(
  tokens: Record<string, DelegationScope[]>,
  limits?: { perIp?: RateLimiter; perToken?: RateLimiter },
) {
  const sessions = {
    agentSubscription: vi.fn(() =>
      Promise.resolve({
        paypalSubscriptionId: "I-MAYA0001",
        planName: "Standard",
        price: { value: "12.00", currency: "USD" },
        interval: { unit: "MONTH" as const, count: 1 },
        status: "ACTIVE" as const,
        nextBillingTime: "2026-11-19T10:00:00.000Z",
        subscriberFirstName: "Maya",
      }),
    ),
    agentOptions: vi.fn(() => Promise.resolve({ sessionId: "s1", menu })),
    agentAccept: vi.fn((_p: unknown, offerId: string) =>
      offerId === pause.id
        ? Promise.resolve({ actionIds: ["a1"], approveUrl: null })
        : Promise.reject(
            new SessionError("offer_unavailable", "That offer isn't one of the current options"),
          ),
    ),
    agentCancel: vi.fn((_p: unknown, _body: { reason?: ReasonCategory }) =>
      Promise.resolve({ actionId: "c1" }),
    ),
  } satisfies SubscriberAgentApi;
  const revoked = new Set<string>();
  app = buildServer(env);
  await app.register(subscriberMcpRoutes, {
    sessions,
    delegations: {
      authenticate: (token, scope) => {
        const scopes = tokens[token];
        return Promise.resolve(
          scopes && !revoked.has(token) && scopes.includes(scope)
            ? { merchantId: M, subscriptionId: SUB, scopes }
            : null,
        );
      },
    },
    publicUrl: "https://api.keepwell.example",
    portalUrl: "https://portal.keepwell.example/",
    ...(limits === undefined ? {} : { limits }),
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return { sessions, url: new URL(`${address}/mcp/subscriber`), revoke: (t: string) => revoked.add(t) };
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

describe("subscriber MCP server", () => {
  it("lists exactly the tools the token's scopes allow", async () => {
    const { url } = await start({ kwd_all: ["read", "accept_offer", "cancel"], kwd_cancel: ["cancel"] });
    const all = await connect(url, "kwd_all");
    expect((await all.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "accept_offer",
      "cancel_subscription",
      "get_my_subscription",
      "get_retention_options",
    ]);
    const cancelOnly = await connect(url, "kwd_cancel");
    expect((await cancelOnly.listTools()).tools.map((t) => t.name)).toEqual(["cancel_subscription"]);
  });

  it("gives the policy's offers as structured data, always with the way to cancel", async () => {
    const { url } = await start({ kwd_read: ["read"] });
    const client = await connect(url, "kwd_read");
    const options = text(await client.callTool({ name: "get_retention_options", arguments: {} }));
    expect(options.options).toEqual([
      { offer_id: "pause-2", summary: "pause for 2 billing cycles, resuming 2027-01-19", terms: pause },
    ]);
    expect(options.cancel).toContain("cancel_subscription");
    const subscription = text(await client.callTool({ name: "get_my_subscription", arguments: {} }));
    expect(subscription.subscription).toMatchObject({ planName: "Standard", status: "ACTIVE" });
  });

  it("accepts an offer by id as the subscriber's agent, and reports one it can't", async () => {
    const { url, sessions } = await start({ kwd_accept: ["read", "accept_offer"] });
    const client = await connect(url, "kwd_accept");
    const ok = await client.callTool({ name: "accept_offer", arguments: { offer_id: "pause-2" } });
    expect(text(ok)).toMatchObject({ accepted: true, action_ids: ["a1"] });
    expect(sessions.agentAccept.mock.calls[0]?.[0]).toEqual({
      merchantId: M,
      subscriptionId: SUB,
      channel: "subscriber_agent",
    });

    const bad = await client.callTool({ name: "accept_offer", arguments: { offer_id: "made-up" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toEqual({
      error: { code: "offer_unavailable", message: "That offer isn't one of the current options" },
    });
  });

  it("cancels in one call, with or without a reason", async () => {
    const { url, sessions } = await start({ kwd_cancel: ["cancel"] });
    const client = await connect(url, "kwd_cancel");
    expect(text(await client.callTool({ name: "cancel_subscription", arguments: {} }))).toMatchObject({
      cancelled: true,
      action_id: "c1",
    });
    await client.callTool({ name: "cancel_subscription", arguments: { reason: "price" } });
    expect(sessions.agentCancel.mock.calls.map((c) => c[1])).toEqual([{}, { reason: "price" }]);
  });

  it("refuses a missing or unknown token, and a call after the token is revoked", async () => {
    const { url, revoke } = await start({ kwd_all: ["read", "cancel"] });
    for (const headers of [{}, { authorization: "Bearer kwd_nope" }]) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
    const client = await connect(url, "kwd_all");
    revoke("kwd_all");
    await expect(client.listTools()).rejects.toThrow();
  });

  it("serves the discovery document", async () => {
    const { url } = await start({});
    const res = await fetch(new URL("/.well-known/keepwell-agent.json", url));
    const doc = (await res.json()) as { mcp: { url: string }; honesty_policy: string[] };
    expect(doc.mcp.url).toBe("https://api.keepwell.example/mcp/subscriber");
    expect(doc.honesty_policy[0]).toBe("Cancelling is always available and takes one call.");
  });
});

describe("rate limits", () => {
  const post = (url: URL, token?: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  it("limits each token, without touching another token's budget", async () => {
    const { url } = await start(
      { kwd_a: ["read"], kwd_b: ["read"] },
      { perToken: new RateLimiter({ limit: 2, windowMs: 60_000 }) },
    );
    expect((await post(url, "kwd_a")).status).toBe(200);
    expect((await post(url, "kwd_a")).status).toBe(200);
    const limited = await post(url, "kwd_a");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(url, "kwd_b")).status).toBe(200);
  });

  it("limits each IP before looking at the token, so guessing tokens is slow", async () => {
    const { url } = await start({}, { perIp: new RateLimiter({ limit: 3, windowMs: 60_000 }) });
    for (let i = 0; i < 3; i++) expect((await post(url, `kwd_guess${i}`)).status).toBe(401);
    expect((await post(url, "kwd_guess9")).status).toBe(429);
  });
});
