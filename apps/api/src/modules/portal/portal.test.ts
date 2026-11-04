import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  CreateDelegationResponse,
  DELEGATION_TTL_SECONDS,
  PortalMe,
  PortalTokenResponse,
  type PortalSubscription,
} from "@keepwell/contracts";
import { loadEnv } from "../../env.js";
import { buildServer } from "../../server.js";
import { DelegationService } from "./delegations.js";
import { signJwt, verifyPortalSessionToken } from "./jwt.js";
import { MagicLinkService } from "./magic-link.js";
import {
  MemoryDelegationStore,
  MemoryMagicLinkStore,
  MemoryPortalDirectory,
  RecordingMailer,
} from "./memory.js";
import { portalRoutes, type Limiters } from "./routes.js";
import { hashEmail } from "./tokens.js";

const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const SECRET = "test-signing-secret-of-decent-length";
const PORTAL = "https://portal.keepwell.example";
const MERCHANT = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const MAYA_SUB = "0199a1b2-0000-7000-8000-000000000001";
const OTHER_SUB = "0199a1b2-0000-7000-8000-000000000002";
const MAYA = "maya@example.com";
const MAYA_PLAN: PortalSubscription = {
  id: MAYA_SUB,
  planName: "Standard",
  price: { value: "12.00", currency: "USD" },
  interval: { unit: "MONTH", count: 1 },
  status: "ACTIVE",
  nextBillingTime: "2026-11-19T10:00:00.000Z",
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(options: { limiters?: Partial<Limiters>; failMail?: boolean } = {}) {
  let now = new Date("2026-11-02T10:00:00.000Z");
  const directory = new MemoryPortalDirectory()
    .addMerchant("pantry-plan", MERCHANT)
    .addSubscription(MERCHANT, hashEmail(MAYA), MAYA_SUB, MAYA_PLAN);
  const delegationStore = new MemoryDelegationStore();
  const mailer = new RecordingMailer(() => {
    if (options.failMail) throw new Error("smtp down");
  });
  const clock = () => now;
  const magicLinks = new MagicLinkService({
    directory,
    store: new MemoryMagicLinkStore(),
    mailer,
    verifyUrl: (token) => `https://api.keepwell.example/v1/portal/verify?token=${token}`,
    clock,
  });
  const delegations = new DelegationService({ store: delegationStore, directory, clock });
  app = buildServer(env);
  await app.register(portalRoutes, {
    prefix: "/v1",
    directory,
    magicLinks,
    delegations,
    signingSecret: SECRET,
    portalUrl: `${PORTAL}/account`,
    allowOrigin: (origin) => origin === PORTAL,
    clock,
    limiters: options.limiters,
  });
  await app.ready();
  return {
    server: app,
    mailer,
    delegations,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

type Server = Awaited<ReturnType<typeof start>>;

const requestLink = (s: Server, email = MAYA, merchantSlug = "pantry-plan") =>
  s.server.inject({ method: "POST", url: "/v1/portal/magic-link", payload: { merchantSlug, email } });

const tokenOf = (url: string) => new URL(url).searchParams.get("token") ?? "";

/** Clicks the emailed link and returns the PORTAL cookie it set. */
async function signIn(s: Server): Promise<string> {
  await requestLink(s);
  const link = s.mailer.sent.at(-1);
  const res = await s.server.inject({
    method: "GET",
    url: `/v1/portal/verify?token=${tokenOf(link?.url ?? "")}`,
  });
  const cookie = String(res.headers["set-cookie"]).split(";")[0];
  if (cookie === undefined) throw new Error("no cookie set");
  return cookie;
}

const createDelegation = (
  s: Server,
  cookie: string | null,
  body: object = { subscriptionId: MAYA_SUB, scopes: ["read", "cancel"] },
  origin: string | null = PORTAL,
) =>
  s.server.inject({
    method: "POST",
    url: "/v1/delegations",
    payload: body,
    headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
  });

describe("magic links", () => {
  it("emails a single-use link to the address PayPal holds", async () => {
    const s = await start();
    const res = await requestLink(s, "  Maya@Example.com ");
    expect(res.statusCode).toBe(202);
    expect(s.mailer.sent).toHaveLength(1);
    expect(s.mailer.sent[0]).toMatchObject({ merchantId: MERCHANT, to: "Maya@Example.com" });
    expect(s.mailer.sent[0]?.expiresAt.toISOString()).toBe("2026-11-02T10:15:00.000Z");
  });

  it("answers 202 with the same empty body whether or not the email is a subscriber's", async () => {
    const s = await start();
    const known = await requestLink(s);
    const unknownEmail = await requestLink(s, "stranger@example.com");
    const unknownMerchant = await requestLink(s, MAYA, "no-such-shop");
    for (const res of [known, unknownEmail, unknownMerchant]) {
      expect(res.statusCode).toBe(202);
      expect(res.body).toBe("");
    }
    expect(s.mailer.sent).toHaveLength(1);
  });

  it("still answers 202 when sending the email fails", async () => {
    const s = await start({ failMail: true });
    expect((await requestLink(s)).statusCode).toBe(202);
  });

  it("signs the subscriber in once, with a hardened cookie", async () => {
    const s = await start();
    await requestLink(s);
    const url = `/v1/portal/verify?token=${tokenOf(s.mailer.sent[0]?.url ?? "")}`;
    const first = await s.server.inject({ method: "GET", url });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe(`${PORTAL}/account`);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers["referrer-policy"]).toBe("no-referrer");
    const cookie = String(first.headers["set-cookie"]);
    expect(cookie).toMatch(/^kw_portal=[\w-]+\.[\w-]+\.[\w-]+;/);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=86400"]) {
      expect(cookie).toContain(attribute);
    }

    const second = await s.server.inject({ method: "GET", url });
    expect(second.statusCode).toBe(302);
    expect(second.headers.location).toBe(`${PORTAL}/account?error=link_expired`);
    expect(second.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a link after 15 minutes, and a made-up one", async () => {
    const s = await start();
    await requestLink(s);
    const url = `/v1/portal/verify?token=${tokenOf(s.mailer.sent[0]?.url ?? "")}`;
    s.advance(15 * 60_000);
    expect((await s.server.inject({ method: "GET", url })).headers.location).toContain("error=link_expired");
    const forged = await s.server.inject({ method: "GET", url: "/v1/portal/verify?token=nope" });
    expect(forged.headers.location).toContain("error=link_expired");
    expect((await s.server.inject({ method: "GET", url: "/v1/portal/verify" })).statusCode).toBe(400);
  });

  it("rate limits per email, and the answer doesn't depend on whether it matches", async () => {
    const s = await start();
    for (let i = 0; i < 5; i++) expect((await requestLink(s, "stranger@example.com")).statusCode).toBe(202);
    const limited = await requestLink(s, "stranger@example.com");
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);

    for (let i = 0; i < 5; i++) expect((await requestLink(s)).statusCode).toBe(202);
    expect((await requestLink(s)).statusCode).toBe(429);
  });

  it("rate limits per IP across emails, and on verify", async () => {
    const s = await start();
    for (let i = 0; i < 20; i++) expect((await requestLink(s, `user${i}@example.com`)).statusCode).toBe(202);
    expect((await requestLink(s, "one-more@example.com")).statusCode).toBe(429);

    const t = await start();
    for (let i = 0; i < 30; i++) await t.server.inject({ method: "GET", url: "/v1/portal/verify?token=x" });
    expect((await t.server.inject({ method: "GET", url: "/v1/portal/verify?token=x" })).statusCode).toBe(429);
  });
});

describe("delegations", () => {
  it("mints a scoped token, shown once, that authenticates only for its scopes", async () => {
    const s = await start();
    const res = await createDelegation(s, await signIn(s));
    expect(res.statusCode).toBe(201);
    const created = CreateDelegationResponse.parse(res.json());
    expect(created.token).toMatch(/^kwd_[\w-]{43}$/);
    expect(created.scopes).toEqual(["read", "cancel"]);
    expect(created.expiresAt).toBe("2026-11-09T10:00:00.000Z");

    expect(await s.delegations.authenticate(created.token, "cancel")).toEqual({
      merchantId: MERCHANT,
      subscriptionId: MAYA_SUB,
      scopes: ["read", "cancel"],
    });
    expect(await s.delegations.authenticate(created.token, "accept_offer")).toBeNull();
    expect(await s.delegations.authenticate("kwd_" + "x".repeat(43), "read")).toBeNull();
    expect(await s.delegations.authenticate("not-a-delegation", "read")).toBeNull();
  });

  it("expires after 7 days", async () => {
    const s = await start();
    const created = CreateDelegationResponse.parse((await createDelegation(s, await signIn(s))).json());
    s.advance(DELEGATION_TTL_SECONDS * 1000 - 1);
    expect(await s.delegations.authenticate(created.token, "read")).not.toBeNull();
    s.advance(1);
    expect(await s.delegations.authenticate(created.token, "read")).toBeNull();
  });

  it("can be revoked, and only by the subscriber it belongs to", async () => {
    const s = await start();
    const cookie = await signIn(s);
    const created = CreateDelegationResponse.parse((await createDelegation(s, cookie)).json());
    const revoke = (id: string, who: string | null = cookie) =>
      s.server.inject({
        method: "DELETE",
        url: `/v1/delegations/${id}`,
        headers: { ...(who ? { cookie: who } : {}), origin: PORTAL },
      });

    expect((await revoke(created.id, null)).statusCode).toBe(401);
    expect(await s.delegations.authenticate(created.token, "read")).not.toBeNull();
    expect((await revoke("0199a1b2-0000-7000-8000-0000000000ff")).statusCode).toBe(404);
    expect((await revoke("not-a-uuid")).statusCode).toBe(400);
    expect((await revoke(created.id)).statusCode).toBe(204);
    expect(await s.delegations.authenticate(created.token, "read")).toBeNull();
    // Revoking again is harmless.
    expect((await revoke(created.id)).statusCode).toBe(204);
  });

  it("won't mint for a subscription the signed-in email doesn't own, or revoke someone else's", async () => {
    const s = await start();
    const cookie = await signIn(s);
    const foreign = await createDelegation(s, cookie, { subscriptionId: OTHER_SUB, scopes: ["read"] });
    expect(foreign.statusCode).toBe(403);

    const created = CreateDelegationResponse.parse((await createDelegation(s, cookie)).json());
    // Same merchant, different subscriber: their session can't see this delegation.
    const stranger = signJwtFor(hashEmail("stranger@example.com"));
    const res = await s.server.inject({
      method: "DELETE",
      url: `/v1/delegations/${created.id}`,
      headers: { cookie: `kw_portal=${stranger}`, origin: PORTAL },
    });
    expect(res.statusCode).toBe(404);
    expect(await s.delegations.authenticate(created.token, "read")).not.toBeNull();
  });

  it("needs a valid PORTAL cookie and the portal's origin", async () => {
    const s = await start();
    const cookie = await signIn(s);
    expect((await createDelegation(s, null)).statusCode).toBe(401);
    expect((await createDelegation(s, "kw_portal=garbage")).statusCode).toBe(401);
    expect((await createDelegation(s, cookie, undefined, null)).statusCode).toBe(403);
    expect((await createDelegation(s, cookie, undefined, "https://evil.example")).statusCode).toBe(403);

    // A cookie signed with the wrong secret, and a real one past its day.
    expect(
      (await createDelegation(s, `kw_portal=${signJwtFor(hashEmail(MAYA), "other-secret-of-some-length")}`))
        .statusCode,
    ).toBe(401);
    s.advance(24 * 3600_000);
    expect((await createDelegation(s, cookie)).statusCode).toBe(401);
  });

  it("validates scopes", async () => {
    const s = await start();
    const cookie = await signIn(s);
    for (const scopes of [[], ["read", "read"], ["root"], ["read", "cancel", "accept_offer", "read"]]) {
      const res = await createDelegation(s, cookie, { subscriptionId: MAYA_SUB, scopes });
      expect(res.statusCode).toBe(400);
    }
  });

  it("rate limits minting per signed-in subscriber", async () => {
    const s = await start();
    const cookie = await signIn(s);
    for (let i = 0; i < 10; i++) expect((await createDelegation(s, cookie)).statusCode).toBe(201);
    expect((await createDelegation(s, cookie)).statusCode).toBe(429);
  });
});

function signJwtFor(emailHash: string, secret = SECRET): string {
  const iat = Math.floor(Date.parse("2026-11-02T10:00:00.000Z") / 1000);
  return signJwt({ kind: "portal", mid: MERCHANT, eh: emailHash, iat, exp: iat + 3600 }, secret);
}

const asPortal = (s: Server, method: "GET" | "POST", url: string, cookie: string | null, payload?: object) =>
  s.server.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: { origin: PORTAL, ...(cookie ? { cookie } : {}) },
  });

