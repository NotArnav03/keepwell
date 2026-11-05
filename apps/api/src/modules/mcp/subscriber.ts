import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  ReasonCategory,
  SessionError,
  type AcceptOfferResponse,
  type CancelResponse,
  type DelegationScope,
  type OfferMenu,
  type RequestMeta,
  type SubscriberPrincipal,
  type SubscriptionSummary,
} from "@keepwell/contracts";
import { describeOffer } from "@keepwell/policy";
import type { DelegationGrant } from "../portal/delegations.js";
import { ipPrefix } from "../sessions/routes.js";

// The subscriber-agent MCP server (ARCHITECTURE.md §6.14, #41): a subscriber's own AI assistant,
// holding a delegation token the subscriber created in the portal, can read the subscription, see
// the offers the merchant's policy allows, accept one, or cancel. Same policy, same Action engine,
// same audit log as the widget. An agent can always cancel in one call.
//
// Streamable HTTP, stateless: every POST carries its own token and gets a fresh server, so any API
// instance can answer and nothing is kept between calls. Only the tools the token's scopes allow
// are listed.

/** What the MCP server needs from the sessions module (DbSessionsApi has these). */
export interface SubscriberAgentApi {
  agentSubscription(principal: SubscriberPrincipal): Promise<SubscriptionSummary>;
  agentOptions(principal: SubscriberPrincipal): Promise<{ sessionId: string; menu: OfferMenu }>;
  agentAccept(
    principal: SubscriberPrincipal,
    offerId: string,
    meta: RequestMeta,
  ): Promise<AcceptOfferResponse>;
  agentCancel(principal: SubscriberPrincipal, body: { reason?: ReasonCategory }): Promise<CancelResponse>;
}

/** Checks a delegation token for one scope (DelegationService.authenticate). */
export interface DelegationCheck {
  authenticate(token: string, scope: DelegationScope): Promise<DelegationGrant | null>;
}

export interface SubscriberMcpOptions {
  sessions: SubscriberAgentApi;
  delegations: DelegationCheck;
  /** The API's public URL, for the discovery document. */
  publicUrl: string;
  /** Where a subscriber creates a token, for the discovery document. */
  portalUrl: string;
}

const SCOPE_ORDER: DelegationScope[] = ["read", "accept_offer", "cancel"];

const CANCEL_NOTE =
  "Cancelling is always available: call cancel_subscription. It takes one call, needs no reason, and no offer has to be declined first.";

