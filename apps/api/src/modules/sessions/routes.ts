import { isIPv4, isIPv6 } from "node:net";
import { PassThrough } from "node:stream";
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AcceptOfferRequest,
  AcceptOfferResponse,
  CancelRequest,
  CancelResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  ErrorEnvelope,
  Id,
  OfferId,
  PostMessageRequest,
  PostReasonRequest,
  SessionError,
  type RequestMeta,
  type SessionStreamEvent,
  type SessionsApi,
  type SubscriberPrincipal,
} from "@keepwell/contracts";
import type { FixedWindowLimiter, SessionRateLimits } from "./rate-limit.js";

// HTTP and SSE for /v1/sessions/* (CONTRACTS.md §4). The session logic sits behind SessionsApi,
// so the real module (#32) and FakeSessionsApi plug in here unchanged.

export interface SessionRoutesOptions {
  sessions: SessionsApi;
  /** Resolves the subscriber's credential; rejects with SessionError("unauthorized") when it can't. */
  authenticate: (request: FastifyRequest) => Promise<SubscriberPrincipal>;
  /** Browser origins that may call these routes: merchant sites with the widget, and the portal. */
  allowOrigin: (origin: string) => boolean;
  /** How often an idle stream gets an SSE comment, so proxies don't cut it. */
  heartbeatMs?: number;
  /**
   * Per-IP limits on the routes that reach the agent (#26). Pass `defaultSessionRateLimits()` in
   * production; unset means no limits (tests). Cancel is never limited. Behind Render's proxy,
   * `request.ip` needs Fastify's `trustProxy`.
   */
  rateLimits?: SessionRateLimits;
}

const SessionParams = z.object({ id: Id });
const OfferParams = SessionParams.extend({ offerId: OfferId });
const StreamCursor = z.coerce.number().int().min(0);
const StreamQuery = z.object({ after: StreamCursor.optional() });
// The largest body here is a 1000-character message.
const BODY_LIMIT = 16 * 1024;
const RETRY_MS = 2000;
const ClientError = z.object({ statusCode: z.number().int().min(400).max(499), message: z.string() });

