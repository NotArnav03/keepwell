import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as argon2 from "argon2";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginCallback, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ErrorEnvelope,
  MerchantLoginRequest,
  MerchantMeResponse,
  type MerchantMeResponse as MerchantIdentity,
} from "@keepwell/contracts";
import { merchants, merchantUsers, type Db } from "@keepwell/db";

const SESSION_COOKIE = "keepwell_merchant";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_ATTEMPTS = 10;

export interface MerchantPrincipal {
  merchantId: string;
  userId: string;
  role: "owner" | "admin" | "viewer";
  csrfToken: string;
  email: string;
  merchantSlug: string;
  merchantName: string;
}

interface MerchantUserRecord extends MerchantPrincipal {
  email: string;
  merchantSlug: string;
  merchantName: string;
  passwordHash: string;
}

export interface MerchantAuthStore {
  findByEmail(email: string, merchantSlug?: string): Promise<MerchantUserRecord[]>;
  get(
    merchantId: string,
    userId: string,
  ): Promise<Omit<MerchantUserRecord, "passwordHash" | "csrfToken"> | null>;
}

/** Cross-tenant email lookup is necessary at login; all subsequent reads are tenant-scoped. */
export class DbMerchantAuthStore implements MerchantAuthStore {
  constructor(private readonly db: Db) {}

  findByEmail(email: string, merchantSlug?: string): Promise<MerchantUserRecord[]> {
    return this.db.acrossMerchants((tx) =>
      tx
        .select({
          merchantId: merchantUsers.merchantId,
          userId: merchantUsers.id,
          email: merchantUsers.email,
          passwordHash: merchantUsers.passwordHash,
          role: merchantUsers.role,
          merchantSlug: merchants.slug,
          merchantName: merchants.name,
        })
        .from(merchantUsers)
        .innerJoin(merchants, eq(merchantUsers.merchantId, merchants.id))
        .where(
          and(eq(merchantUsers.email, email), ...(merchantSlug ? [eq(merchants.slug, merchantSlug)] : [])),
        )
        .limit(25)
        .then((rows) => rows.map((row) => ({ ...row, csrfToken: "" }))),
    );
  }

  async get(
    merchantId: string,
    userId: string,
  ): Promise<Omit<MerchantUserRecord, "passwordHash" | "csrfToken"> | null> {
    const [row] = await this.db.forMerchant(merchantId, (tx) =>
      tx
        .select({
          merchantId: merchantUsers.merchantId,
          userId: merchantUsers.id,
          email: merchantUsers.email,
          role: merchantUsers.role,
          merchantSlug: merchants.slug,
          merchantName: merchants.name,
        })
        .from(merchantUsers)
        .innerJoin(merchants, eq(merchantUsers.merchantId, merchants.id))
        .where(and(eq(merchantUsers.id, userId), eq(merchantUsers.merchantId, merchantId)))
        .limit(1),
    );
    return row ?? null;
  }
}

export class MerchantAuthError extends Error {
  override readonly name = "MerchantAuthError";

  constructor(
    readonly status: 401 | 403 | 429,
    message: string,
  ) {
    super(message);
  }

  /**
   * The route plugins of other modules (insights, notify, audit, policy, copilot) turn a thrown error
   * with a 4xx `statusCode` into that response. Without it a signed-out call answered 500.
   */
  get statusCode(): number {
    return this.status;
  }
}

export class MerchantAuthService {
  private dummyHash: Promise<string> | undefined;

  constructor(private readonly store: MerchantAuthStore) {}

  async login(input: unknown): Promise<Omit<MerchantUserRecord, "csrfToken">> {
    const parsed = MerchantLoginRequest.safeParse(input);
    if (!parsed.success) throw new MerchantAuthError(401, "Email or password is incorrect.");
    const email = parsed.data.email.toLowerCase();
    const candidates = await this.store.findByEmail(email, parsed.data.merchantSlug);
    if (candidates.length === 0) {
      this.dummyHash ??= argon2.hash(randomBytes(32), {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      });
      try {
        await argon2.verify(await this.dummyHash, parsed.data.password);
      } catch {
        // Perform a comparable hash operation for unknown accounts without exposing lookup results.
      }
      throw new MerchantAuthError(401, "Email or password is incorrect.");
    }
    const matches: MerchantUserRecord[] = [];
    for (const candidate of candidates) {
      let valid = false;
      try {
        valid = await argon2.verify(candidate.passwordHash, parsed.data.password);
      } catch {
        // A corrupted hash must behave like an invalid login; never expose its contents.
      }
      if (valid) matches.push(candidate);
    }
    const matched = matches[0];
    if (matches.length !== 1 || !matched) throw new MerchantAuthError(401, "Email or password is incorrect.");
    const { csrfToken: _csrfToken, ...identity } = matched;
    return identity;
  }

  async current(claims: SessionClaims): Promise<MerchantPrincipal> {
    const user = await this.store.get(claims.merchantId, claims.userId);
    if (!user) throw new MerchantAuthError(401, "Sign in required.");
    return { ...user, csrfToken: claims.csrfToken };
  }
}

interface SessionClaims {
  merchantId: string;
  userId: string;
  csrfToken: string;
  expiresAt: number;
}

const Claims = z.object({
  merchantId: z.uuid(),
  userId: z.uuid(),
  csrfToken: z.string().min(32),
  expiresAt: z.number().int().positive(),
});

