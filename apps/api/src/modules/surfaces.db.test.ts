import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { CreateSessionResponse, JudgeLeaseResponse, type JudgePool } from "@keepwell/contracts";
import { FakeAudit, FakeDomainEvents, FakeJudgePool, PANTRY_PLAN } from "@keepwell/contracts/fakes";
import { createDb, merchants, subscriptions, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { loadEnv } from "../env.js";
import { buildServer } from "../server.js";
import { DbActionEngine } from "./actions/engine.js";
import type { Jobs } from "./jobs/jobs.js";
import type { PayPalClient } from "./paypal/client.js";
import { DbPolicyStore } from "./policy/db-service.js";
import { signWidgetToken } from "./portal/jwt.js";
import { mountSurfaces } from "./surfaces.js";

// The surfaces mounted the way platform.ts mounts them, against a real database: nothing without
// the secrets, and with them a widget session that starts, streams from its ticket URL and cancels,
// the MCP discovery document, and Judge Mode answering pool_empty. No PayPal or Anthropic calls.

const M = PANTRY_PLAN.merchantId;
const SECRETS = {
  SESSION_TICKET_SECRET: "t".repeat(40),
  WIDGET_TOKEN_SECRET: "w".repeat(40),
  JUDGE_LEASE_SECRET: "j".repeat(40),
  DEMO_MERCHANT_ID: M,
};
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let testDb: TestDatabase;
let db: Db;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(extra: Record<string, string>, judgePool: JudgePool = new FakeJudgePool()) {
  const env = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    API_PUBLIC_URL: "https://api.example",
    ...extra,
  });
  const events = new FakeDomainEvents();
  const audit = new FakeAudit();
  const engine = new DbActionEngine({
    db,
    lockPool: testDb.appPool,
    paypal: {} as never,
    audit,
    events,
    log: quiet,
  });
  const jobs = { work: vi.fn(() => Promise.resolve()), schedule: vi.fn(() => Promise.resolve()) };
  app = buildServer(env);
  const mounted = await mountSurfaces({
    app,
    env,
    db,
    paypal: { listTransactions: () => Promise.resolve([]) } as unknown as PayPalClient,
    engine,
    events,
    audit,
    jobs: jobs as unknown as Jobs,
    judgePool,
    log: app.log,
  });
  await app.ready();
  return { server: app, mounted, jobs, events };
}

