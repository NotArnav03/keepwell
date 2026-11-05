import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { JudgeLeaseResponse, JudgeWidgetTokenResponse } from "@keepwell/contracts";
import { FakeJudgePool, PANTRY_PLAN } from "@keepwell/contracts/fakes";
import { loadEnv } from "../../env.js";
import { buildServer } from "../../server.js";
import { signJwt, verifyWidgetToken } from "../portal/jwt.js";
import { RateLimiter } from "../portal/rate-limit.js";
import { judgeRoutes, type TimeMachine } from "./judge.js";

// Judge Mode's routes on the fake pool. DbTimeMachine is covered against Postgres in
// judge.db.test.ts.

const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const M = PANTRY_PLAN.merchantId;
const SUB = "0199a1b2-0000-7000-8000-000000000001";
const LEASE_SECRET = "judge-lease-secret-long-enough";
const WIDGET_SECRET = "demo-widget-secret-long-enough";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(options: { empty?: boolean; leasesPerIp?: RateLimiter } = {}) {
  const pool = new FakeJudgePool();
  if (!options.empty) pool.add(M, SUB, "I-POOL00000001");
  const resumeNow = vi.fn((_m: string, _s: string) =>
    Promise.resolve({ actionId: "0199a1b2-0000-7000-8000-0000000000a9", note: "ran" }),
  );
  const timeMachine: TimeMachine = { resumeNow };
  app = buildServer(env);
  await app.register(judgeRoutes, {
    prefix: "/v1",
    pool,
    timeMachine,
    merchantId: M,
    leaseSecret: LEASE_SECRET,
    widgetSecret: WIDGET_SECRET,
    allowOrigin: (origin) => origin === "https://judge.keepwell.example",
    ...(options.leasesPerIp ? { leasesPerIp: options.leasesPerIp } : {}),
  });
  await app.ready();
  return { server: app, pool, resumeNow };
}

const lease = async (s: Awaited<ReturnType<typeof start>>) => {
  const res = await s.server.inject({ method: "POST", url: "/v1/demo/leases" });
  expect(res.statusCode).toBe(201);
  return JudgeLeaseResponse.parse(res.json());
};
const as = (token: string) => ({ authorization: `Bearer ${token}` });

describe("Judge Mode routes", () => {
  it("leases a pooled subscription and mints widget tokens for exactly that one", async () => {
    const s = await start();
    const leased = await lease(s);
    expect(leased.subscriptionId).toBe(SUB);

    const res = await s.server.inject({
      method: "POST",
      url: `/v1/demo/leases/${leased.leaseId}/token`,
      headers: as(leased.leaseToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { token } = JudgeWidgetTokenResponse.parse(res.json());
    const verified = verifyWidgetToken(token, WIDGET_SECRET, new Date());
    expect(verified.ok && verified.claims).toMatchObject({ mid: M, sid: "I-POOL00000001" });
  });

  it("says pool_empty when nothing is left, so the page can show the fallback", async () => {
    const s = await start({ empty: true });
    const res = await s.server.inject({ method: "POST", url: "/v1/demo/leases" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "pool_empty" } });
  });

  it("rate limits leasing per IP", async () => {
    const s = await start({ leasesPerIp: new RateLimiter({ limit: 1, windowMs: 60_000 }) });
    await lease(s);
    const res = await s.server.inject({ method: "POST", url: "/v1/demo/leases" });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("returns the lease to the pool, and the token only reaches its own lease", async () => {
    const s = await start();
    const leased = await lease(s);
    const other = "0199a1b2-0000-7000-8000-0000000000ff";
    const wrong = await s.server.inject({
      method: "DELETE",
      url: `/v1/demo/leases/${other}`,
      headers: as(leased.leaseToken),
    });
    expect(wrong.statusCode).toBe(403);

    const res = await s.server.inject({
      method: "DELETE",
      url: `/v1/demo/leases/${leased.leaseId}`,
      headers: as(leased.leaseToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: "available" });
  });

  it("refuses a missing, forged or expired lease token", async () => {
    const s = await start();
    const leased = await lease(s);
    const url = `/v1/demo/leases/${leased.leaseId}/token`;
    const iat = Math.floor(Date.now() / 1000) - 3600;
    const claims = { kind: "judge_lease", mid: M, pe: leased.leaseId, sub: SUB, sid: "I-POOL00000001" };
    for (const headers of [
      {},
      as(signJwt({ ...claims, iat, exp: iat + 7200 }, "not-the-lease-secret-at-all")),
      as(signJwt({ ...claims, iat, exp: iat + 60 }, LEASE_SECRET)),
    ]) {
      const res = await s.server.inject({ method: "POST", url, headers });
      expect(res.statusCode).toBe(401);
    }
  });

  it("runs the time machine for the leased subscription only, labelled TIME SHIFT", async () => {
    const s = await start();
    const leased = await lease(s);
    const mine = await s.server.inject({
      method: "POST",
      url: `/v1/demo/time-machine/resume/${SUB}`,
      headers: as(leased.leaseToken),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ resumed: true, label: "TIME SHIFT" });
    expect(s.resumeNow).toHaveBeenCalledWith(M, SUB);

    const theirs = await s.server.inject({
      method: "POST",
      url: "/v1/demo/time-machine/resume/0199a1b2-0000-7000-8000-0000000000ee",
      headers: as(leased.leaseToken),
    });
    expect(theirs.statusCode).toBe(403);
  });

  it("answers the judge page's preflight from its origin only", async () => {
    const s = await start();
    const res = await s.server.inject({
      method: "OPTIONS",
      url: "/v1/demo/leases",
      headers: { origin: "https://judge.keepwell.example", "access-control-request-method": "POST" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://judge.keepwell.example");
    const other = await s.server.inject({
      method: "OPTIONS",
      url: "/v1/demo/leases",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
