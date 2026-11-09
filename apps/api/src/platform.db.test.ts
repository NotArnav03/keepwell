import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PANTRY_PLAN } from "@keepwell/contracts/fakes";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { loadEnv } from "./env.js";
import { startPlatform, type Platform } from "./platform.js";

// The composition root boots against a real database with the PayPal mock, and the subscriber
// surfaces answer where the widget, Pantry Plan and a subscriber's agent look for them. No network
// calls: the mock is never reached by these requests.

const STORE = "https://keepwell-store-staging.onrender.com";
const PORTAL = "https://keepwell-portal-staging.onrender.com/";

describe.skipIf(TEST_DATABASE_URL === undefined)(
  "startPlatform: subscriber surfaces",
  { timeout: 120_000 },
  () => {
    let testDb: TestDatabase;
    let platform: Platform;

    beforeAll(async () => {
      testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
      platform = await startPlatform(
        loadEnv({
          NODE_ENV: "test",
          LOG_LEVEL: "silent",
          APP_ENV: "local",
          DATABASE_URL_UNPOOLED: testDb.url,
          PAYPAL_USE_MOCK: "true",
          API_PUBLIC_URL: "https://api.example/",
          SESSION_TICKET_SECRET: "t".repeat(40),
          WIDGET_TOKEN_SECRET: "w".repeat(40),
          DEMO_MERCHANT_ID: PANTRY_PLAN.merchantId,
          DEMO_STORE_URL: STORE,
          PORTAL_URL: PORTAL,
          MAGIC_LINK_SECRET: "m".repeat(40),
        }),
      );
      await platform.app.ready();
    }, 120_000);

    afterAll(async () => {
      await platform?.stop();
      await testDb?.drop();
    }, 60_000);

    it("serves the MCP discovery document and refuses MCP calls without a delegation token", async () => {
      const doc = await platform.app.inject({ method: "GET", url: "/.well-known/keepwell-agent.json" });
      expect(doc.statusCode).toBe(200);
      expect(doc.json<{ mcp: { url: string } }>().mcp.url).toBe("https://api.example/mcp/subscriber");
      const mcp = await platform.app.inject({ method: "POST", url: "/mcp/subscriber", payload: {} });
      expect(mcp.statusCode).toBe(401);
    });

    it("mounts the portal: sign-in requests always answer 202, a bad link goes back to the portal", async () => {
      const request = await platform.app.inject({
        method: "POST",
        url: "/v1/portal/magic-link",
        payload: { merchantSlug: "nobody", email: "maya@example.com" },
      });
      expect(request.statusCode).toBe(202);
      const verify = await platform.app.inject({ method: "GET", url: "/v1/portal/verify?token=not-a-link" });
      expect(verify.statusCode).toBe(302);
      expect(verify.headers.location).toBe(`${PORTAL}?error=link_expired`);
    });

    it("lets only the portal's origin send its cookie", async () => {
      const preflight = (origin: string) =>
        platform.app.inject({
          method: "OPTIONS",
          url: "/v1/portal/me",
          headers: { origin, "access-control-request-method": "GET" },
        });
      const allowed = await preflight(new URL(PORTAL).origin);
      expect(allowed.headers["access-control-allow-origin"]).toBe(new URL(PORTAL).origin);
      expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
      const other = await preflight("https://elsewhere.example");
      expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("serves Pantry Plan's backend to the store's origin only", async () => {
      const preflight = (origin: string) =>
        platform.app.inject({
          method: "OPTIONS",
          url: "/v1/demo-store/subscriptions",
          headers: { origin, "access-control-request-method": "POST" },
        });
      const allowed = await preflight(STORE);
      expect(allowed.statusCode).toBe(204);
      expect(allowed.headers["access-control-allow-origin"]).toBe(STORE);
      const other = await preflight("https://elsewhere.example");
      expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    });
  },
);