describe.skipIf(TEST_DATABASE_URL === undefined)("mountSurfaces", { timeout: 60_000 }, () => {
  let subscriptionId = "";

  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    await db.forMerchant(M, (tx) =>
      tx.insert(merchants).values({ id: M, slug: "pantry-plan", name: "Pantry Plan" }),
    );
    const [row] = await db.forMerchant(M, (tx) =>
      tx
        .insert(subscriptions)
        .values({
          merchantId: M,
          paypalSubscriptionId: "I-SURFACES0001",
          paypalPlanId: PANTRY_PLAN.standard.planId,
          planName: "Standard",
          status: "ACTIVE",
          intervalUnit: "MONTH",
          intervalCount: 1,
          priceValue: "12.00",
          priceCurrency: "USD",
          startedAt: new Date("2026-03-01T00:00:00Z"),
          nextBillingTime: new Date(Date.now() + 20 * 86_400_000),
          snapshot: {},
          syncedAt: new Date(),
        })
        .returning({ id: subscriptions.id }),
    );
    subscriptionId = row?.id ?? "";
    await new DbPolicyStore(db).publish({
      merchantId: M,
      document: PANTRY_PLAN.policy,
      baseVersion: null,
      publishedBy: "test",
      changeNote: null,
    });
  }, 120_000);

  afterAll(async () => {
    await testDb.drop();
  }, 60_000);

  it("mounts nothing without the stream-ticket secret, so a deploy without it runs as before", async () => {
    const { server, mounted, jobs } = await start({});
    expect(mounted).toEqual({ sessions: false, mcp: false, judge: false, demoStore: false });
    expect((await server.inject({ method: "POST", url: "/v1/sessions", payload: {} })).statusCode).toBe(404);
    expect(jobs.schedule).not.toHaveBeenCalled();
  });

  it("with the secrets: a widget session starts, its stream URL carries a ticket, and cancel works", async () => {
    const { server, mounted, jobs } = await start(SECRETS);
    expect(mounted).toEqual({ sessions: true, mcp: true, judge: true, demoStore: true });
    expect(jobs.schedule).toHaveBeenCalledWith("sessions.abandon_sweep", "*/5 * * * *", {});

    const { token } = signWidgetToken(
      { merchantId: M, paypalSubscriptionId: "I-SURFACES0001" },
      SECRETS.WIDGET_TOKEN_SECRET,
      new Date(),
    );
    const auth = { authorization: `Bearer ${token}` };
    const created = await server.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: auth,
      payload: { channel: "widget" },
    });
    expect(created.statusCode).toBe(201);
    const session = CreateSessionResponse.parse(created.json());
    // No ANTHROPIC_API_KEY here: the agent starts in L1, with no model.
    expect(session.fallbackLevel).toBe("L1");
    const stream = new URL(session.streamUrl);
    expect(stream.origin).toBe("https://api.example");
    expect(stream.searchParams.get("ticket")).toBeTruthy();

    const cancel = await server.inject({
      method: "POST",
      url: `/v1/sessions/${session.sessionId}/cancel`,
      headers: auth,
      payload: {},
    });
    expect(cancel.statusCode).toBe(200);
    const { rows } = await testDb.ownerPool.query<{ type: string; subscription_id: string }>(
      "SELECT type, subscription_id FROM actions WHERE id = $1",
      [cancel.json<{ actionId: string }>().actionId],
    );
    expect(rows[0]).toEqual({ type: "cancel", subscription_id: subscriptionId });

    // A token for another merchant is refused: the widget secret belongs to the demo merchant only.
    const other = signWidgetToken(
      { merchantId: "0199a1b2-c3d4-7e5f-8a6b-000000000bbb", paypalSubscriptionId: "I-SURFACES0001" },
      SECRETS.WIDGET_TOKEN_SECRET,
      new Date(),
    );
    const refused = await server.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: `Bearer ${other.token}` },
      payload: { channel: "widget" },
    });
    expect(refused.statusCode).toBe(401);
  });

  it("serves the MCP discovery document and refuses MCP calls without a delegation token", async () => {
    const { server } = await start(SECRETS);
    const doc = await server.inject({ method: "GET", url: "/.well-known/keepwell-agent.json" });
    expect(doc.statusCode).toBe(200);
    expect(doc.json<{ mcp: { url: string } }>().mcp.url).toBe("https://api.example/mcp/subscriber");
    const mcp = await server.inject({ method: "POST", url: "/mcp/subscriber", payload: {} });
    expect(mcp.statusCode).toBe(401);
  });

  it("serves Judge Mode on the pool: a lease when one is free, pool_empty when none is", async () => {
    const pool = new FakeJudgePool();
    pool.add(M, subscriptionId, "I-SURFACES0001");
    const { server } = await start(SECRETS, pool);
    const leased = await server.inject({ method: "POST", url: "/v1/demo/leases" });
    expect(leased.statusCode).toBe(201);
    expect(JudgeLeaseResponse.parse(leased.json()).subscriptionId).toBe(subscriptionId);
    const empty = await server.inject({ method: "POST", url: "/v1/demo/leases" });
    expect(empty.statusCode).toBe(503);
  });

  it("leaves Judge Mode off without its lease secret, and says so", async () => {
    const { server, mounted } = await start({ ...SECRETS, JUDGE_LEASE_SECRET: "" });
    expect(mounted.judge).toBe(false);
    expect((await server.inject({ method: "POST", url: "/v1/demo/leases" })).statusCode).toBe(404);
  });
});
