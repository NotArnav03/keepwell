import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FailureInjector } from "./failures.js";
import type { PayPalState } from "./state.js";
import type { WebhookDispatcher } from "./webhooks.js";

// `/__mock/*`: the side door for doing what PayPal does on its own (renewals, a buyer cancelling
// in their PayPal account, approving a revise) and for injecting failures, over HTTP, so anyone
// can drive the mock with curl. In-process tests call the same methods on `PayPalMock` directly.
// No auth: the mock is local only.

const Id = z.object({ id: z.string().min(1) });

const FailureBody = z
  .object({
    method: z.string().optional(),
    /** A substring of the path, or a regular expression written as /…/. */
    path: z.string().optional(),
    times: z.number().int().min(1).optional(),
    status: z.number().int().min(400).max(599).optional(),
    issue: z.string().optional(),
    apply: z.boolean().optional(),
    delayMs: z.number().int().min(0).max(120_000).optional(),
  })
  .refine(
    (rule) => rule.status !== undefined || rule.delayMs !== undefined,
    "Give a status, a delayMs, or both",
  );

export interface ControlDeps {
  state: PayPalState;
  failures: FailureInjector;
  webhooks: WebhookDispatcher;
  reload: () => void;
}

export function registerControlRoutes(app: FastifyInstance, deps: ControlDeps): void {
  const { state, failures, webhooks } = deps;

  app.get("/__mock", () => ({
    service: "Keepwell PayPal mock (local development only)",
    routes: [
      "POST /__mock/reset",
      "POST /__mock/failures  { method?, path?, times?, status?, issue?, apply?, delayMs? }",
      "DELETE /__mock/failures",
      "POST /__mock/subscriptions/:id/renew  { failReason? }",
      "POST /__mock/subscriptions/:id/cancel-in-paypal",
      "POST /__mock/approvals/:token  { decision: approve | cancel }",
      "POST /__mock/tokens/expire",
      "GET /__mock/webhooks/deliveries",
    ],
  }));

  app.post("/__mock/reset", (_request, reply) => {
    deps.reload();
    return reply.code(204).send();
  });

  app.post("/__mock/failures", (request, reply) => {
    const rule = FailureBody.parse(request.body);
    const regex = rule.path?.match(/^\/(.+)\/$/)?.[1];
    failures.add({ ...rule, ...(regex !== undefined && { path: new RegExp(regex) }) });
    return reply.code(201).send();
  });

  app.delete("/__mock/failures", (_request, reply) => {
    failures.clear();
    return reply.code(204).send();
  });

  app.post("/__mock/subscriptions/:id/renew", (request, reply) => {
    const { id } = Id.parse(request.params);
    const { failReason } = z.object({ failReason: z.string().min(1).optional() }).parse(request.body ?? {});
    state.renew(id, failReason ?? null);
    return reply.code(204).send();
  });

  app.post("/__mock/subscriptions/:id/cancel-in-paypal", (request, reply) => {
    const { id } = Id.parse(request.params);
    state.cancelInPayPal(id);
    return reply.code(204).send();
  });

  app.post("/__mock/approvals/:token", (request) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(request.params);
    const { decision } = z.object({ decision: z.enum(["approve", "cancel"]) }).parse(request.body);
    return { redirect: state.decideRevision(token, decision === "approve") };
  });

  app.post("/__mock/tokens/expire", (_request, reply) => {
    state.expireTokens();
    return reply.code(204).send();
  });

  app.get("/__mock/webhooks/deliveries", () => ({ deliveries: webhooks.deliveries }));
}
