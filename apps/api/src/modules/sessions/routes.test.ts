import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  CreateSessionResponse,
  SessionError,
  SessionStreamEvent,
  type Agent,
  type SessionsApi,
  type SubscriberPrincipal,
} from "@keepwell/contracts";
import { FakeAgent, FakeSessionsApi, PANTRY_PLAN, pantryPlanSubscription } from "@keepwell/contracts/fakes";
import { loadEnv } from "../../env.js";
import { buildServer } from "../../server.js";
import { ipPrefix, sessionRoutes } from "./routes.js";

const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const maya = pantryPlanSubscription(new Date());
const principal: SubscriberPrincipal = {
  merchantId: PANTRY_PLAN.merchantId,
  subscriptionId: maya.id,
  channel: "widget",
};
const MERCHANT_SITE = "https://pantryplan.example";
const json = { "content-type": "application/json" };

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(
  sessions: SessionsApi = new FakeSessionsApi({ subscriptions: [maya] }),
  authenticate: () => Promise<SubscriberPrincipal> = () => Promise.resolve(principal),
): Promise<FastifyInstance> {
  app = buildServer(env);
  await app.register(sessionRoutes, {
    prefix: "/v1",
    sessions,
    authenticate,
    allowOrigin: (origin) => origin === MERCHANT_SITE,
  });
  await app.ready();
  return app;
}

async function createSession(server: FastifyInstance): Promise<string> {
  const res = await server.inject({ method: "POST", url: "/v1/sessions", payload: { channel: "widget" } });
  expect(res.statusCode).toBe(201);
  return CreateSessionResponse.parse(res.json()).sessionId;
}

/** The offer card the stream carried, read straight from the fake. */
async function presented(api: FakeSessionsApi, sessionId: string) {
  const events: SessionStreamEvent[] = [];
  const { unsubscribe } = await api.subscribe(principal, sessionId, 0, (_seq, e) => events.push(e));
  unsubscribe();
  for (const e of events) if (e.type === "offer.presented") return e;
  throw new Error("No offer was presented");
}

