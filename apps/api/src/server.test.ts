import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "./env.js";
import { buildServer, type ServerOptions } from "./server.js";

const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", RENDER_GIT_COMMIT: "abc123" });

let app: FastifyInstance | undefined;

function start(options?: ServerOptions, serverEnv = env): FastifyInstance {
  app = buildServer(serverEnv, options);
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /healthz", () => {
  it("reports ok with the environment and commit", async () => {
    const res = await start().inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", env: "local", commit: "abc123" });
  });

  it("stays ok when a dependency is down", async () => {
    const failing = { name: "db", check: () => Promise.reject(new Error("down")) };
    const res = await start({ readinessChecks: [failing] }).inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /readyz", () => {
  it("is ready when there are no checks", async () => {
    const res = await start().inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", checks: [] });
  });

  it("is ready when every check passes", async () => {
    const res = await start({
      readinessChecks: [{ name: "db", check: () => Promise.resolve() }],
    }).inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", checks: [{ name: "db", ok: true }] });
  });

  it("returns 503 and names the failing check", async () => {
    const res = await start({
      readinessChecks: [
        { name: "db", check: () => Promise.resolve() },
        { name: "jobs", check: () => Promise.reject(new Error("pg-boss not started")) },
      ],
    }).inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "not_ready",
      checks: [
        { name: "db", ok: true },
        { name: "jobs", ok: false },
      ],
    });
  });

  it("treats a hung check as failed instead of hanging", async () => {
    const res = await start({
      readinessChecks: [{ name: "slow", check: () => new Promise<void>(() => undefined) }],
      readinessTimeoutMs: 20,
    }).inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
  });

  it("echoes an incoming x-request-id", async () => {
    const res = await start().inject({
      method: "GET",
      url: "/readyz",
      headers: { "x-request-id": "req-1" },
    });
    expect(res.headers["x-request-id"]).toBe("req-1");
  });
});

describe("dashboard credentialed CORS", () => {
  const dashboardEnv = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DASHBOARD_URL: "https://dashboard.example.test",
  });

  it("allows preflight only from the configured dashboard origin", async () => {
    const server = start(undefined, dashboardEnv);
    const allowed = await server.inject({
      method: "OPTIONS",
      url: "/v1/m/auth/login",
      headers: {
        origin: "https://dashboard.example.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-keepwell-csrf",
      },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://dashboard.example.test");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    expect(allowed.headers["access-control-allow-headers"]).toContain("x-keepwell-csrf");

    const denied = await server.inject({
      method: "OPTIONS",
      url: "/v1/m/auth/login",
      headers: { origin: "https://attacker.example.test" },
    });
    expect(denied.statusCode).toBe(403);
  });
});
