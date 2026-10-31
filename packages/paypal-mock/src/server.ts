import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { registerControlRoutes } from "./control.js";
import { invalidRequest, PayPalApiError } from "./errors.js";
import { FailureInjector, type ArmedFailure } from "./failures.js";
import { pantryPlanFixture } from "./fixtures.js";
import type { MerchantFixture, PlanRecord, SubscriptionRecord, TransactionRecord } from "./records.js";
import { PayPalState } from "./state.js";
import { money, paypalTime, toCents } from "./units.js";
import { verify, WebhookDispatcher } from "./webhooks.js";

// The fake PayPal REST API: the endpoints Keepwell's gateway calls (ARCHITECTURE.md §6.1), with
// PayPal's paths, status codes, error bodies and PayPal-Debug-Id headers. `/__mock/*` (control.ts)
// is the side door tests and developers use to act as PayPal itself.

export interface PayPalMockOptions {
  /** Default: the Pantry Plan merchant and its 12 subscribers. */
  fixtures?: (now: Date) => MerchantFixture[];
  clock?: () => Date;
  /** How long PayPal takes to send a webhook. Sandbox takes 10–75 s; tests want 0. */
  webhookDelayMs?: number;
  logger?: boolean;
}

export interface PayPalMock {
  app: FastifyInstance;
  state: PayPalState;
  failures: FailureInjector;
  webhooks: WebhookDispatcher;
  /** Starts listening and resolves with the base URL, e.g. http://127.0.0.1:4010. */
  listen(options?: { port?: number; host?: string }): Promise<string>;
  /** Reloads the fixtures and clears failures. Webhook registrations go too. */
  reset(): void;
  close(): Promise<void>;
}

const PageQuery = z.object({
  page_size: z.coerce.number().int().min(1).max(20).default(10),
  page: z.coerce.number().int().min(1).default(1),
});
const Reason = z.object({ reason: z.string().min(1).max(128) });
const Money = z.object({ currency_code: z.string().length(3), value: z.string().regex(/^\d+(\.\d{1,2})?$/) });
const SubscriptionParams = z.object({ id: z.string().min(1) });