export const sessionRoutes: FastifyPluginCallback<SessionRoutesOptions> = (app, options, done) => {
  const { sessions, authenticate, rateLimits } = options;

  /** Throws limit_reached (429) with Retry-After once this IP is over the limit. */
  const limit = (limiter: FixedWindowLimiter | undefined, request: FastifyRequest, reply: FastifyReply) => {
    const retryAfter = limiter?.hit(request.ip) ?? 0;
    if (retryAfter === 0) return;
    void reply.header("retry-after", String(retryAfter));
    throw new SessionError("limit_reached", "Too many requests. Please wait a moment; Cancel still works.");
  };

  app.addHook("onRequest", (request, reply, next) => {
    const { origin } = request.headers;
    if (origin !== undefined && options.allowOrigin(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-expose-headers", "x-request-id");
      reply.header("vary", "Origin");
    }
    next();
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof SessionError)
      return sendError(request, reply, error.status, error.code, error.message);
    // Fastify's own 4xx: JSON that doesn't parse, a body over the limit, an unknown content type.
    const client = ClientError.safeParse(error);
    if (client.success) {
      return sendError(request, reply, client.data.statusCode, "invalid_request", client.data.message);
    }
    request.log.error({ err: error }, "sessions route failed");
    return sendError(request, reply, 500, "internal", "Something went wrong on our side");
  });

  const preflight = (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(204)
      .header("access-control-allow-methods", "GET, POST")
      .header("access-control-allow-headers", "authorization, content-type, last-event-id")
      .header("access-control-max-age", "600")
      .send();
  app.options("/sessions", preflight);
  app.options("/sessions/*", preflight);

  app.post("/sessions", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    limit(rateLimits?.create, request, reply);
    const principal = await authenticate(request);
    const created = await sessions.create(principal, parse(CreateSessionRequest, request.body));
    return reply.code(201).send(CreateSessionResponse.parse(created));
  });

  app.get("/sessions/:id/stream", async (request, reply) => {
    const principal = await authenticate(request);
    const { id } = parse(SessionParams, request.params);
    const lastEventId = request.headers["last-event-id"];
    const afterSeq =
      typeof lastEventId === "string"
        ? parse(StreamCursor, lastEventId)
        : (parse(StreamQuery, request.query).after ?? 0);

    // Frames are buffered until the subscription (and its replay) is known to be worth a stream.
    const backlog: string[] = [];
    let out: PassThrough | null = null;
    let closing = false;
    let finished = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe = () => {};
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      unsubscribe();
      out?.end();
    };
    const deliver = (seq: number, event: SessionStreamEvent) => {
      if (finished) return;
      const frame = `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`;
      if (out) out.write(frame);
      else backlog.push(frame);
      if (event.type === "session.closed") {
        closing = true;
        if (out) finish();
      }
    };

    const subscription = await sessions.subscribe(principal, id, afterSeq, deliver);
    unsubscribe = subscription.unsubscribe;
    if (subscription.closed && backlog.length === 0) {
      // Over and nothing new: 204 tells EventSource to stop reconnecting.
      unsubscribe();
      return reply.code(204).send();
    }

    out = new PassThrough();
    out.write(`retry: ${RETRY_MS}\n\n`);
    for (const frame of backlog) out.write(frame);
    if (closing) {
      finish();
    } else {
      const stream = out;
      heartbeat = setInterval(() => stream.write(": keep-alive\n\n"), options.heartbeatMs ?? 15_000);
      // Fastify destroys the payload when the client goes away, which closes it.
      stream.on("close", finish);
    }
    return reply
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache, no-transform")
      .header("x-accel-buffering", "no")
      .send(out);
  });

  app.post("/sessions/:id/messages", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    limit(rateLimits?.talk, request, reply);
    const principal = await authenticate(request);
    const { id } = parse(SessionParams, request.params);
    await sessions.message(principal, id, parse(PostMessageRequest, request.body));
    return reply.code(202).send();
  });

  app.post("/sessions/:id/reason", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    limit(rateLimits?.talk, request, reply);
    const principal = await authenticate(request);
    const { id } = parse(SessionParams, request.params);
    await sessions.reason(principal, id, parse(PostReasonRequest, request.body));
    return reply.code(202).send();
  });

  app.post("/sessions/:id/offers/:offerId/accept", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const principal = await authenticate(request);
    const { id, offerId } = parse(OfferParams, request.params);
    const body = parse(AcceptOfferRequest, request.body);
    const accepted = await sessions.accept(principal, id, offerId, body, requestMeta(request));
    return reply.send(AcceptOfferResponse.parse(accepted));
  });

  app.post("/sessions/:id/offers/:offerId/decline", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const principal = await authenticate(request);
    const { id, offerId } = parse(OfferParams, request.params);
    await sessions.decline(principal, id, offerId);
    return reply.code(204).send();
  });

  app.post("/sessions/:id/keep", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const principal = await authenticate(request);
    const { id } = parse(SessionParams, request.params);
    await sessions.keep(principal, id);
    return reply.code(204).send();
  });

  // Never calls the agent or any LLM (design law 1): it only asks SessionsApi.cancel for an Action.
  app.post("/sessions/:id/cancel", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const principal = await authenticate(request);
    const { id } = parse(SessionParams, request.params);
    const cancelled = await sessions.cancel(principal, id, parse(CancelRequest, request.body ?? {}));
    return reply.send(CancelResponse.parse(cancelled));
  });

  done();
};

/** zod at the boundary: a bad body, path or header is the subscriber's 400, not our 500. */
function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new SessionError("invalid_request", z.prettifyError(result.error));
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

function requestMeta(request: FastifyRequest): RequestMeta {
  return {
    ipPrefix: ipPrefix(request.ip),
    userAgent: request.headers["user-agent"]?.slice(0, 512) ?? null,
  };
}

/** The consent record keeps a network, not an address: IPv4 to /24, IPv6 to /48. */
export function ipPrefix(ip: string): string | null {
  const v4 = ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
  if (isIPv4(v4)) return `${v4.split(".").slice(0, 3).join(".")}.0/24`;
  if (!isIPv6(ip)) return null;
  const [head = ""] = ip.split("::");
  const groups = head.split(":").filter((group) => group !== "");
  while (groups.length < 3) groups.push("0");
  return `${groups.slice(0, 3).join(":")}::/48`;
}