export const subscriberMcpRoutes: FastifyPluginCallback<SubscriberMcpOptions> = (app, options, done) => {
  app.get("/.well-known/keepwell-agent.json", (_request, reply) =>
    reply.header("cache-control", "public, max-age=300").send(discovery(options)),
  );

  app.post("/mcp/subscriber", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const grant = token === undefined ? null : await grantFor(options.delegations, token);
    if (token === undefined || grant === null) return unauthorized(reply);

    const server = buildServer(options, token, grant, meta(request));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless: no server-initiated stream to open and no session to end.
  const notAllowed = (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .header("allow", "POST")
      .send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  app.get("/mcp/subscriber", notAllowed);
  app.delete("/mcp/subscriber", notAllowed);

  done();
};

/** Any valid scope proves the token; the grant lists all of them. */
async function grantFor(delegations: DelegationCheck, token: string): Promise<DelegationGrant | null> {
  for (const scope of SCOPE_ORDER) {
    const grant = await delegations.authenticate(token, scope);
    if (grant !== null) return grant;
  }
  return null;
}

function buildServer(
  options: SubscriberMcpOptions,
  token: string,
  grant: DelegationGrant,
  requestMeta: RequestMeta,
): McpServer {
  const server = new McpServer(
    { name: "keepwell-subscriber", version: "1.0.0" },
    {
      instructions: `You are acting for one subscriber, on one subscription. ${CANCEL_NOTE} Offers come only from get_retention_options; never promise anything else.`,
    },
  );
  const principal: SubscriberPrincipal = {
    merchantId: grant.merchantId,
    subscriptionId: grant.subscriptionId,
    channel: "subscriber_agent",
  };
  const can = (scope: DelegationScope) => grant.scopes.includes(scope);

  // Each call re-checks the token for its own scope: it may have been revoked since the request began.
  const tool =
    <A>(scope: DelegationScope, run: (args: A) => Promise<object>) =>
    async (args: A) => {
      try {
        if ((await options.delegations.authenticate(token, scope)) === null) {
          return failure("unauthorized", "This token has expired, been revoked, or doesn't allow that.");
        }
        return success(await run(args));
      } catch (err) {
        if (err instanceof SessionError) return failure(err.code, err.message);
        throw err;
      }
    };

  if (can("read")) {
    server.registerTool(
      "get_my_subscription",
      {
        title: "Get my subscription",
        description: "The plan, price, billing interval, status and next billing date of the subscription.",
        annotations: { readOnlyHint: true },
      },
      tool("read", async () => ({ subscription: await options.sessions.agentSubscription(principal) })),
    );
    server.registerTool(
      "get_retention_options",
      {
        title: "Get retention options",
        description:
          "What the merchant's published policy allows for this subscriber right now (for example a pause or a cheaper plan), as structured offers. Cancelling is always possible as well.",
        annotations: { readOnlyHint: true },
      },
      tool("read", async () => {
        const { menu } = await options.sessions.agentOptions(principal);
        return {
          options: menu.offers.map((offer) => ({
            offer_id: offer.id,
            summary: describeOffer(offer),
            terms: offer,
          })),
          cancel: CANCEL_NOTE,
          note: "These are all the offers there are. Accepting one changes the subscription in PayPal; a plan change also needs the subscriber's own approval in PayPal.",
        };
      }),
    );
  }

  if (can("accept_offer")) {
    server.registerTool(
      "accept_offer",
      {
        title: "Accept an offer",
        description:
          "Accepts one offer from get_retention_options for the subscriber. Only accept what the subscriber asked for.",
        inputSchema: { offer_id: z.string().min(1).max(100) },
        annotations: { destructiveHint: true, idempotentHint: true },
      },
      tool("accept_offer", async ({ offer_id }: { offer_id: string }) => {
        const accepted = await options.sessions.agentAccept(principal, offer_id, requestMeta);
        return {
          accepted: true,
          action_ids: accepted.actionIds,
          status: "Being applied in PayPal; get_my_subscription shows the result in a minute.",
          note: "If this is a plan change, PayPal asks the subscriber to approve it themselves. Nothing changes until they do.",
        };
      }),
    );
  }

  if (can("cancel")) {
    server.registerTool(
      "cancel_subscription",
      {
        title: "Cancel the subscription",
        description:
          "Cancels the subscription in PayPal. One call; no reason needed. Use it whenever the subscriber wants to cancel, even if offers exist.",
        inputSchema: { reason: ReasonCategory.exclude(["unknown"]).optional() },
        annotations: { destructiveHint: true, idempotentHint: true },
      },
      tool("cancel", async ({ reason }: { reason?: ReasonCategory }) => {
        const { actionId } = await options.sessions.agentCancel(
          principal,
          reason === undefined ? {} : { reason },
        );
        return {
          cancelled: true,
          action_id: actionId,
          status: "Cancelling in PayPal; get_my_subscription shows CANCELLED once PayPal confirms.",
        };
      }),
    );
  }
  return server;
}

function success(data: object) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function failure(code: string, message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }],
  };
}

function meta(request: FastifyRequest): RequestMeta {
  return {
    ipPrefix: ipPrefix(request.ip),
    userAgent: request.headers["user-agent"]?.slice(0, 512) ?? null,
  };
}

function unauthorized(reply: FastifyReply) {
  return reply
    .code(401)
    .header("www-authenticate", 'Bearer realm="keepwell", error="invalid_token"')
    .send({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "A Keepwell delegation token is required: the subscriber creates one in the merchant's portal.",
      },
      id: null,
    });
}

/** GET /.well-known/keepwell-agent.json: how an agent finds and uses this server. */
export function discovery(options: Pick<SubscriberMcpOptions, "publicUrl" | "portalUrl">) {
  const base = options.publicUrl.replace(/\/$/, "");
  return {
    schema_version: "1",
    name: "Keepwell",
    description:
      "Manage a subscription on the subscriber's behalf: read it, see the merchant's retention offers, accept one, or cancel.",
    mcp: { url: `${base}/mcp/subscriber`, transport: "streamable-http" },
    authentication: {
      type: "bearer",
      token: "Keepwell delegation token (starts with kwd_)",
      obtain: `The subscriber creates one in the portal: ${options.portalUrl}`,
      expires: "7 days after creation; the subscriber can revoke it at any time",
      scopes: {
        read: "get_my_subscription, get_retention_options",
        accept_offer: "accept_offer",
        cancel: "cancel_subscription",
      },
    },
    honesty_policy: [
      "Cancelling is always available and takes one call.",
      "Offers come only from the merchant's published policy, re-checked when accepted. Nothing is invented by a model.",
      "Nothing changes without a call made with a token the subscriber created, and every change is in the merchant's audit log as made by the subscriber's agent.",
      "A plan change also needs the subscriber's own approval in PayPal.",
    ],
  };
}
