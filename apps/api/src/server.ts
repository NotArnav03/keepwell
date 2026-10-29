import Fastify, { LogController, type FastifyInstance } from "fastify";
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
  const { readinessChecks = [], readinessTimeoutMs = 2000 } = options;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers['paypal-auth-algo']"],
      ...(env.NODE_ENV === "development" && { transport: { target: "pino-pretty" } }),
    },
    requestIdHeader: "x-request-id",
    logController: new LogController({
      requestIdLogLabel: "requestId",
      // Render polls these every few seconds; logging each poll would bury real traffic.
      disableRequestLogging: (request) => request.url === "/healthz" || request.url === "/readyz",
    }),
  });

  // Echo the request id so a bug report or browser trace can be matched to our logs.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
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
