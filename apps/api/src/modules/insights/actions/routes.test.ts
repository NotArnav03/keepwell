import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ErrorEnvelope } from "@keepwell/contracts";
import { FakeActionEngine, FakeAudit, FakeDomainEvents } from "@keepwell/contracts/fakes";
import { loadEnv } from "../../../env.js";
import { buildServer } from "../../../server.js";
import { DeterministicEstimateProvider } from "./estimate.js";
import { insightActionRoutes } from "./routes.js";
import { InsightActionError, InsightActionService, type MerchantPrincipal } from "./service.js";
import { InMemoryInsightActionStore } from "./store.js";

const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const M1 = "0199a1b2-c3d4-7e5f-8a6b-0000000000a1";
const M2 = "0199a1b2-c3d4-7e5f-8a6b-0000000000a2";
const monthly = { unit: "MONTH", count: 1 } as const;
const createPlan = {
  kind: "create_plan",
  params: {
    name: "Basics",
    description: null,
    price: { value: "4.00", currency: "USD" },
    interval: monthly,
    basedOnPaypalPlanId: "P-STANDARD",
  },
} as const;

let app: FastifyInstance;
let service: InsightActionService;
let engine: FakeActionEngine;

beforeEach(async () => {
  engine = new FakeActionEngine();
  service = new InsightActionService({
    store: new InMemoryInsightActionStore(),
    estimates: new DeterministicEstimateProvider({
      priceCancellations: () => Promise.resolve(23),
      planFootprints: () => Promise.resolve([]),
    }),
    engine,
    audit: new FakeAudit(),
    events: new FakeDomainEvents(),
    policy: { publishChanges: () => Promise.resolve({ version: 2 }) },
    winback: { send: () => Promise.resolve({ queued: 0, skipped: [] }) },
    products: { productIdFor: () => Promise.resolve("PROD-1") },
    log: { info: () => {}, error: () => {} },
  });
  app = buildServer(env);
  // The fake "session": the merchant is named by a header, and no header means signed out.
  const authenticate = (request: { headers: Record<string, unknown> }): Promise<MerchantPrincipal> => {
    const merchantId = request.headers["x-test-merchant"];
    if (typeof merchantId !== "string")
      return Promise.reject(new InsightActionError("unauthorized", "Sign in first"));
    return Promise.resolve({ merchantId, userLabel: "owner@pantry.example" });
  };
  await app.register(insightActionRoutes, { prefix: "/v1/m", service, authenticate });
  await app.ready();
});
afterEach(() => app.close());

const as = (merchantId: string) => ({ "x-test-merchant": merchantId });

describe("/v1/m/insight-actions", () => {
  it("lists a merchant's actions, filtered by state, and nobody else's", async () => {
    const mine = await service.propose(M1, createPlan, "copilot", "why");
    await service.propose(M2, createPlan, "copilot");
    const all = await app.inject({ method: "GET", url: "/v1/m/insight-actions", headers: as(M1) });
    expect(all.statusCode).toBe(200);
    expect(all.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual([mine.id]);
    expect(all.json<{ items: unknown[] }>().items[0]).toMatchObject({
      state: "proposed",
      estimate: { monthlyRevenueImpact: { value: "27.60", currency: "USD" } },
      execution: { status: "not_applicable" },
    });

    const none = await app.inject({
      method: "GET",
      url: "/v1/m/insight-actions?state=executed",
      headers: as(M1),
    });
    expect(none.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it("rejects an unknown state filter with the error envelope", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/m/insight-actions?state=bogus",
      headers: as(M1),
    });
    expect(res.statusCode).toBe(400);
    expect(ErrorEnvelope.parse(res.json()).error.code).toBe("invalid_request");
  });

  it("approve runs it once; a second approve is a 409", async () => {
    const { id } = await service.propose(M1, createPlan, "copilot");
    const first = await app.inject({
      method: "POST",
      url: `/v1/m/insight-actions/${id}/approve`,
      headers: as(M1),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id, state: "executed", actionId: engine.actions[0]?.id });
    const second = await app.inject({
      method: "POST",
      url: `/v1/m/insight-actions/${id}/approve`,
      headers: as(M1),
    });
    expect(second.statusCode).toBe(409);
    expect(ErrorEnvelope.parse(second.json()).error.code).toBe("conflict");
    expect(engine.actions).toHaveLength(1);
  });

  it("reject marks it rejected, and an approve after that is a 409", async () => {
    const { id } = await service.propose(M1, createPlan, "copilot");
    const rejected = await app.inject({
      method: "POST",
      url: `/v1/m/insight-actions/${id}/reject`,
      headers: as(M1),
    });
    expect(rejected.json<{ state: string }>().state).toBe("rejected");
    const approve = await app.inject({
      method: "POST",
      url: `/v1/m/insight-actions/${id}/approve`,
      headers: as(M1),
    });
    expect(approve.statusCode).toBe(409);
  });

  it("another merchant gets a 404, not a peek", async () => {
    const { id } = await service.propose(M1, createPlan, "copilot");
    const res = await app.inject({
      method: "POST",
      url: `/v1/m/insight-actions/${id}/approve`,
      headers: as(M2),
    });
    expect(res.statusCode).toBe(404);
    expect(engine.actions).toHaveLength(0);
  });

  it("answers 401 without a merchant and 400 for a bad id", async () => {
    const signedOut = await app.inject({ method: "GET", url: "/v1/m/insight-actions" });
    expect(signedOut.statusCode).toBe(401);
    expect(ErrorEnvelope.parse(signedOut.json()).error.code).toBe("unauthorized");
    const bad = await app.inject({
      method: "POST",
      url: "/v1/m/insight-actions/nope/approve",
      headers: as(M1),
    });
    expect(bad.statusCode).toBe(400);
  });
});