describe("the signed-in portal page", () => {
  it("shows the subscriptions on the email and only the live delegations", async () => {
    const s = await start();
    const cookie = await signIn(s);
    const kept = CreateDelegationResponse.parse((await createDelegation(s, cookie)).json());
    const gone = CreateDelegationResponse.parse((await createDelegation(s, cookie)).json());
    await s.server.inject({
      method: "DELETE",
      url: `/v1/delegations/${gone.id}`,
      headers: { cookie, origin: PORTAL },
    });

    const res = await asPortal(s, "GET", "/v1/portal/me", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const me = PortalMe.parse(res.json());
    expect(me.subscriptions).toEqual([MAYA_PLAN]);
    expect(me.delegations.map((d) => d.id)).toEqual([kept.id]);
    expect(JSON.stringify(me)).not.toContain(kept.token);

    s.advance((DELEGATION_TTL_SECONDS + 1) * 1000);
    // The session cookie is gone by then too; the expiry rule is the delegation's own.
    expect(await s.delegations.list({ merchantId: MERCHANT, emailHash: hashEmail(MAYA) })).toEqual([]);
  });

  it("needs the cookie and the portal's origin", async () => {
    const s = await start();
    expect((await asPortal(s, "GET", "/v1/portal/me", null)).statusCode).toBe(401);
    const cookie = await signIn(s);
    const noOrigin = await s.server.inject({ method: "GET", url: "/v1/portal/me", headers: { cookie } });
    expect(noOrigin.statusCode).toBe(403);
  });

  it("mints a 10-minute token for one subscription the email owns, and refuses others", async () => {
    const s = await start();
    const cookie = await signIn(s);
    const res = await asPortal(s, "POST", "/v1/portal/token", cookie, { subscriptionId: MAYA_SUB });
    expect(res.statusCode).toBe(200);
    const { token, expiresAt } = PortalTokenResponse.parse(res.json());
    expect(expiresAt).toBe("2026-11-02T10:10:00.000Z");
    const verified = verifyPortalSessionToken(token, SECRET, new Date("2026-11-02T10:05:00.000Z"));
    expect(verified.ok && verified.claims).toMatchObject({ mid: MERCHANT, sub: MAYA_SUB });
    expect(verifyPortalSessionToken(token, SECRET, new Date("2026-11-02T10:11:00.000Z"))).toMatchObject({
      ok: false,
      failure: "expired",
    });
    expect(verifyPortalSessionToken(token, "another-secret-of-decent-length", new Date()).ok).toBe(false);

    const foreign = await asPortal(s, "POST", "/v1/portal/token", cookie, { subscriptionId: OTHER_SUB });
    expect(foreign.statusCode).toBe(403);
    expect(
      (await asPortal(s, "POST", "/v1/portal/token", null, { subscriptionId: MAYA_SUB })).statusCode,
    ).toBe(401);
  });

  it("signs out by clearing the cookie", async () => {
    const s = await start();
    const res = await asPortal(s, "POST", "/v1/portal/logout", null);
    expect(res.statusCode).toBe(204);
    expect(String(res.headers["set-cookie"])).toMatch(/kw_portal=;.*Max-Age=0/);
    const foreign = await s.server.inject({
      method: "POST",
      url: "/v1/portal/logout",
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.statusCode).toBe(403);
  });
});

describe("CORS for the portal's origin", () => {
  it("answers the preflight and allows credentials for the portal only", async () => {
    const s = await start();
    const pre = await s.server.inject({
      method: "OPTIONS",
      url: "/v1/delegations/0199a1b2-0000-7000-8000-000000000009",
      headers: { origin: PORTAL, "access-control-request-method": "DELETE" },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe(PORTAL);
    expect(pre.headers["access-control-allow-credentials"]).toBe("true");
    expect(pre.headers["access-control-allow-methods"]).toContain("DELETE");

    const res = await asPortal(s, "GET", "/v1/portal/me", null);
    expect(res.headers["access-control-allow-origin"]).toBe(PORTAL);
    const other = await s.server.inject({
      method: "GET",
      url: "/v1/portal/me",
      headers: { origin: "https://evil.example" },
    });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    expect(other.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});
