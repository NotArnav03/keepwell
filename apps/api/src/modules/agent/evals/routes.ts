import type { FastifyPluginCallback } from "fastify";
import { loadResults, resultsUrl } from "@keepwell/evals";
import { renderScoreboard, type Scoreboard } from "./page.js";

// The public scoreboard (#29): GET /v1/evals (JSON) and GET /evals (the page judges see). No auth:
// the results are public by design, and contain only fictional personas.

export interface EvalsRoutesOptions {
  /** Defaults to the committed results files; tests pass their own. */
  load?: () => Promise<Scoreboard>;
}

async function loadCommitted(): Promise<Scoreboard> {
  const [real, adversarial] = await Promise.all([
    loadResults(resultsUrl("real")),
    loadResults(resultsUrl("adversarial")),
  ]);
  return { real, adversarial };
}

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export const evalsRoutes: FastifyPluginCallback<EvalsRoutesOptions> = (app, options, done) => {
  const load = options.load ?? loadCommitted;
  // The files only change with a deploy, so read them once. A failed read isn't cached.
  let cached: Promise<Scoreboard> | null = null;
  const board = () => {
    cached ??= load().catch((err: unknown) => {
      cached = null;
      throw err;
    });
    return cached;
  };

  app.get("/v1/evals", async (_request, reply) => {
    const b = await board();
    return reply.header("cache-control", "public, max-age=300").send(b);
  });

  app.get("/evals", async (_request, reply) => {
    const b = await board();
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("content-security-policy", CSP)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "public, max-age=300")
      .send(renderScoreboard(b));
  });

  done();
};
