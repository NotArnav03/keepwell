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
