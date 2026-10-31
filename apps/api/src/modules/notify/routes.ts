import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ErrorEnvelope, OutboxResponse, type Audit } from "@keepwell/contracts";
import { emailUnsubscribes, type Db, type Tx } from "@keepwell/db";
import type { NotifyConfig } from "./config.js";
import type { NotifyLogger } from "./notifier.js";
import { InvalidCursorError, listOutbox, OutboxQuery } from "./outbox.js";
import { verifyUnsubscribeToken } from "./unsubscribe-token.js";

// GET /v1/m/outbox (merchant, Demo Inbox) and GET /v1/unsubscribe (public). Register with prefix "/v1".

export interface NotifyRoutesOptions {
  db: Db;
  audit: Audit<Tx>;
  config: NotifyConfig;
  log: NotifyLogger;
  /**
   * Resolves the signed-in merchant, or rejects with an error carrying statusCode 401. Merchant auth
   * (M4) isn't merged yet, so the app wires this the same way it wires the policy routes' authenticate.
   */
  authenticate: (request: FastifyRequest) => Promise<{ merchantId: string }>;
}

const UnsubscribeQuery = z.object({ token: z.string().min(1).max(2000) });
const ClientError = z.object({ statusCode: z.number().int().min(400).max(499), message: z.string() });

const page = (title: string, message: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${message}</p></body></html>`;

export const notifyRoutes: FastifyPluginCallback<NotifyRoutesOptions> = (app, options, done) => {
  const { db, audit, config, log, authenticate } = options;

  app.setErrorHandler((error: unknown, request, reply) => {
    const client = ClientError.safeParse(error);
    if (client.success) {
      return sendError(request, reply, client.data.statusCode, "invalid_request", client.data.message);
    }
    log.error({ err: error, requestId: request.id }, "notify route failed");
    return sendError(request, reply, 500, "internal", "Something went wrong on our side");
  });

  app.get("/m/outbox", async (request, reply) => {
    const { merchantId } = await authenticate(request);
    const query = OutboxQuery.safeParse(request.query);
    if (!query.success) {
      return sendError(request, reply, 400, "invalid_request", z.prettifyError(query.error));
    }
    try {
      const result = await listOutbox({ db, config, log }, merchantId, query.data);
      return reply.send(OutboxResponse.parse(result));
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return sendError(request, reply, 400, "invalid_request", err.message);
      }
      throw err;
    }
  });

  // GET changes state because the link lives in an email; mail scanners that prefetch it would
  // unsubscribe people, which is the safe direction for a retention mailer.
  app.get("/unsubscribe", async (request, reply) => {
    const query = UnsubscribeQuery.safeParse(request.query);
    const subject = query.success ? verifyUnsubscribeToken(config.unsubscribeSecret, query.data.token) : null;
    if (!subject) {
      return reply
        .code(400)
        .type("text/html")
        .send(page("This link doesn't work", "The unsubscribe link is invalid or incomplete."));
    }
    await db.forMerchant(subject.merchantId, async (tx) => {
      const inserted = await tx
        .insert(emailUnsubscribes)
        .values({ merchantId: subject.merchantId, email: subject.email })
        .onConflictDoNothing()
        .returning({ id: emailUnsubscribes.id });
      // Only the first click is a change worth auditing.
      if (inserted.length > 0) {
        await audit.append(
          {
            merchantId: subject.merchantId,
            actor: "subscriber",
            kind: "notification.unsubscribed",
            subjectIds: { unsubscribeId: inserted[0]?.id ?? "" },
            payload: {},
          },
          tx,
        );
      }
    });
    log.info({ requestId: request.id, merchantId: subject.merchantId }, "address unsubscribed");
    return reply
      .type("text/html")
      .send(
        page("You're unsubscribed", "You won't get any more emails from this business through Keepwell."),
      );
  });

  done();
};

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send(ErrorEnvelope.parse({ error: { code, message, requestId: request.id } }));
}