export function createPayPalMock(options: PayPalMockOptions = {}): PayPalMock {
  const clock = options.clock ?? (() => new Date());
  const fixtures = options.fixtures ?? ((now: Date) => [pantryPlanFixture(now)]);
  const state = new PayPalState(fixtures(clock()), clock);
  const failures = new FailureInjector();
  const webhooks = new WebhookDispatcher(clock, options.webhookDelayMs ?? 0);
  state.onEvent = (merchantId, event) => webhooks.dispatch(event, state.webhooks(merchantId));

  const app = Fastify({ logger: options.logger ?? false });
  const merchantOf = new WeakMap<FastifyRequest, string>();
  const armed = new WeakMap<FastifyRequest, ArmedFailure>();

  const merchant = (request: FastifyRequest): string => {
    const id = merchantOf.get(request);
    // The auth hook runs before every /v1 and /v2 route, so this only fails on a mock bug.
    if (id === undefined) throw new PayPalApiError(500, null, "No merchant on this request");
    return id;
  };

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );

  app.addHook("onRequest", async (request, reply) => {
    reply.header("paypal-debug-id", randomBytes(7).toString("hex").slice(0, 13));
    const path = request.url.split("?")[0] ?? "";
    if (!/^\/v[12]\//.test(path)) return;

    const failure = failures.take(request.method, path);
    if (failure) {
      if (failure.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, failure.delayMs));
      if (failure.status !== null && !failure.apply) {
        throw new PayPalApiError(failure.status, failure.issue, "Injected by the PayPal mock");
      }
      if (failure.status !== null) armed.set(request, failure);
    }

    if (path === "/v1/oauth2/token") return;
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    const merchantId = token === undefined ? null : state.merchantForToken(token);
    if (merchantId === null) throw new PayPalApiError(401);
    merchantOf.set(request, merchantId);
  });

  // "Applied, but the response failed": the change is made, then the client sees an error.
  app.addHook("onSend", async (request, reply, payload) => {
    const failure = armed.get(request);
    if (!failure || failure.status === null) return payload;
    const error = new PayPalApiError(
      failure.status,
      failure.issue,
      "Injected by the PayPal mock after applying",
    );
    reply.code(failure.status).header("content-type", "application/json; charset=utf-8");
    return JSON.stringify(error.body(String(reply.getHeader("paypal-debug-id"))));
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    const debugId = String(reply.getHeader("paypal-debug-id"));
    if (error instanceof PayPalApiError) return reply.code(error.status).send(error.body(debugId));
    if (error instanceof z.ZodError) {
      return reply
        .code(400)
        .send(invalidRequest("INVALID_PARAMETER_SYNTAX", z.prettifyError(error)).body(debugId));
    }
    const status = z.object({ statusCode: z.number().int().min(400).max(499) }).safeParse(error);
    if (status.success) {
      const malformed = invalidRequest("MALFORMED_REQUEST_JSON", "The request body is not valid JSON.");
      return reply.code(400).send(malformed.body(debugId));
    }
    app.log.error({ err: error }, "paypal mock failed");
    return reply.code(500).send(new PayPalApiError(500).body(debugId));
  });

  // ---------- OAuth ----------

  app.post("/v1/oauth2/token", (request, reply) => {
    const basic = /^Basic (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    const [clientId = "", clientSecret = ""] = Buffer.from(basic ?? "", "base64")
      .toString()
      .split(":");
    const issued = state.issueToken(clientId, clientSecret);
    if (!issued)
      return reply
        .code(401)
        .send({ error: "invalid_client", error_description: "Client Authentication failed" });
    const body = z.object({ grant_type: z.literal("client_credentials") }).safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: "unsupported_grant_type", error_description: "Grant Type is NULL" });
    }
    return reply.send({
      scope: "https://uri.paypal.com/services/subscriptions",
      access_token: issued.token,
      token_type: "Bearer",
      app_id: "APP-KEEPWELLMOCK",
      expires_in: issued.expiresIn,
      nonce: `${new Date().toISOString()}${randomBytes(8).toString("hex")}`,
    });
  });

  // ---------- plans ----------

  app.get("/v1/billing/plans", (request) => {
    const query = parse(PageQuery.extend({ product_id: z.string().optional() }), request.query);
    const page = state.listPlans(merchant(request), query.product_id ?? null, {
      page: query.page,
      pageSize: query.page_size,
    });
    return {
      plans: page.items.map((p) => ({
        ...summaryOf(p),
        links: [link(base(request), `/v1/billing/plans/${p.id}`, "self")],
      })),
      total_items: page.totalItems,
      total_pages: page.totalPages,
    };
  });

  app.get("/v1/billing/plans/:id", (request) => {
    const { id } = parse(SubscriptionParams, request.params);
    return planBody(state.getPlan(merchant(request), id), base(request));
  });

  app.post("/v1/billing/plans", (request, reply) => {
    const input = parse(
      z.object({
        product_id: z.string().min(1),
        name: z.string().min(1).max(127),
        status: z.enum(["CREATED", "ACTIVE", "INACTIVE"]).optional(),
        description: z.string().max(127).default(""),
        billing_cycles: z
          .array(
            z.object({
              frequency: z.object({
                interval_unit: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]),
                interval_count: z.number().int().min(1).default(1),
              }),
              tenure_type: z.enum(["REGULAR", "TRIAL"]),
              sequence: z.number().int().min(1),
              total_cycles: z.number().int().min(0).default(0),
              pricing_scheme: z.object({ fixed_price: Money }),
            }),
          )
          .min(1),
        payment_preferences: z
          .object({
            auto_bill_outstanding: z.boolean().default(true),
            setup_fee_failure_action: z.enum(["CONTINUE", "CANCEL"]).default("CANCEL"),
            payment_failure_threshold: z.number().int().min(0).max(999).default(0),
          })
          .default({
            auto_bill_outstanding: true,
            setup_fee_failure_action: "CANCEL",
            payment_failure_threshold: 0,
          }),
      }),
      request.body,
    );
    const merchantId = merchant(request);
    const plan = state.idempotent(merchantId, requestId(request, "plan"), () =>
      state.createPlan(merchantId, {
        ...input,
        usage_type: "LICENSED",
        billing_cycles: input.billing_cycles.map((c) => ({
          ...c,
          pricing_scheme: { fixed_price: c.pricing_scheme.fixed_price, version: 1 },
        })),
      }),
    );
    return reply.code(201).send(planBody(plan, base(request)));
  });

  // ---------- subscriptions ----------

  app.get("/v1/billing/subscriptions", (request) => {
    const query = parse(
      PageQuery.extend({
        plan_ids: z.string().optional(),
        statuses: z.string().optional(),
        status_updated_after: z.iso.datetime({ offset: true }).optional(),
      }),
      request.query,
    );
    const merchantId = merchant(request);
    const page = state.listSubscriptions(
      merchantId,
      {
        planIds: query.plan_ids?.split(",") ?? null,
        statuses: query.statuses?.split(",") ?? null,
        statusUpdatedAfter: query.status_updated_after ?? null,
      },
      { page: query.page, pageSize: query.page_size },
    );
    return {
      subscriptions: page.items.map((s) => subscriptionBody(s, base(request), null)),
      total_items: page.totalItems,
      total_pages: page.totalPages,
    };
  });

  app.get("/v1/billing/subscriptions/:id", (request) => {
    const { id } = parse(SubscriptionParams, request.params);
    const { fields } = parse(z.object({ fields: z.string().optional() }), request.query);
    const merchantId = merchant(request);
    const subscription = state.getSubscription(merchantId, id);
    const plan = fields?.split(",").includes("plan") ? state.effectivePlan(merchantId, subscription) : null;
    return subscriptionBody(subscription, base(request), plan);
  });

  for (const action of ["suspend", "activate", "cancel"] as const) {
    app.post(`/v1/billing/subscriptions/:id/${action}`, (request, reply) => {
      const { id } = parse(SubscriptionParams, request.params);
      parse(Reason, request.body);
      state[action](merchant(request), id);
      return reply.code(204).send();
    });
  }

  app.post("/v1/billing/subscriptions/:id/revise", (request) => {
    const { id } = parse(SubscriptionParams, request.params);
    const body = parse(
      z.object({
        plan_id: z.string().min(1),
        application_context: z
          .object({ return_url: z.url().optional(), cancel_url: z.url().optional() })
          .optional(),
      }),
      request.body,
    );
    const root = base(request);
    const token = state.revise(merchant(request), id, body.plan_id, {
      returnUrl: body.application_context?.return_url ?? null,
      cancelUrl: body.application_context?.cancel_url ?? null,
    });
    return {
      plan_id: body.plan_id,
      quantity: "1",
      plan_overridden: false,
      links: [
        {
          href: `${root}/webapps/billing/subscriptions/update?ba_token=${token}`,
          rel: "approve",
          method: "GET",
        },
        link(root, `/v1/billing/subscriptions/${id}`, "edit", "PATCH"),
        link(root, `/v1/billing/subscriptions/${id}`, "self"),
      ],
    };
  });

  app.patch("/v1/billing/subscriptions/:id", (request, reply) => {
    const { id } = parse(SubscriptionParams, request.params);
    const operations = parse(
      z.array(z.object({ op: z.string(), path: z.string(), value: z.unknown().optional() })).min(1),
      request.body,
    );
    state.patch(merchant(request), id, operations);
    return reply.code(204).send();
  });

  app.post("/v1/billing/subscriptions/:id/capture", (request, reply) => {
    const { id } = parse(SubscriptionParams, request.params);
    const body = parse(
      z.object({
        note: z.string().min(1).max(128),
        capture_type: z.literal("OUTSTANDING_BALANCE"),
        amount: Money,
      }),
      request.body,
    );
    const merchantId = merchant(request);
    const result = state.idempotent(merchantId, requestId(request, "capture"), () => {
      const transaction = state.capture(merchantId, id, body.amount);
      return transactionBody(transaction, state.getSubscription(merchantId, id));
    });
    return reply.code(202).send(result);
  });

  app.get("/v1/billing/subscriptions/:id/transactions", (request) => {
    const { id } = parse(SubscriptionParams, request.params);
    const query = parse(
      z.object({ start_time: z.iso.datetime({ offset: true }), end_time: z.iso.datetime({ offset: true }) }),
      request.query,
    );
    const merchantId = merchant(request);
    const subscription = state.getSubscription(merchantId, id);
    const list = state.transactions(merchantId, id, query.start_time, query.end_time);
    return {
      transactions: list.map((t) => transactionBody(t, subscription)),
      total_items: list.length,
      total_pages: 1,
    };
  });

  // ---------- refunds (spike Q1 decides which one Keepwell uses; both are here) ----------

  app.post("/v1/payments/sale/:id/refund", (request, reply) => {
    const { id } = parse(SubscriptionParams, request.params);
    const body = parse(
      z
        .object({ amount: z.object({ total: z.string(), currency: z.string().length(3) }).optional() })
        .default({}),
      request.body ?? {},
    );
    const merchantId = merchant(request);
    const root = base(request);
    const result = state.idempotent(merchantId, requestId(request, "refund"), () => {
      const refund = state.refund(merchantId, id, body.amount ? toCents(body.amount.total) : null);
      const time = paypalTime(clock());
      return {
        id: refund.refundId,
        create_time: time,
        update_time: time,
        state: "completed",
        amount: {
          total: money(refund.cents, refund.transaction.currency).value,
          currency: refund.transaction.currency,
        },
        sale_id: id,
        links: [link(root, `/v1/payments/refund/${refund.refundId}`, "self")],
      };
    });
    return reply.code(201).send(result);
  });

  app.post("/v2/payments/captures/:id/refund", (request, reply) => {
    const { id } = parse(SubscriptionParams, request.params);
    const body = parse(z.object({ amount: Money.optional() }).default({}), request.body ?? {});
    const merchantId = merchant(request);
    const root = base(request);
    const { result, replayed } = state.idempotentCall(merchantId, requestId(request, "refund"), () => {
      const refund = state.refund(merchantId, id, body.amount ? toCents(body.amount.value) : null);
      return {
        id: refund.refundId,
        status: "COMPLETED",
        links: [link(root, `/v2/payments/refunds/${refund.refundId}`, "self")],
      };
    });
    // Spike Q1: the same PayPal-Request-Id again returns 200 with the first refund, not a new one.
    return reply.code(replayed ? 200 : 201).send(result);
  });

  // ---------- webhooks ----------

  app.post("/v1/notifications/webhooks", (request, reply) => {
    // Real PayPal requires https; the mock accepts http so it can call localhost.
    const body = parse(
      z.object({ url: z.url(), event_types: z.array(z.object({ name: z.string().min(1) })).min(1) }),
      request.body,
    );
    const webhook = state.registerWebhook(
      merchant(request),
      body.url,
      body.event_types.map((e) => e.name),
    );
    return reply.code(201).send(webhookBody(webhook, base(request)));
  });

  app.get("/v1/notifications/webhooks", (request) => ({
    webhooks: state.webhooks(merchant(request)).map((w) => webhookBody(w, base(request))),
  }));

  app.delete("/v1/notifications/webhooks/:id", (request, reply) => {
    const { id } = parse(SubscriptionParams, request.params);
    state.deleteWebhook(merchant(request), id);
    return reply.code(204).send();
  });

  app.post("/v1/notifications/verify-webhook-signature", (request) => {
    const body = parse(
      z.object({
        auth_algo: z.string(),
        cert_url: z.string(),
        transmission_id: z.string(),
        transmission_sig: z.string(),
        transmission_time: z.string(),
        webhook_id: z.string(),
        webhook_event: z.record(z.string(), z.unknown()),
      }),
      request.body,
    );
    const ownWebhook = state.merchantForWebhook(body.webhook_id) === merchant(request);
    const ok =
      ownWebhook &&
      verify({
        transmissionId: body.transmission_id,
        transmissionTime: body.transmission_time,
        transmissionSig: body.transmission_sig,
        webhookId: body.webhook_id,
        certUrl: body.cert_url,
        authAlgo: body.auth_algo,
        body: JSON.stringify(body.webhook_event),
      });
    return { verification_status: ok ? "SUCCESS" : "FAILURE" };
  });

  app.get("/v1/notifications/webhooks-events/:id", (request) => {
    const { id } = parse(SubscriptionParams, request.params);
    return state.event(merchant(request), id);
  });

  app.post("/v1/notifications/webhooks-events/:id/resend", (request, reply) => {
    const { id } = parse(SubscriptionParams, request.params);
    const body = parse(
      z.object({ webhook_ids: z.array(z.string()).optional() }).default({}),
      request.body ?? {},
    );
    const merchantId = merchant(request);
    const event = state.event(merchantId, id);
    const targets = state
      .webhooks(merchantId)
      .filter((w) => !body.webhook_ids || body.webhook_ids.includes(w.id));
    webhooks.dispatch(event, targets);
    return reply.code(202).send(event);
  });

  // ---------- the buyer's approval page for revise (PayPal's own site in real life) ----------

  app.get("/webapps/billing/subscriptions/update", (request, reply) => {
    const { ba_token } = parse(z.object({ ba_token: z.string().min(1) }), request.query);
    return reply.type("text/html; charset=utf-8").send(approvalPage(ba_token));
  });

  app.post("/webapps/billing/subscriptions/update", (request, reply) => {
    const { ba_token, decision } = parse(
      z.object({ ba_token: z.string().min(1), decision: z.enum(["approve", "cancel"]) }),
      request.body,
    );
    const redirect = state.decideRevision(ba_token, decision === "approve");
    if (redirect !== null) return reply.redirect(redirect, 302);
    return reply
      .type("text/html; charset=utf-8")
      .send("<!doctype html><p>Done. You can close this window.</p>");
  });

  registerControlRoutes(app, { state, failures, webhooks, reload: () => reset() });

  function reset(): void {
    state.load(fixtures(clock()));
    failures.clear();
  }

  return {
    app,
    state,
    failures,
    webhooks,
    reset,
    async listen({ port = 0, host = "127.0.0.1" } = {}) {
      await app.listen({ port, host });
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new Error("PayPal mock has no TCP address");
      return `http://${host}:${address.port}`;
    },
    async close() {
      await webhooks.flush();
      await app.close();
    },
  };
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidRequest("INVALID_PARAMETER_SYNTAX", z.prettifyError(result.error));
  return result.data;
}