describe("sessions routes", () => {
  it("runs Maya's pause end to end", async () => {
    const api = new FakeSessionsApi({ subscriptions: [maya] });
    const server = await start(api);
    const id = await createSession(server);

    const msg = await server.inject({
      method: "POST",
      url: `/v1/sessions/${id}/messages`,
      payload: { text: "I'm travelling for two months" },
    });
    expect(msg.statusCode).toBe(202);

    const { offer, shownTextHash } = await presented(api, id);
    const accept = await server.inject({
      method: "POST",
      url: `/v1/sessions/${id}/offers/${offer.id}/accept`,
      payload: { shownTextHash },
      headers: { "user-agent": "vitest" },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json()).toMatchObject({ approveUrl: null });
    expect(api.events.ofType("session.offer_accepted")[0]?.payload.consent).toMatchObject({
      userAgent: "vitest",
      ipPrefix: "127.0.0.0/24",
    });
  });

  it("answers with the error envelope", async () => {
    const server = await start();
    const bad = await server.inject({ method: "POST", url: "/v1/sessions", payload: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({
      error: { code: "invalid_request", requestId: bad.headers["x-request-id"] },
    });

    const missing = await server.inject({
      method: "POST",
      url: "/v1/sessions/0199a1b2-c3d4-7e5f-8a6b-0000000000ff/keep",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "not_found" } });

    const notJson = await server.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: json,
      payload: "{nope",
    });
    expect(notJson.statusCode).toBe(400);
    expect(notJson.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("rejects a bad credential with 401", async () => {
    const server = await start(undefined, () =>
      Promise.reject(new SessionError("unauthorized", "Token expired")),
    );
    const res = await server.inject({ method: "POST", url: "/v1/sessions", payload: { channel: "widget" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized", message: "Token expired" } });
  });

  it("hides unexpected errors behind a 500", async () => {
    const broken = new FakeSessionsApi({ subscriptions: [maya] });
    broken.create = () => Promise.reject(new Error("connection string with a password"));
    const res = await (
      await start(broken)
    ).inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { channel: "widget" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: "internal" } });
    expect(res.body).not.toContain("password");
  });

  it("cancels with the AI down: the route never calls the agent", async () => {
    const real = new FakeAgent();
    let aiDown = false;
    const down = () => Promise.reject(new Error("Anthropic API unavailable"));
    const agent: Agent = {
      start: (s) => (aiDown ? down() : real.start(s)),
      respond: (s, t, stream) => (aiDown ? down() : real.respond(s, t, stream)),
      respondToReason: (s, r, stream) => (aiDown ? down() : real.respondToReason(s, r, stream)),
    };
    const api = new FakeSessionsApi({ subscriptions: [maya], agent });
    const server = await start(api);
    const id = await createSession(server);
    aiDown = true;
    const calls = real.calls.length;

    const first = await server.inject({ method: "POST", url: `/v1/sessions/${id}/cancel` });
    const second = await server.inject({ method: "POST", url: `/v1/sessions/${id}/cancel` });
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(real.calls).toHaveLength(calls);
    expect(api.actions.actions).toMatchObject([{ type: "cancel" }]);
  });

  it("allows only listed origins, with a preflight for the widget's headers", async () => {
    const server = await start();
    const ok = await server.inject({
      method: "OPTIONS",
      url: "/v1/sessions/x/messages",
      headers: { origin: MERCHANT_SITE, "access-control-request-method": "POST" },
    });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(MERCHANT_SITE);
    expect(ok.headers["access-control-allow-headers"]).toContain("authorization");

    const other = await server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { channel: "widget" },
      headers: { origin: "https://evil.example" },
    });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("SSE stream", () => {
  type Frame = { seq: number; event: SessionStreamEvent };

  async function readUntil(res: Response, stop: (frames: Frame[]) => boolean): Promise<Frame[]> {
    if (!res.body) throw new Error("No body");
    // fetch bodies are bytes; Node's types leave the chunk type open.
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const frames: Frame[] = [];
    let buffer = "";
    while (!stop(frames)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const id = /^id: (\d+)$/m.exec(raw)?.[1];
        const data = /^data: (.*)$/m.exec(raw)?.[1];
        if (id !== undefined && data !== undefined) {
          frames.push({ seq: Number(id), event: SessionStreamEvent.parse(JSON.parse(data)) });
        }
        end = buffer.indexOf("\n\n");
      }
    }
    await reader.cancel();
    return frames;
  }

  it("streams live, replays after Last-Event-ID, ends after session.closed, then answers 204", async () => {
    const server = await start();
    const base = await server.listen({ host: "127.0.0.1", port: 0 });
    const id = await createSession(server);
    const url = `${base}/v1/sessions/${id}/stream`;

    const live = await fetch(url);
    expect(live.status).toBe(200);
    expect(live.headers.get("content-type")).toContain("text/event-stream");
    const post = fetch(`${base}/v1/sessions/${id}/messages`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: "Away for a while" }),
    });
    const frames = await readUntil(live, (f) => f.some((x) => x.event.type === "agent.done"));
    expect((await post).status).toBe(202);
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i + 1));
    expect(frames.some((f) => f.event.type === "offer.presented")).toBe(true);

    const resumed = await fetch(url, { headers: { "last-event-id": "2" } });
    const keep = await fetch(`${base}/v1/sessions/${id}/keep`, { method: "POST" });
    expect(keep.status).toBe(204);
    const rest = await readUntil(resumed, () => false);
    expect(rest[0]?.seq).toBe(3);
    expect(rest.at(-1)?.event).toMatchObject({ type: "session.closed", outcome: "kept_without_offer" });

    const after = await fetch(`${url}?after=${rest.at(-1)?.seq ?? 0}`);
    expect(after.status).toBe(204);
  });
});

describe("ipPrefix", () => {
  it("keeps the network, not the address", () => {
    expect(ipPrefix("203.0.113.7")).toBe("203.0.113.0/24");
    expect(ipPrefix("::ffff:203.0.113.7")).toBe("203.0.113.0/24");
    expect(ipPrefix("2001:db8:1:2::7")).toBe("2001:db8:1::/48");
    expect(ipPrefix("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(ipPrefix("not an ip")).toBeNull();
  });
});
