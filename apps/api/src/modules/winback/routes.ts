import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { ErrorEnvelope } from "@keepwell/contracts";
import { ReplyError, ReplyRequest, recordReply, type ReplyDeps } from "./replies.js";

// POST /v1/winback/replies (public; the signed token is the credential).

export interface WinbackRoutesOptions {
  deps: ReplyDeps;
  /** Portal origins that may call this from the browser. */
  allowOrigin: (origin: string) => boolean;
  /** Per client IP. The API has no shared limiter yet, so this one is local to the route. */
  rateLimit?: { max: number; windowMs: number };
}

const BODY_LIMIT = 8 * 1024;

export const winbackRoutes: FastifyPluginCallback<WinbackRoutesOptions> = (app, options, done) => {
  const { max, windowMs } = options.rateLimit ?? { max: 10, windowMs: 60_000 };
  const clock = options.deps.clock ?? (() => new Date());
  const hits = new Map<string, { count: number; resetAt: number }>();

  const allowed = (ip: string): boolean => {
    const now = clock().getTime();
    for (const [key, w] of hits) if (w.resetAt <= now) hits.delete(key);
    const w = hits.get(ip) ?? { count: 0, resetAt: now + windowMs };
    w.count += 1;
    hits.set(ip, w);
    return w.count <= max;
  };

  app.addHook("onRequest", (request, reply, next) => {
    const { origin } = request.headers;
    if (origin !== undefined && options.allowOrigin(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
    }
    next();
  });

  app.options("/winback/replies", (_request, reply) =>
    reply
      .code(204)
      .header("access-control-allow-methods", "POST")
      .header("access-control-allow-headers", "content-type")
      .header("access-control-max-age", "600")
      .send(),
  );

  app.post("/winback/replies", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    if (!allowed(request.ip)) {
      return sendError(request, reply, 429, "rate_limited", "Too many requests, try again in a minute");
    }
    const body = ReplyRequest.safeParse(request.body);
    if (!body.success) {
      return sendError(
        request,
        reply,
        400,
        "invalid_request",
        "Reply must be 1 to 1000 characters with a token",
      );
    }
    try {
      await recordReply(options.deps, body.data);
    } catch (err) {
      if (err instanceof ReplyError) {
        return sendError(request, reply, err.status, err.code, MESSAGES[err.code]);
      }
      request.log.error({ err }, "winback reply failed");
      return sendError(request, reply, 500, "internal", "Something went wrong on our side");
    }
    return reply.code(202).send({ status: "accepted" });
  });

  done();
};

const MESSAGES = {
  invalid_token: "This link isn't valid",
  expired_token: "This link has expired",
  token_used: "You've already replied. Thank you!",
} as const;

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send(ErrorEnvelope.parse({ error: { code, message, requestId: request.id } }));
}
