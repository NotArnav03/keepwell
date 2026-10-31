import type { FastifyPluginCallback } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { Id } from "@keepwell/contracts";
import { merchants, webhookEvents, type Db } from "@keepwell/db";
import type { Jobs } from "../jobs/jobs.js";

// POST /webhooks/paypal/:merchantId (ARCHITECTURE.md §6.2). Stores the raw body and headers, queues
// webhook.process in the same transaction, and answers 200 fast. Nothing is trusted or acted on
// here: verification and the GET of the subscription happen in the job. A duplicate delivery
// (same PayPal event id, e.g. a resend) hits the unique key and is answered 200 again.

export interface WebhookIntakeOptions {
  db: Db;
  jobs: Jobs;
}

const Params = z.object({ merchantId: Id });
const Envelope = z.looseObject({ id: z.string().min(1).max(200), event_type: z.string().min(1).max(200) });
// PayPal's webhook bodies are a few KB; the full subscription resource is the largest part.
const BODY_LIMIT = 256 * 1024;
const KEPT_HEADERS = [
  "paypal-transmission-id",
  "paypal-transmission-time",
  "paypal-transmission-sig",
  "paypal-cert-url",
  "paypal-auth-algo",
  "content-type",
  "user-agent",
];

export const webhookIntake: FastifyPluginCallback<WebhookIntakeOptions> = (app, { db, jobs }, done) => {
  // The raw bytes are what PayPal signed: keep them as a string, never as a re-serialised object.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: BODY_LIMIT },
    (_req, body, next) => {
      next(null, body);
    },
  );

  app.post("/webhooks/paypal/:merchantId", async (request, reply) => {
    const params = Params.safeParse(request.params);
    if (!params.success) return reply.code(404).send();
    const raw = typeof request.body === "string" ? request.body : "";
    let envelope: z.infer<typeof Envelope>;
    try {
      envelope = Envelope.parse(JSON.parse(raw));
    } catch {
      return reply.code(400).send();
    }
    const headers = Object.fromEntries(
      KEPT_HEADERS.flatMap((name) => {
        const value = request.headers[name];
        return typeof value === "string" ? [[name, value]] : [];
      }),
    );
    const { merchantId } = params.data;

    const outcome = await db.forMerchant(merchantId, async (tx) => {
      const [merchant] = await tx
        .select({ id: merchants.id })
        .from(merchants)
        .where(eq(merchants.id, merchantId));
      if (!merchant) return "unknown_merchant" as const;
      const [row] = await tx
        .insert(webhookEvents)
        .values({ merchantId, eventId: envelope.id, eventType: envelope.event_type, rawBody: raw, headers })
        .onConflictDoNothing({ target: [webhookEvents.merchantId, webhookEvents.eventId] })
        .returning({ id: webhookEvents.id });
      if (!row) return "duplicate" as const;
      await jobs.send("webhook.process", { webhookEventId: row.id }, { tx });
      return "stored" as const;
    });

    if (outcome === "unknown_merchant") return reply.code(404).send();
    request.log.info(
      { merchantId, eventId: envelope.id, eventType: envelope.event_type, outcome },
      "paypal webhook",
    );
    return reply.code(200).send();
  });

  done();
};
