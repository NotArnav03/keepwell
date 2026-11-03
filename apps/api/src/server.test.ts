import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "./env.js";
import { buildServer, logSafeUrl, type ServerOptions } from "./server.js";

const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", RENDER_GIT_COMMIT: "abc123" });

let app: FastifyInstance | undefined;

function start(options?: ServerOptions): FastifyInstance {
  app = buildServer(env, options);
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

describe("request log", () => {
  it("keeps query-string values out of the logged URL", () => {
    expect(logSafeUrl("/v1/unsubscribe?token=not-a-real-token")).toBe("/v1/unsubscribe?token=[redacted]");
    expect(logSafeUrl("/v1/revise/return?subscription_id=I-1&ba_token=BA-2")).toBe(
      "/v1/revise/return?subscription_id=[redacted]&ba_token=[redacted]",
    );
    expect(logSafeUrl("/v1/m/outbox")).toBe("/v1/m/outbox");
  });

  // Unsubscribe links carry a signed token, and a magic link or PayPal's return URL carry others:
  // none of them belong in Render's logs.
  it("logs incoming requests without their query values", async () => {
    const lines: string[] = [];
    const logged = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const app = start({ logDestination: logged, logLevel: "info" });
    await app.inject({ method: "GET", url: "/nothing-here?token=secret-value" });
    const all = lines.join("");
    expect(all).toContain("/nothing-here?token=[redacted]");
    expect(all).not.toContain("secret-value");
  });
});

describe("unknown routes", () => {
  it("answer 404 in the shared error envelope, without query values", async () => {
    const res = await start().inject({ method: "GET", url: "/nope?token=abc" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: { code: "not_found", message: "No route for GET /nope?token=[redacted]" },
    });
  });
});

describe("client IP behind Render's proxy", () => {
  // Render appends the address it saw to X-Forwarded-For and keeps whatever the client sent, so
  // only the last TRUST_PROXY_HOPS entries can be believed. Per-IP rate limits depend on this.
  async function ipSeen(hops: string, forwardedFor: string): Promise<string> {
    const app = buildServer(loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", TRUST_PROXY_HOPS: hops }));
    app.get("/ip", (request) => ({ ip: request.ip }));
    const res = await app.inject({ method: "GET", url: "/ip", headers: { "x-forwarded-for": forwardedFor } });
    await app.close();
    return res.json<{ ip: string }>().ip;
  }

  it("takes the address the proxy added, not one the client wrote", async () => {
    expect(await ipSeen("1", "6.6.6.6, 203.0.113.9")).toBe("203.0.113.9");
  });

  it("ignores X-Forwarded-For entirely when no proxy is trusted (local)", async () => {
    expect(await ipSeen("0", "203.0.113.9")).toBe("127.0.0.1");
  });
});
