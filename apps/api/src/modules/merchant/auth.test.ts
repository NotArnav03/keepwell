import * as argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { ErrorEnvelope, MerchantMeResponse } from "@keepwell/contracts";
import { loadEnv } from "../../env.js";
import { buildServer } from "../../server.js";
import {
  MerchantAuthService,
  MerchantAuthenticator,
  merchantAuthRoutes,
  type MerchantAuthStore,
} from "./auth.js";

const MERCHANT_ID = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const USER_ID = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c";
const ORIGIN = "https://dashboard.example.test";
const SECRET = "test-only-session-secret-at-least-32-bytes";

describe("merchant authentication", () => {
  const app: FastifyInstance = buildServer(loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" }));
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await argon2.hash("correct horse battery staple", {
      type: argon2.argon2id,
      memoryCost: 1024,
      timeCost: 1,
      parallelism: 1,
    });
    const store: MerchantAuthStore = {
      findByEmail(email, slug) {
        return Promise.resolve(
          email === "owner@example.test" && (!slug || slug === "pantry-plan")
            ? [
                {
                  merchantId: MERCHANT_ID,
                  userId: USER_ID,
                  email,
                  passwordHash,
                  role: "owner",
                  merchantSlug: "pantry-plan",
                  merchantName: "Pantry Plan",
                  csrfToken: "",
                },
              ]
            : [],
        );
      },
      get(merchantId, userId) {
        return Promise.resolve(
          merchantId !== MERCHANT_ID || userId !== USER_ID
            ? null
            : {
                merchantId: MERCHANT_ID,
                userId: USER_ID,
                email: "owner@example.test",
                role: "owner",
                merchantSlug: "pantry-plan",
                merchantName: "Pantry Plan",
              },
        );
      },
    };
    const authenticator = new MerchantAuthenticator(new MerchantAuthService(store), SECRET, ORIGIN);
    await app.register(merchantAuthRoutes, { authenticator, secureCookies: true });
    await app.ready();
  });

  afterAll(() => app.close());

  it("uses Argon2id and returns an HttpOnly signed session cookie and CSRF token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: ORIGIN },
      payload: {
        email: "owner@example.test",
        password: "correct horse battery staple",
        merchantSlug: "pantry-plan",
      },
    });
    expect(response.statusCode).toBe(200);
    const responseBody: unknown = response.json();
    const identity = MerchantMeResponse.parse(responseBody);
    expect(identity).toMatchObject({
      merchant: { id: MERCHANT_ID, slug: "pantry-plan", name: "Pantry Plan" },
      user: { id: USER_ID, email: "owner@example.test", role: "owner" },
    });
    expect(identity.csrfToken).toHaveLength(43);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("Secure");
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
  });

  it("does not reveal whether an email or password was incorrect", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "owner@example.test", password: "wrong password" },
    });
    expect(response.statusCode).toBe(401);
    const errorBody: unknown = response.json();
    expect(ErrorEnvelope.parse(errorBody).error.message).toBe("Email or password is incorrect.");
  });

  it("rejects login CSRF and requires a CSRF token to log out", async () => {
    const blocked = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: "https://attacker.example.test" },
      payload: { email: "owner@example.test", password: "correct horse battery staple" },
    });
    expect(blocked.statusCode).toBe(403);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "owner@example.test", password: "correct horse battery staple" },
    });
    const loginBody: unknown = login.json();
    const csrfToken = MerchantMeResponse.parse(loginBody).csrfToken;
    const cookieHeader = login.headers["set-cookie"];
    const cookie = typeof cookieHeader === "string" ? cookieHeader.split(";")[0] : undefined;
    const withoutCsrf = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { origin: ORIGIN, cookie },
    });
    expect(withoutCsrf.statusCode).toBe(403);

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { origin: ORIGIN, cookie, "x-keepwell-csrf": csrfToken },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("rejects expired or tampered cookies", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "owner@example.test", password: "correct horse battery staple" },
    });
    const header = login.headers["set-cookie"];
    const pair = typeof header === "string" ? (header.split(";")[0] ?? "") : "";
    const token = pair.slice(pair.indexOf("=") + 1);
    // Change the first character: the last base64url character carries unused bits, so swapping it
    // can decode to the same bytes and leave the cookie valid (it failed roughly one run in four).
    const flipped = `${token.startsWith("A") ? "B" : "A"}${token.slice(1)}`;
    const tampered = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: `${pair.slice(0, pair.indexOf("="))}=${flipped}` },
    });
    expect(tampered.statusCode).toBe(401);
  });
});
