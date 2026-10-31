import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ErrorEnvelope } from "@keepwell/contracts";
import { InsightsResponse, type DateRange } from "./queries.js";

// GET /v1/m/insights?from&to (CONTRACTS.md §4, owner M5). Merchant auth belongs to M4 and plugs in
// through `authenticate`; the route is registered with the /v1/m prefix once that exists.

export interface InsightsRoutesOptions {
  /** Resolves the merchant behind the cookie; rejects with an Error whose `statusCode` is 401. */
  authenticate: (request: FastifyRequest) => Promise<{ merchantId: string }>;
  /** Reads the aggregates for one merchant. In production: insightsOverview bound to the Db. */
  load: (merchantId: string, range: DateRange, quoteLimit: number) => Promise<InsightsResponse>;
}

const Query = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    quotes: z.coerce.number().int().min(1).max(50).default(10),
  })
  .refine((q) => q.from <= q.to, { message: "from must not be after to" });
const ClientError = z.object({ statusCode: z.number().int().min(400).max(499), message: z.string() });

export const insightsRoutes: FastifyPluginCallback<InsightsRoutesOptions> = (app, options, done) => {
  app.setErrorHandler((error: unknown, request, reply) => {
    const client = ClientError.safeParse(error);
    if (client.success) {
      const code = client.data.statusCode === 401 ? "unauthorized" : "invalid_request";
      return sendError(request, reply, client.data.statusCode, code, client.data.message);
    }
    request.log.error({ err: error }, "insights route failed");
    return sendError(request, reply, 500, "internal", "Something went wrong on our side");
  });

  app.get("/insights", async (request, reply) => {
    const { merchantId } = await options.authenticate(request);
    const parsed = Query.safeParse(request.query);
    if (!parsed.success) {
      return sendError(request, reply, 400, "invalid_request", z.prettifyError(parsed.error));
    }
    const { from, to, quotes } = parsed.data;
    const result = await options.load(merchantId, { from, to }, quotes);
    return reply.send(InsightsResponse.parse(result));
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
