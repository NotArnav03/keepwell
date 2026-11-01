import type { FastifyPluginCallback } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { Id } from "@keepwell/contracts";
import { actions, type Db } from "@keepwell/db";
import type { DbActionEngine } from "./engine.js";

// GET /v1/revise/return?action=… (CONTRACTS.md §4, ARCHITECTURE.md §8.2): where PayPal sends the
// buyer after its approval page for a downgrade or annual switch. The redirect itself proves
// nothing, so the engine reads the subscription from PayPal and decides. The page tells the widget
// (its opener) the outcome and closes itself. No auth: the Action id is unguessable, and all this
// can do is make us look at PayPal sooner.

export interface ReviseReturnOptions {
  db: Db;
  engine: DbActionEngine;
}

const Query = z.object({ action: Id, cancelled: z.literal("1").optional() });

export const reviseReturn: FastifyPluginCallback<ReviseReturnOptions> = (app, { db, engine }, done) => {
  app.get("/revise/return", async (request, reply) => {
    const query = Query.safeParse(request.query);
    if (!query.success)
      return reply.code(400).type("text/html; charset=utf-8").send(page("This link isn't valid."));
    const [action] = await db.acrossMerchants((tx) =>
      tx.select({ merchantId: actions.merchantId }).from(actions).where(eq(actions.id, query.data.action)),
    );
    if (!action) return reply.code(404).type("text/html; charset=utf-8").send(page("This link isn't valid."));
    const outcome = await engine.completeRevise(
      action.merchantId,
      query.data.action,
      query.data.cancelled === "1",
    );
    const message =
      outcome === "confirmed"
        ? "Done. Your plan is changed."
        : outcome === "abandoned"
          ? "Nothing changed. You can close this window."
          : "Thanks. PayPal is finishing your change; it will show in a moment.";
    return reply
      .type("text/html; charset=utf-8")
      .send(page(message, { actionId: query.data.action, outcome }));
  });
  done();
};

function page(message: string, result?: { actionId: string; outcome: string }): string {
  // JSON.stringify output is safe inside <script> once "<" can't start a closing tag.
  const data = JSON.stringify({ type: "keepwell.revise", ...result }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<meta charset="utf-8"><title>Keepwell</title>
<main style="font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto">
  <p>${message}</p>
</main>
<script>
  if (window.opener) { window.opener.postMessage(${data}, "*"); window.close(); }
</script>`;
}
