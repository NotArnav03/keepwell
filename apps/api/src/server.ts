import Fastify, { LogController, type FastifyInstance } from "fastify";
import { ErrorEnvelope } from "@keepwell/contracts";
import type { Env } from "./env.js";

/** A dependency the API needs before it can serve traffic (database, job queue, ...). */
export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

export interface ServerOptions {
  readinessChecks?: ReadinessCheck[];
  /** A check slower than this counts as failed, so /readyz never hangs a load balancer. */
  readinessTimeoutMs?: number;
  /** Tests only: where log lines go, and at what level (default: stdout at LOG_LEVEL). */
  logDestination?: NodeJS.WritableStream;
  logLevel?: string;
}

/**
 * The URL as the request log records it: the path, and each query parameter's name but not its
 * value. Query strings here carry signed tokens (unsubscribe, magic links) and PayPal's return
 * parameters, none of which belong in Render's logs.
 */
export function logSafeUrl(url: string): string {
  const at = url.indexOf("?");
  if (at === -1) return url;
  const names = url
    .slice(at + 1)
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => `${pair.split("=")[0]}=[redacted]`);
  return `${url.slice(0, at)}?${names.join("&")}`;
}

interface LoggedRequest {
  method: string;
  url: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

async function runCheck(check: ReadinessCheck, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([check.check(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function buildServer(env: Env, options: ServerOptions = {}): FastifyInstance {
  const { readinessChecks = [], readinessTimeoutMs = 2000, logDestination, logLevel } = options;

  const app = Fastify({
    logger: {
      level: logLevel ?? env.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers['paypal-auth-algo']"],
      // Fastify's own request serializer, except that the URL goes through logSafeUrl.
      serializers: {
        req: (req: LoggedRequest) => ({
          method: req.method,
          url: logSafeUrl(req.url),
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        }),
      },
      ...(logDestination && { stream: logDestination }),
      ...(env.NODE_ENV === "development" && !logDestination && { transport: { target: "pino-pretty" } }),
    },
    requestIdHeader: "x-request-id",
    // Trust the nearest TRUST_PROXY_HOPS hops, never `true`: Render keeps a client-sent
    // X-Forwarded-For and appends to it. A plain number would do, but Fastify 5.12 fails closed on
    // one, since it can't tell a proxy from a direct client. On Render nothing reaches the service
    // except through its proxy, so counting hops is sound there.
    trustProxy: (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS,
    logController: new LogController({
      requestIdLogLabel: "requestId",
      // Render polls these every few seconds; logging each poll would bury real traffic.
      disableRequestLogging: (request) => request.url === "/healthz" || request.url === "/readyz",
    }),
  });

  // Fastify's default 404 puts the full URL, query string included, in its log message.
  app.setNotFoundHandler((request, reply) => {
    const url = logSafeUrl(request.url);
    request.log.info({ method: request.method, url }, "route not found");
    return reply.code(404).send(
      ErrorEnvelope.parse({
        error: { code: "not_found", message: `No route for ${request.method} ${url}`, requestId: request.id },
      }),
    );
  });

  // Echo the request id so a bug report or browser trace can be matched to our logs.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    const dashboardOrigin = env.DASHBOARD_URL ? new URL(env.DASHBOARD_URL).origin : null;
    const requestOrigin = request.headers.origin;
    if (dashboardOrigin && requestOrigin === dashboardOrigin) {
      reply
        .header("access-control-allow-origin", dashboardOrigin)
        .header("access-control-allow-credentials", "true")
        .header("access-control-expose-headers", "x-request-id")
        .header("vary", "Origin");
    }
    if (request.method === "OPTIONS" && request.url.startsWith("/v1/m/")) {
      if (!dashboardOrigin || requestOrigin !== dashboardOrigin) {
        return reply.code(403).send();
      }
      return reply
        .header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        .header("access-control-allow-headers", "content-type, x-keepwell-csrf, last-event-id")
        .header("access-control-max-age", "600")
        .code(204)
        .send();
    }
  });

  // Liveness: the process is up. Never touches dependencies, so a database outage doesn't
  // make Render restart a healthy process.
  app.get("/healthz", () => ({
    status: "ok",
    env: env.APP_ENV,
    commit: env.RENDER_GIT_COMMIT ?? null,
  }));

  // Readiness: every dependency answers. Failures are logged with the check name.
  app.get("/readyz", async (_request, reply) => {
    const checks = await Promise.all(
      readinessChecks.map(async (c) => {
        try {
          await runCheck(c, readinessTimeoutMs);
          return { name: c.name, ok: true };
        } catch (err) {
          app.log.warn({ err, check: c.name }, "readiness check failed");
          return { name: c.name, ok: false };
        }
      }),
    );
    const ready = checks.every((c) => c.ok);
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks });
  });

  return app;
}
