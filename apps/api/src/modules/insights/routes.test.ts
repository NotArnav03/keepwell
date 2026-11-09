import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ErrorEnvelope } from "@keepwell/contracts";
import { loadEnv } from "../../env.js";
import { buildServer } from "../../server.js";
import { insightsRoutes } from "./routes.js";
import type { DateRange, InsightsResponse } from "./queries.js";

const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const merchantId = "0199b000-0000-7000-8000-00000000000a";

interface Call {
  merchantId: string;
  range: DateRange;
  limit: number;
}

const empty = (range: DateRange): InsightsResponse => ({
  range,
  total: 0,
  byWeek: [],
  byPlan: [],
  byReason: [],
  byOutcome: [],
  topQuotes: [],
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const overviewCalls: { merchantId: string; range: DateRange }[] = [];

async function start(calls: Call[] = []): Promise<FastifyInstance> {
  const server = buildServer(env);
  await server.register(insightsRoutes, {
    prefix: "/v1/m",
    authenticate: (req) =>
      req.headers.cookie
        ? Promise.resolve({ merchantId })
        : Promise.reject(Object.assign(new Error("sign in"), { statusCode: 401 })),
    load: (m, range, limit) => {
      calls.push({ merchantId: m, range, limit });
      return Promise.resolve(empty(range));
    },
    loadOverview: (m, range) => {
      overviewCalls.push({ merchantId: m, range });
      return Promise.resolve({
        from: `${range.from}T00:00:00.000Z`,
        to: `${range.to}T23:59:59.999Z`,
        mrrSaved: { value: "12.00", currency: "USD" },
        saveRate: { savedSessions: 2, eligibleSessions: 3 },
        recoveredRevenue: { value: "0.00", currency: "USD" },
        outcomesByOffer: [{ offer: "pause", count: 2 }],
        outcomesByReason: [{ reason: "price", count: 3 }],
      });
    },
  });
  app = server;
  return server;
}

describe("GET /v1/m/insights", () => {
  it("validates the query, scopes by the authenticated merchant and validates the response", async () => {
    const calls: Call[] = [];
    const res = await (
      await start(calls)
    ).inject({
      method: "GET",
      url: "/v1/m/insights?from=2026-10-01&to=2026-10-31",
      headers: { cookie: "s=1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 0, range: { from: "2026-10-01", to: "2026-10-31" } });
    expect(calls).toEqual([{ merchantId, range: { from: "2026-10-01", to: "2026-10-31" }, limit: 10 }]);
  });

  it.each(["", "?from=2026-10-01", "?from=nope&to=2026-10-02", "?from=2026-11-01&to=2026-10-01"])(
    "rejects bad query %s with the error envelope",
    async (qs) => {
      const res = await (
        await start()
      ).inject({ method: "GET", url: `/v1/m/insights${qs}`, headers: { cookie: "s=1" } });
      expect(res.statusCode).toBe(400);
      expect(ErrorEnvelope.parse(res.json()).error.code).toBe("invalid_request");
    },
  );

  it("returns 401 without a session", async () => {
    const res = await (
      await start()
    ).inject({ method: "GET", url: "/v1/m/insights?from=2026-10-01&to=2026-10-02" });
    expect(res.statusCode).toBe(401);
    expect(ErrorEnvelope.parse(res.json()).error.code).toBe("unauthorized");
  });
});

describe("GET /v1/m/overview", () => {
  const url = "/v1/m/overview?from=2026-10-10T00:00:00.000Z&to=2026-11-09T12:30:00.000Z";

  it("takes the dashboard's date-times, scopes by the signed-in merchant and validates the response", async () => {
    overviewCalls.length = 0;
    const res = await (await start()).inject({ method: "GET", url, headers: { cookie: "s=1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      mrrSaved: { value: "12.00", currency: "USD" },
      saveRate: { savedSessions: 2, eligibleSessions: 3 },
    });
    expect(overviewCalls).toEqual([{ merchantId, range: { from: "2026-10-10", to: "2026-11-09" } }]);
  });

  it.each([
    "",
    "?from=2026-10-10",
    "?from=nope&to=also",
    "?from=2026-11-09T00:00:00.000Z&to=2026-10-10T00:00:00.000Z",
  ])("rejects bad query %s with the error envelope", async (qs) => {
    const res = await (
      await start()
    ).inject({ method: "GET", url: `/v1/m/overview${qs}`, headers: { cookie: "s=1" } });
    expect(res.statusCode).toBe(400);
    expect(ErrorEnvelope.parse(res.json()).error.code).toBe("invalid_request");
  });

  it("returns 401 without a session", async () => {
    const res = await (await start()).inject({ method: "GET", url });
    expect(res.statusCode).toBe(401);
  });
});