function signClaims(claims: SessionClaims, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function readClaims(token: string | undefined, secret: string, nowSeconds: number): SessionClaims {
  if (!token) throw new MerchantAuthError(401, "Sign in required.");
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) throw new MerchantAuthError(401, "Sign in required.");
  const expected = createHmac("sha256", secret).update(encoded).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw new MerchantAuthError(401, "Sign in required.");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new MerchantAuthError(401, "Sign in required.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new MerchantAuthError(401, "Sign in required.");
  }
  const parsed = Claims.safeParse(payload);
  if (!parsed.success || parsed.data.expiresAt <= nowSeconds) {
    throw new MerchantAuthError(401, "Sign in required.");
  }
  return parsed.data;
}

function cookieFromRequest(request: FastifyRequest): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === SESSION_COOKIE) return value.join("=");
  }
  return undefined;
}

function requestOrigin(request: FastifyRequest, expectedOrigin: string): void {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin !== expectedOrigin) {
    throw new MerchantAuthError(403, "Request origin is not allowed.");
  }
}

export class MerchantAuthenticator {
  private readonly origin: string;

  constructor(
    private readonly auth: MerchantAuthService,
    private readonly secret: string,
    dashboardOrigin: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("SESSION_SECRET must be at least 32 bytes");
    this.origin = new URL(dashboardOrigin).origin;
  }

  async authenticate(request: FastifyRequest, checkCsrf = false): Promise<MerchantPrincipal> {
    const claims = readClaims(cookieFromRequest(request), this.secret, Math.floor(this.now() / 1000));
    if (checkCsrf) {
      requestOrigin(request, this.origin);
      const supplied = request.headers["x-keepwell-csrf"];
      if (typeof supplied !== "string" || supplied.length !== claims.csrfToken.length) {
        throw new MerchantAuthError(403, "CSRF check failed.");
      }
      const expected = Buffer.from(claims.csrfToken);
      const actual = Buffer.from(supplied);
      if (!timingSafeEqual(expected, actual)) throw new MerchantAuthError(403, "CSRF check failed.");
    }
    return this.auth.current(claims);
  }

  async login(
    request: FastifyRequest,
    body: unknown,
    secure: boolean,
  ): Promise<{ identity: MerchantIdentity; cookie: string }> {
    requestOrigin(request, this.origin);
    const user = await this.auth.login(body);
    const csrfToken = randomBytes(32).toString("base64url");
    const claims: SessionClaims = {
      merchantId: user.merchantId,
      userId: user.userId,
      csrfToken,
      expiresAt: Math.floor(this.now() / 1000) + SESSION_TTL_SECONDS,
    };
    // Lax, not None: the dashboard is served same-origin (its static site rewrites /v1/* to this API),
    // and a cross-site cookie between two *.onrender.com hosts is blocked by Safari and partitioned
    // by Firefox, so judges on those browsers couldn't stay signed in.
    const cookie = `${SESSION_COOKIE}=${signClaims(claims, this.secret)}; Path=/v1/m; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
    const identity = MerchantMeResponse.parse({
      merchant: { id: user.merchantId, slug: user.merchantSlug, name: user.merchantName },
      user: { id: user.userId, email: user.email, role: user.role },
      csrfToken,
    });
    return { identity, cookie };
  }

  clearCookie(secure: boolean): string {
    return `${SESSION_COOKIE}=; Path=/v1/m; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  }
}

export interface MerchantAuthRoutesOptions {
  authenticator: MerchantAuthenticator;
  secureCookies: boolean;
}

export const merchantAuthRoutes: FastifyPluginCallback<MerchantAuthRoutesOptions> = (app, options, done) => {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof MerchantAuthError) {
      const code =
        error.status === 401 ? "unauthorized" : error.status === 429 ? "limit_reached" : "forbidden";
      return reply
        .code(error.status)
        .send(ErrorEnvelope.parse({ error: { code, message: error.message, requestId: request.id } }));
    }
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
    if (statusCode === 400) {
      return reply.code(400).send(
        ErrorEnvelope.parse({
          error: { code: "invalid_request", message: "Request body is invalid.", requestId: request.id },
        }),
      );
    }
    request.log.error({ err: error }, "merchant auth route failed");
    return reply.code(500).send(
      ErrorEnvelope.parse({
        error: { code: "internal", message: "Something went wrong on our side", requestId: request.id },
      }),
    );
  });

  app.post("/auth/login", async (request, reply) => {
    const now = Date.now();
    const key = request.ip;
    const entry = attempts.get(key);
    if (entry && entry.resetAt > now && entry.count >= LOGIN_MAX_ATTEMPTS) {
      throw new MerchantAuthError(429, "Too many sign-in attempts. Try again later.");
    }
    if (!entry || entry.resetAt <= now) attempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    else attempts.set(key, { ...entry, count: entry.count + 1 });

    const { identity, cookie } = await options.authenticator.login(
      request,
      request.body,
      options.secureCookies,
    );
    attempts.delete(key);
    return reply.header("set-cookie", cookie).send(identity);
  });

  app.get("/me", async (request, reply) => {
    const principal = await options.authenticator.authenticate(request);
    const identity = MerchantMeResponse.parse({
      merchant: {
        id: principal.merchantId,
        slug: principal.merchantSlug,
        name: principal.merchantName,
      },
      user: { id: principal.userId, email: principal.email, role: principal.role },
      csrfToken: principal.csrfToken,
    });
    return reply.send(identity);
  });

  app.post("/auth/logout", async (request, reply) => {
    await options.authenticator.authenticate(request, true);
    return reply
      .header("set-cookie", options.authenticator.clearCookie(options.secureCookies))
      .code(204)
      .send();
  });

  done();
};
