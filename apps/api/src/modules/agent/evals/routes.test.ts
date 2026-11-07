import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { normalPersonas, redTeamPersonas, type EvalResults } from "@keepwell/evals";
import { escapeHtml, type Scoreboard } from "./page.js";
import { evalsRoutes } from "./routes.js";
import { runEvals } from "./run.js";

const NOW = new Date("2026-11-03T10:00:00.000Z");

async function server(load: () => Promise<Scoreboard>) {
  const app = Fastify();
  await app.register(evalsRoutes, { load });
  return app;
}

const adversarial: EvalResults = await runEvals({
  mode: "adversarial",
  personas: [...normalPersonas(16), ...redTeamPersonas(13)],
  now: NOW,
});

describe("GET /v1/evals", () => {
  it("returns both runs, and null for one not published yet", async () => {
    const app = await server(() => Promise.resolve({ real: null, adversarial }));
    const res = await app.inject({ method: "GET", url: "/v1/evals" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ real: null, adversarial });
  });

  it("reads the results once, and retries after a failed read", async () => {
    let reads = 0;
    const app = await server(() => {
      reads++;
      return reads === 1
        ? Promise.reject(new Error("disk"))
        : Promise.resolve({ real: null, adversarial: null });
    });
    expect((await app.inject({ method: "GET", url: "/v1/evals" })).statusCode).toBe(500);
    expect((await app.inject({ method: "GET", url: "/v1/evals" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/evals" })).statusCode).toBe(200);
    expect(reads).toBe(2);
  });

  it("serves the committed adversarial run by default", async () => {
    const app = Fastify();
    await app.register(evalsRoutes, {});
    const res = await app.inject({ method: "GET", url: "/v1/evals" });
    expect(res.statusCode).toBe(200);
    expect(res.json<Scoreboard>().adversarial?.gates.passed).toBe(true);
  });
});

describe("GET /evals", () => {
  it("renders the gates, the attacks and the examples, with a strict CSP and no scripts", async () => {
    const app = await server(() => Promise.resolve({ real: null, adversarial }));
    const res = await app.inject({ method: "GET", url: "/evals" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.body).not.toMatch(/<script/i);
    expect(res.body).toContain("Gates passed");
    expect(res.body).toContain("No real-model run has been published yet.");
    expect(res.body).toContain("Fake menu markup in the message");
  });

  it("escapes attacker text from the example transcripts", async () => {
    const hostile = structuredClone(adversarial);
    hostile.examples = [
      {
        personaId: "r-001",
        attack: "fake_markup",
        outcome: "cancelled",
        turns: [{ subscriber: "<script>alert(1)</script></details>", agent: "ok", card: null }],
      },
    ];
    const app = await server(() => Promise.resolve({ real: hostile, adversarial: null }));
    const res = await app.inject({ method: "GET", url: "/evals" });
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&lt;/details&gt;");
    expect(res.body).toContain("Real run: Claude Haiku");
  });

  it("shows a failed gate in red", async () => {
    const failed = structuredClone(adversarial);
    failed.gates = { passed: false, policyViolations: 2, maxClicksToCancel: 1 };
    const app = await server(() => Promise.resolve({ real: null, adversarial: failed }));
    const res = await app.inject({ method: "GET", url: "/evals" });
    expect(res.body).toContain("Gates failed");
    expect(res.body).toContain("gate-bad");
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters that matter", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});
