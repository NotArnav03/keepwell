import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ErrorEnvelope,
  ListPoliciesResponse,
  PolicyDryRunRequest,
  PolicyDryRunResponse,
  PolicyError,
  PolicyVersionResponse,
  PublishPolicyRequest,
} from "@keepwell/contracts";
import type { MerchantPrincipal, PolicyService } from "./service.js";

// HTTP for /v1/m/policies* (CONTRACTS.md §4). The logic sits in PolicyService; merchant auth (#48)
// plugs in through `authenticate`.

export interface PolicyRoutesOptions {
  service: PolicyService;
  /** Resolves the merchant user; rejects with PolicyError("unauthorized") when it can't. */
  authenticate: (request: FastifyRequest) => Promise<MerchantPrincipal>;
}

const VersionParams = z.object({ version: z.coerce.number().int().min(1) });
// A full policy document with a long reason ranking is a few KB.
const BODY_LIMIT = 64 * 1024;
const ClientError = z.object({ statusCode: z.number().int().min(400).max(499), message: z.string() });

export const policyRoutes: FastifyPluginCallback<PolicyRoutesOptions> = (app, options, done) => {
  const { service, authenticate } = options;

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof PolicyError) {
      return sendError(request, reply, error.status, error.code, error.message, error.details);
    }
    const client = ClientError.safeParse(error);
    if (client.success) {
      return sendError(request, reply, client.data.statusCode, "invalid_request", client.data.message);
    }
    request.log.error({ err: error }, "policy route failed");
    return sendError(request, reply, 500, "internal", "Something went wrong on our side");
  });

  app.get("/policies", async (request, reply) => {
    const principal = await authenticate(request);
    return reply.send(ListPoliciesResponse.parse(await service.list(principal)));
  });

  app.get("/policies/:version", async (request, reply) => {
    const principal = await authenticate(request);
    const { version } = parse(VersionParams, request.params);
    return reply.send(PolicyVersionResponse.parse(await service.get(principal, version)));
  });

  app.post("/policies", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const principal = await authenticate(request);
    const published = await service.publish(principal, parse(PublishPolicyRequest, request.body));
    return reply.code(201).send(PolicyVersionResponse.parse(published));
  });

  app.post("/policies/dry-run", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const principal = await authenticate(request);
    const result = await service.dryRun(principal, parse(PolicyDryRunRequest, request.body));
    return reply.send(PolicyDryRunResponse.parse(result));
  });

  done();
};

/** zod at the boundary: a bad body or path is the merchant's 400, not our 500. */
function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new PolicyError("invalid_request", z.prettifyError(result.error));
  return result.data;
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): FastifyReply {
  const error = { code, message, requestId: request.id, ...(details === undefined ? {} : { details }) };
  return reply.code(status).send(ErrorEnvelope.parse({ error }));
}
