import * as argon2 from "argon2";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MerchantFeedTicketResponse, MerchantMeResponse } from "@keepwell/contracts";
import type { Db } from "@keepwell/db";
import { loadEnv } from "../../env.js";
import { buildServer } from "../../server.js";
import {
  FEED_TICKET_TTL_SECONDS,
  MerchantAuthError,
  MerchantAuthService,
  MerchantAuthenticator,
  merchantAuthRoutes,
  type MerchantAuthStore,
} from "./auth.js";
import { merchantDataRoutes } from "./data-routes.js";
import type { FeedHub } from "./feed-hub.js";

// The live feed's stream URL: Render's static-site rewrite buffers streams, so the dashboard opens
// the feed on the API's own host with a read-only ticket instead of the SameSite cookie.

const MERCHANT_ID = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const USER_ID = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c";
const ORIGIN = "https://dashboard.example.test";
const SECRET = "test-only-session-secret-at-least-32-bytes";
const PASSWORD = "correct horse battery staple";
const API_PUBLIC_URL = "https://api.example.test";

function storeWith(passwordHash: string, users = { deleted: false }): MerchantAuthStore {
  const user = {
    merchantId: MERCHANT_ID,
    userId: USER_ID,
    email: "owner@example.test",
    role: "owner" as const,
    merchantSlug: "pantry-plan",
    merchantName: "Pantry Plan",
  };
  return {
    findByEmail: (email) =>
      Promise.resolve(email === user.email ? [{ ...user, passwordHash, csrfToken: "" }] : []),
    get: (merchantId, userId) =>
      Promise.resolve(!users.deleted && merchantId === MERCHANT_ID && userId === USER_ID ? user : null),
  };
}

const cookieRequest = (value: string) =>
  ({ headers: { cookie: `keepwell_merchant=${value}` } }) as unknown as FastifyRequest;

describe("feed tickets", () => {
  let clock = Date.parse("2026-11-12T00:00:00Z");
  const users = { deleted: false };
  let authenticator: MerchantAuthenticator;

  beforeAll(async () => {
    const hash = await argon2.hash(PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 1024,
      timeCost: 1,
      parallelism: 1,
    });
    authenticator = new MerchantAuthenticator(
      new MerchantAuthService(storeWith(hash, users)),
      SECRET,
      ORIGIN,
      () => clock,
    );
  });

  it("names the signed-in user's merchant until it expires an hour later", async () => {
    const { ticket, expiresAt } = authenticator.feedTicket({ merchantId: MERCHANT_ID, userId: USER_ID });
    expect(expiresAt.getTime()).toBe(clock + FEED_TICKET_TTL_SECONDS * 1000);
    await expect(authenticator.authenticateFeedTicket(ticket)).resolves.toMatchObject({
      merchantId: MERCHANT_ID,
      userId: USER_ID,
    });
    clock += FEED_TICKET_TTL_SECONDS * 1000;
    await expect(authenticator.authenticateFeedTicket(ticket)).rejects.toBeInstanceOf(MerchantAuthError);
    clock = Date.parse("2026-11-12T00:00:00Z");
  });

  it("refuses a tampered ticket, and one for a user who no longer exists", async () => {
    const { ticket } = authenticator.feedTicket({ merchantId: MERCHANT_ID, userId: USER_ID });
    const [body, sig] = ticket.split(".") as [string, string];
    const forged = `${body}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    await expect(authenticator.authenticateFeedTicket(forged)).rejects.toMatchObject({ status: 401 });
    users.deleted = true;
    await expect(authenticator.authenticateFeedTicket(ticket)).rejects.toMatchObject({ status: 401 });
    users.deleted = false;
  });

  it("can never stand in for the session cookie, which unlocks writes", async () => {
    const { ticket } = authenticator.feedTicket({ merchantId: MERCHANT_ID, userId: USER_ID });
    await expect(authenticator.authenticate(cookieRequest(ticket))).rejects.toMatchObject({ status: 401 });
  });
});

describe("POST /v1/m/feed/ticket and GET /v1/m/feed?ticket=", () => {
  let app: FastifyInstance;
  let base: string;

  beforeAll(async () => {
    const hash = await argon2.hash(PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 1024,
      timeCost: 1,
      parallelism: 1,
    });
    const authenticator = new MerchantAuthenticator(new MerchantAuthService(storeWith(hash)), SECRET, ORIGIN);
    app = buildServer(loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", DASHBOARD_URL: ORIGIN }));
    await app.register(merchantAuthRoutes, { prefix: "/v1/m", authenticator, secureCookies: false });
    // No events yet: the stream only sends its heartbeat.
    const db = { forMerchant: () => Promise.resolve([]) } as unknown as Db;
    const feed: FeedHub = { subscribe: () => () => {} };
    await app.register(merchantDataRoutes, {
      prefix: "/v1/m",
      db,
      apiPublicUrl: API_PUBLIC_URL,
      feed,
      audit: { list: () => Promise.reject(new Error("unused")) },
      authenticator,
    });
    // A real socket: inject() waits for the response to end, and a stream never does.
    base = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(() => app.close());

  async function signIn(): Promise<{ cookie: string; csrf: string }> {
    const login = await app.inject({
      method: "POST",
      url: "/v1/m/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "owner@example.test", password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    return { cookie, csrf: MerchantMeResponse.parse(login.json()).csrfToken };
  }

  it("issues a stream URL on the API's own host, only with the session and its CSRF token", async () => {
    const { cookie, csrf } = await signIn();
    const noCsrf = await app.inject({
      method: "POST",
      url: "/v1/m/feed/ticket",
      headers: { cookie, origin: ORIGIN },
    });
    expect(noCsrf.statusCode).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: "/v1/m/feed/ticket",
      headers: { cookie, origin: ORIGIN, "x-keepwell-csrf": csrf },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    const { streamUrl } = MerchantFeedTicketResponse.parse(ok.json());
    expect(streamUrl.startsWith(`${API_PUBLIC_URL}/v1/m/feed?ticket=`)).toBe(true);
  });

  it("streams to the dashboard's origin with the ticket alone, with the CORS headers it needs", async () => {
    const { cookie, csrf } = await signIn();
    const issued = await app.inject({
      method: "POST",
      url: "/v1/m/feed/ticket",
      headers: { cookie, origin: ORIGIN, "x-keepwell-csrf": csrf },
    });
    const { streamUrl } = MerchantFeedTicketResponse.parse(issued.json());
    const controller = new AbortController();
    const { pathname, search } = new URL(streamUrl);
    const response = await fetch(`${base}${pathname}${search}`, {
      headers: { origin: ORIGIN },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // Dropped by hijack() before this change, which a cross-origin EventSource can't do without.
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    controller.abort();
  });

  it("refuses the stream with neither a cookie nor a valid ticket", async () => {
    const response = await fetch(`${base}/v1/m/feed?ticket=not-a-ticket`, { headers: { origin: ORIGIN } });
    expect(response.status).toBe(401);
    expect((await fetch(`${base}/v1/m/feed`)).status).toBe(401);
  });
});
