import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CreateSessionResponse, type SubscriberPrincipal } from "@keepwell/contracts";
import { FakeSessionsApi, PANTRY_PLAN, pantryPlanSubscription } from "@keepwell/contracts/fakes";
import { loadEnv } from "../../env.js";
import { buildServer } from "../../server.js";
import { defaultSessionRateLimits, FixedWindowLimiter } from "./rate-limit.js";
import { sessionRoutes } from "./routes.js";

const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const maya = pantryPlanSubscription(new Date());
const principal: SubscriberPrincipal = {
  merchantId: PANTRY_PLAN.merchantId,
  subscriptionId: maya.id,
  channel: "widget",
};

describe("FixedWindowLimiter", () => {
  it("allows `limit` hits per window per key, then says how long to wait", () => {
    let t = 0;
    const l = new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }, () => t);
    expect([l.hit("a"), l.hit("a")]).toEqual([0, 0]);
    t = 15_000;
    expect(l.hit("a")).toBe(45);
    expect(l.hit("b")).toBe(0);
    t = 60_000;
    expect(l.hit("a")).toBe(0);
  });

  it("forgets finished windows", () => {
    let t = 0;
    const l = new FixedWindowLimiter({ limit: 1, windowMs: 1000 }, () => t);
    for (let i = 0; i < 100; i++) l.hit(`ip-${i}`);
    t = 5000;
    l.hit("fresh");
    expect((l as unknown as { windows: Map<string, unknown> }).windows.size).toBe(1);
  });
});

describe("session routes with rate limits (#26)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(now: () => number) {
    app = buildServer(env);
    await app.register(sessionRoutes, {
      prefix: "/v1",
      sessions: new FakeSessionsApi({ subscriptions: [maya] }),
      authenticate: () => Promise.resolve(principal),
      allowOrigin: () => false,
      rateLimits: defaultSessionRateLimits(now),
    });
    await app.ready();
    return app;
  }

  const create = (server: FastifyInstance, remoteAddress = "203.0.113.7") =>
    server.inject({ method: "POST", url: "/v1/sessions", payload: { channel: "widget" }, remoteAddress });

  it("refuses an 11th new session a minute from one IP with 429, Retry-After and the error envelope", async () => {
    let t = 0;
    const server = await start(() => t);
    for (let i = 0; i < 10; i++) expect((await create(server)).statusCode).toBe(201);
    const refused = await create(server);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("60");
    expect(refused.json()).toMatchObject({ error: { code: "limit_reached" } });

    expect((await create(server, "198.51.100.9")).statusCode).toBe(201); // another IP is unaffected
    t = 60_000;
    expect((await create(server)).statusCode).toBe(201); // and the window resets
  });

  it("limits messages, but never cancel", async () => {
    const server = await start(() => 0);
    const id = CreateSessionResponse.parse((await create(server)).json()).sessionId;
    // The session's own 3-message limit also answers 429; only the rate limit sets Retry-After.
    const limited: boolean[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await server.inject({
        method: "POST",
        url: `/v1/sessions/${id}/messages`,
        payload: { text: "hello" },
        remoteAddress: "203.0.113.7",
      });
      limited.push(res.headers["retry-after"] !== undefined);
    }
    expect(limited.indexOf(true)).toBe(30);
    expect(limited.filter(Boolean)).toHaveLength(1);

    const cancel = await server.inject({
      method: "POST",
      url: `/v1/sessions/${id}/cancel`,
      payload: {},
      remoteAddress: "203.0.113.7",
    });
    expect(cancel.statusCode).toBe(200);
  });
});
