import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CreateDelegationRequest,
  CreateDelegationResponse,
  ErrorEnvelope,
  Id,
  MagicLinkRequest,
  PORTAL_SESSION_TTL_SECONDS,
} from "@keepwell/contracts";
import { DelegationError, type DelegationService, type PortalPrincipal } from "./delegations.js";
import type { MagicLinkService } from "./magic-link.js";
import { RateLimiter } from "./rate-limit.js";
import { PORTAL_COOKIE, signPortalSession, verifyPortalSession } from "./session.js";
import { hashEmail } from "./tokens.js";

// The hosted portal's identity routes (CONTRACTS.md §4, ARCHITECTURE.md §6.7): magic link in,
// PORTAL cookie out, and delegation tokens minted from inside the portal.

export interface Limiters {
  /** Per IP: stops one client spraying the form. */
  magicLinkPerIp: RateLimiter;
  /** Per email hash, whether or not it matches: stops mailbombing, and says nothing about matches. */
  magicLinkPerEmail: RateLimiter;
  verifyPerIp: RateLimiter;
  delegationsPerSession: RateLimiter;
}

export interface PortalRoutesOptions {
  magicLinks: MagicLinkService;
  delegations: DelegationService;
  /** Signs the PORTAL cookie. */
  signingSecret: string;
  /** Where verify sends the browser afterwards (the portal), with `?error=link_expired` on failure. */
  portalUrl: string;
  /** The portal's origin: cookie-authenticated writes must come from it (CSRF). */
  allowOrigin: (origin: string) => boolean;
  /** Off only for plain-http local development. */
  secureCookies?: boolean;
  clock?: () => Date;
  limiters?: Partial<Limiters>;
}

class PortalHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function defaultLimiters(clock: () => Date): Limiters {
  const hour = 3600_000;
  return {
    magicLinkPerIp: new RateLimiter({ limit: 20, windowMs: hour, clock }),
    magicLinkPerEmail: new RateLimiter({ limit: 5, windowMs: hour, clock }),
    verifyPerIp: new RateLimiter({ limit: 30, windowMs: 10 * 60_000, clock }),
    delegationsPerSession: new RateLimiter({ limit: 10, windowMs: hour, clock }),
  };
}

export const portalRoutes: FastifyPluginCallback<PortalRoutesOptions> = (app, options, done) => {
  const clock = options.clock ?? (() => new Date());
  const limiters = { ...defaultLimiters(clock), ...options.limiters };

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof PortalHttpError) {
      if (error.retryAfterSeconds !== undefined) reply.header("retry-after", error.retryAfterSeconds);
      return sendError(request, reply, error.status, error.code, error.message);
    }
    if (error instanceof DelegationError) {
      return sendError(request, reply, error.status, error.code, error.message);
    }
    request.log.error({ err: error }, "portal route failed");
    return sendError(request, reply, 500, "internal", "Something went wrong on our side");
  });

  // Always 202: the answer must not depend on whether the email is a subscriber's.
  app.post("/portal/magic-link", { bodyLimit: 4096 }, async (request, reply) => {
    const input = parse(MagicLinkRequest, request.body);
    limit(limiters.magicLinkPerIp, `ip:${request.ip}`);
    limit(limiters.magicLinkPerEmail, `${input.merchantSlug}:${hashEmail(input.email)}`);
    try {
      await options.magicLinks.request(input);
    } catch (err) {
      // A mail or lookup failure is ours to fix; telling the caller would leak whether it matched.
      request.log.error({ err }, "magic link request failed");
    }
    return reply.code(202).send();
  });

  // The emailed link lands here. The token is in the URL, so keep it out of caches and referrers.
  app.get("/portal/verify", async (request, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    limit(limiters.verifyPerIp, `ip:${request.ip}`);
    const { token } = parse(z.object({ token: z.string().min(1).max(200) }), request.query);
    const who = await options.magicLinks.redeem(token);
    if (who === null) return reply.redirect(withQuery(options.portalUrl, "error", "link_expired"));
    const session = signPortalSession(who, options.signingSecret, clock());
    reply.header("set-cookie", sessionCookie(session, options.secureCookies ?? true));
    return reply.redirect(options.portalUrl);
  });

  app.post("/delegations", { bodyLimit: 4096 }, async (request, reply) => {
    const who = portalPrincipal(request, options, clock());
    limit(limiters.delegationsPerSession, `${who.merchantId}:${who.emailHash}`);
    const created = await options.delegations.create(who, parse(CreateDelegationRequest, request.body));
    return reply.code(201).send(CreateDelegationResponse.parse(created));
  });

  app.delete("/delegations/:id", async (request, reply) => {
    const who = portalPrincipal(request, options, clock());
    limit(limiters.delegationsPerSession, `${who.merchantId}:${who.emailHash}`);
    const { id } = parse(z.object({ id: Id }), request.params);
    await options.delegations.revoke(who, id);
    return reply.code(204).send();
  });

  done();
};

/** The PORTAL cookie's holder; for writes, the request must also come from the portal's origin. */
function portalPrincipal(request: FastifyRequest, options: PortalRoutesOptions, now: Date): PortalPrincipal {
  const origin = request.headers.origin;
  if (origin === undefined || !options.allowOrigin(origin)) {
    throw new PortalHttpError(403, "forbidden", "This request must come from the portal");
  }
  const cookie = readCookie(request.headers.cookie, PORTAL_COOKIE);
  const session = cookie === undefined ? null : verifyPortalSession(cookie, options.signingSecret, now);
  if (session === null || !session.ok) {
    throw new PortalHttpError(401, "unauthorized", "Please sign in with a new link");
  }
  return { merchantId: session.claims.mid, emailHash: session.claims.eh };
}

function limit(limiter: RateLimiter, key: string): void {
  const result = limiter.hit(key);
  if (!result.allowed) {
    throw new PortalHttpError(
      429,
      "rate_limited",
      "Too many attempts; try again later",
      result.retryAfterSeconds,
    );
  }
}

function sessionCookie(value: string, secure: boolean): string {
  const parts = [
    `${PORTAL_COOKIE}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${PORTAL_SESSION_TTL_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function withQuery(url: string, key: string, value: string): string {
  const next = new URL(url);
  next.searchParams.set(key, value);
  return next.toString();
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new PortalHttpError(400, "invalid_request", z.prettifyError(result.error));
  return result.data;
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send(ErrorEnvelope.parse({ error: { code, message, requestId: request.id } }));
}
