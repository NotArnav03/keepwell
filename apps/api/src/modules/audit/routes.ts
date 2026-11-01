import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuditVerifyResult, ErrorEnvelope } from "@keepwell/contracts";
import type { DbAudit } from "./log.js";

// GET /v1/m/audit/verify (CONTRACTS.md §4): recomputes the merchant's hash chain. Merchant auth
// (#48) plugs in through `authenticate`; until it exists nothing registers this plugin.

export interface AuditRoutesOptions {
  audit: DbAudit;
  /** Resolves the signed-in merchant user; throws AuditUnauthorized when it can't. */
  authenticate: (request: FastifyRequest) => Promise<{ merchantId: string }>;
}

export class AuditUnauthorized extends Error {
  override readonly name = "AuditUnauthorized";
}

const ClientError = z.object({ statusCode: z.number().int().min(400).max(499), message: z.string() });

export const auditRoutes: FastifyPluginCallback<AuditRoutesOptions> = (app, options, done) => {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AuditUnauthorized)
      return sendError(request, reply, 401, "unauthorized", error.message);
    const client = ClientError.safeParse(error);
    if (client.success) {
      return sendError(request, reply, client.data.statusCode, "invalid_request", client.data.message);
    }
    request.log.error({ err: error }, "audit route failed");
    return sendError(request, reply, 500, "internal", "Something went wrong on our side");
  });

  app.get("/audit/verify", async (request, reply) => {
    const { merchantId } = await options.authenticate(request);
    const result = await options.audit.verify(merchantId);
    if (!result.ok) request.log.error({ merchantId, ...result }, "audit chain broken");
    return reply.send(AuditVerifyResult.parse(result));
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
