import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ErrorEnvelope, Id, InsightAction, InsightActionState } from "@keepwell/contracts";
import { InsightActionError, type InsightActionService, type MerchantPrincipal } from "./service.js";
import { InsightActionExecution } from "./store.js";

// HTTP for /v1/m/insight-actions* (CONTRACTS.md §4). Merchant auth (#48) plugs in through
// `authenticate`. The body is the contract's InsightAction, plus `error`, plus derived `execution`.

export interface InsightActionRoutesOptions {
  service: Pick<InsightActionService, "list" | "approve" | "reject">;
  /** Resolves the merchant user; rejects with InsightActionError("unauthorized") when it can't. */
  authenticate: (request: FastifyRequest) => Promise<MerchantPrincipal>;
}

const ListQuery = z.object({ state: InsightActionState.optional() });
const IdParams = z.object({ id: Id });
const ClientError = z.object({ statusCode: z.number().int().min(400).max(499), message: z.string() });
// `execution` is computed on read from the linked engine Action. It is not stored on the row.
const View = InsightAction.extend({ error: z.string().nullable(), execution: InsightActionExecution });

export const insightActionRoutes: FastifyPluginCallback<InsightActionRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { service, authenticate } = options;

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof InsightActionError) {
      return sendError(request, reply, error.status, error.code, error.message);
    }
    const client = ClientError.safeParse(error);
    if (client.success) {
      return sendError(request, reply, client.data.statusCode, "invalid_request", client.data.message);
    }
    request.log.error({ err: error }, "insight action route failed");
    return sendError(request, reply, 500, "internal", "Something went wrong on our side");
  });

  app.get("/insight-actions", async (request, reply) => {
    const principal = await authenticate(request);
    const { state } = parse(ListQuery, request.query);
    const items = await service.list(principal.merchantId, state);
    return reply.send({ items: z.array(View).parse(items) });
  });

  app.post("/insight-actions/:id/approve", async (request, reply) => {
    const principal = await authenticate(request);
    const { id } = parse(IdParams, request.params);
    return reply.send(View.parse(await service.approve(id, principal)));
  });

  app.post("/insight-actions/:id/reject", async (request, reply) => {
    const principal = await authenticate(request);
    const { id } = parse(IdParams, request.params);
    return reply.send(View.parse(await service.reject(id, principal)));
  });

  done();
};

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new InsightActionError("invalid_request", z.prettifyError(result.error));
  return result.data;
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send(ErrorEnvelope.parse({ error: { code, message, requestId: request.id } }));
}
