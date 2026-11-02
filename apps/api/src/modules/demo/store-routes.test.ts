import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DemoStoreTokenResponse, DemoStoreVerifyResponse, PayPalGatewayError } from "@keepwell/contracts";
import { FakePayPalGateway, PANTRY_PLAN } from "@keepwell/contracts/fakes";
import { loadEnv } from "../../env.js";
import { buildServer } from "../../server.js";
import { signJwt, verifyWidgetToken } from "../portal/jwt.js";
import { demoStoreRoutes } from "./store-routes.js";

const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const SECRET = "test-signing-secret-of-decent-length";
const NOW = new Date("2026-10-30T10:00:00.000Z");
const STORE = "https://store.pantryplan.example";
const plans = { [PANTRY_PLAN.standard.planId]: "Standard", [PANTRY_PLAN.lite.planId]: "Lite" };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(gateway = new FakePayPalGateway(), now = NOW) {
  app = buildServer(env);
  await app.register(demoStoreRoutes, {
    prefix: "/v1",
    gateway,
    merchantId: PANTRY_PLAN.merchantId,
    plans,
    signingSecret: SECRET,
    allowOrigin: (origin) => origin === STORE,
    clock: () => now,
  });
  await app.ready();
  return app;
}

function gatewayWith(
  status: "ACTIVE" | "APPROVAL_PENDING" | "CANCELLED",
  planId = PANTRY_PLAN.standard.planId,
) {
  const gateway = new FakePayPalGateway();
  gateway.put(PANTRY_PLAN.merchantId, { id: "I-MAYA0001", plan_id: planId, status });
  return gateway;
}

const verify = (server: FastifyInstance, paypalSubscriptionId = "I-MAYA0001") =>
  server.inject({
    method: "POST",
    url: "/v1/demo-store/subscriptions",
    payload: { paypalSubscriptionId },
    headers: { origin: STORE },
  });

describe("demo store", () => {
  it("grants access only after PayPal says the subscription is live, then signs widget tokens", async () => {
    const gateway = gatewayWith("ACTIVE");
    const server = await start(gateway);
    const res = await verify(server);
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(STORE);
    const verified = DemoStoreVerifyResponse.parse(res.json());
    expect(verified).toMatchObject({
      paypalSubscriptionId: "I-MAYA0001",
      status: "ACTIVE",
      planName: "Standard",
    });
    expect(gateway.calls).toEqual([{ method: "getSubscription", merchantId: PANTRY_PLAN.merchantId }]);

    const tokenRes = await server.inject({
      method: "POST",
      url: "/v1/demo-store/token",
      payload: { shopperToken: verified.shopperToken },
    });
    expect(tokenRes.statusCode).toBe(200);
    const { token, expiresAt } = DemoStoreTokenResponse.parse(tokenRes.json());
    expect(expiresAt).toBe("2026-10-30T10:10:00.000Z");
    expect(verifyWidgetToken(token, SECRET, NOW)).toMatchObject({
      ok: true,
      claims: { mid: PANTRY_PLAN.merchantId, sid: "I-MAYA0001" },
    });
  });

  it("refuses a subscription that isn't live, isn't Pantry Plan's, or doesn't exist", async () => {
    expect((await verify(await start(gatewayWith("APPROVAL_PENDING")))).json()).toMatchObject({
      error: { code: "not_active" },
    });
    expect((await verify(await start(gatewayWith("ACTIVE", "P-SOMEONE-ELSE")))).statusCode).toBe(409);
    const missing = await verify(await start(new FakePayPalGateway()));
    expect(missing.statusCode).toBe(404);
    expect((await verify(await start(), "not-an-id")).statusCode).toBe(400);
  });

  it("answers 503 when PayPal is down, so the store can retry", async () => {
    const gateway = gatewayWith("ACTIVE");
    gateway.failNext(new PayPalGatewayError("unavailable", "timeout"));
    expect((await verify(await start(gateway))).json()).toMatchObject({
      error: { code: "paypal_unavailable" },
    });
  });

  it("signs widget tokens only for a shopper token it issued and that hasn't expired", async () => {
    const server = await start(gatewayWith("ACTIVE"));
    const token = (shopperToken: string) =>
      server.inject({ method: "POST", url: "/v1/demo-store/token", payload: { shopperToken } });

    const forged = signJwt({ kind: "shopper", mid: PANTRY_PLAN.merchantId, sid: "I-X", exp: 9e9 }, "wrong");
    expect((await token(forged)).statusCode).toBe(401);
    const expired = signJwt({ kind: "shopper", mid: PANTRY_PLAN.merchantId, sid: "I-X", exp: 1 }, SECRET);
    expect((await token(expired)).statusCode).toBe(401);
    // A widget token is not a shopper token.
    const widget = signJwt(
      { mid: PANTRY_PLAN.merchantId, sid: "I-X", iat: 1, exp: 9e9, nonce: "n".repeat(16) },
      SECRET,
    );
    expect((await token(widget)).statusCode).toBe(401);
  });
});
