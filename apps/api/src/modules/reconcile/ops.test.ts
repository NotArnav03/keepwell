import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@keepwell/db";
import { opsRoutes } from "./ops.js";

// GET /ops/whoami: what the API takes as the caller's address, and the forwarding headers it got.
// /whoami touches no database, so these run without Postgres.

const TOKEN = "ops-test-token";
const noDb = {} as unknown as Db;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(opsToken?: string): Promise<FastifyInstance> {
  app = Fastify({ trustProxy: (_address: string, hop: number) => hop < 2 });
  await app.register(opsRoutes, { db: noDb, ...(opsToken && { opsToken }) });
  return app;
}

describe("GET /ops/whoami", () => {
  it("shows the address the API settled on, the chain behind it, and the forwarding headers", async () => {
    const res = await (
      await start(TOKEN)
    ).inject({
      url: "/ops/whoami",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.5",
        "cf-connecting-ip": "203.0.113.9",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ip: "203.0.113.9",
      ips: ["127.0.0.1", "10.0.0.5", "203.0.113.9"],
      headers: {
        "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.5",
        "cf-connecting-ip": "203.0.113.9",
        "true-client-ip": null,
        "x-real-ip": null,
      },
    });
  });

  it("is behind the ops token, and off without one", async () => {
    expect((await (await start(TOKEN)).inject({ url: "/ops/whoami" })).statusCode).toBe(401);
    await app?.close();
    expect((await (await start()).inject({ url: "/ops/whoami" })).statusCode).toBe(404);
  });
});