function requestId(request: FastifyRequest, scope: string): string | undefined {
  const header = request.headers["paypal-request-id"];
  return typeof header === "string" ? `${scope}:${header}` : undefined;
}

function base(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

function link(root: string, path: string, rel: string, method = "GET") {
  return { href: `${root}${path}`, rel, method };
}

function summaryOf(plan: PlanRecord) {
  const { id, product_id, name, status, description, usage_type, create_time } = plan;
  return { id, product_id, name, status, description, usage_type, create_time };
}

function planBody(plan: PlanRecord, root: string) {
  return { ...plan, links: [link(root, `/v1/billing/plans/${plan.id}`, "self")] };
}

function subscriptionBody(subscription: SubscriptionRecord, root: string, plan: PlanRecord | null) {
  const self = `/v1/billing/subscriptions/${subscription.id}`;
  return {
    ...subscription,
    ...(plan && {
      plan: { billing_cycles: plan.billing_cycles, payment_preferences: plan.payment_preferences },
    }),
    links: [
      link(root, `${self}/cancel`, "cancel", "POST"),
      link(root, self, "edit", "PATCH"),
      link(root, self, "self"),
      link(root, `${self}/suspend`, "suspend", "POST"),
      link(root, `${self}/capture`, "capture", "POST"),
    ],
  };
}

function transactionBody(transaction: TransactionRecord, subscription: SubscriptionRecord) {
  const { grossCents, currency } = transaction;
  // Roughly PayPal's standard rate, so net and fee look plausible on the dashboard.
  const feeCents =
    transaction.status === "DECLINED" ? 0 : Math.min(grossCents, Math.round(grossCents * 0.029) + 30);
  return {
    status: transaction.status,
    id: transaction.id,
    amount_with_breakdown: {
      gross_amount: money(grossCents, currency),
      fee_amount: money(feeCents, currency),
      net_amount: money(grossCents - feeCents, currency),
    },
    payer_name: subscription.subscriber.name,
    payer_email: subscription.subscriber.email_address,
    time: transaction.time,
  };
}

function webhookBody(webhook: { id: string; url: string; eventTypes: string[] }, root: string) {
  return {
    id: webhook.id,
    url: webhook.url,
    event_types: webhook.eventTypes.map((name) => ({ name })),
    links: [link(root, `/v1/notifications/webhooks/${webhook.id}`, "self")],
  };
}

function approvalPage(token: string): string {
  return `<!doctype html>
<meta charset="utf-8"><title>PayPal (mock): approve your subscription change</title>
<main style="font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto">
  <p><strong>PAYPAL MOCK</strong> (local development only)</p>
  <p>The merchant wants to change your subscription plan. Approve the change?</p>
  <form method="post">
    <input type="hidden" name="ba_token" value="${token.replace(/[^A-Z0-9-]/g, "")}">
    <button name="decision" value="approve">Approve</button>
    <button name="decision" value="cancel">Cancel</button>
  </form>
</main>`;
}
