import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DemoStoreTokenRequest,
  DemoStoreTokenResponse,
  DemoStoreVerifyRequest,
  DemoStoreVerifyResponse,
  ErrorEnvelope,
  Id,
  PayPalGatewayError,
  type PayPalGateway,
} from "@keepwell/contracts";
import { signJwt, signWidgetToken, verifyJwt } from "../portal/jwt.js";
import { allowCors } from "../sessions/cors.js";

// Pantry Plan's "backend" (CONTRACTS.md §4, Demo). The demo store is a static site, so the two
// things a merchant's server does live here: verify a new subscription with PayPal before granting
// access, and sign widget tokens for the shopper it verified.

export interface DemoStoreRoutesOptions {
  /** Reads only; PayPal is the source of truth for whether a subscription is live. */
  gateway: PayPalGateway;
  /** The demo merchant (Pantry Plan) in our database. */
  merchantId: string;
  /** PayPal plan id → plan name, for the plans Pantry Plan sells. Others are refused. */
  plans: Record<string, string>;
  /** Pantry Plan's Keepwell signing secret: what a real merchant keeps on its own server. */
  signingSecret: string;
  allowOrigin: (origin: string) => boolean;
  clock?: () => Date;
}

/** A shopper stays "logged in" to the demo store for 30 days. */
const SHOPPER_TTL_SECONDS = 30 * 24 * 3600;
// ACTIVE once PayPal has taken the first payment; APPROVED briefly before that.
const LIVE = new Set(["ACTIVE", "APPROVED"]);
const ShopperClaims = z.object({
  kind: z.literal("shopper"),
  mid: Id,
  sid: z.string().min(1),
  exp: z.number().int(),
});

class DemoStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const demoStoreRoutes: FastifyPluginCallback<DemoStoreRoutesOptions> = (app, options, done) => {
  const clock = options.clock ?? (() => new Date());

  allowCors(app, { allowOrigin: options.allowOrigin, paths: ["/demo-store/*"], headers: "content-type" });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof DemoStoreError)
      return sendError(request, reply, error.status, error.code, error.message);
    if (error instanceof PayPalGatewayError && error.kind === "not_found") {
      return sendError(request, reply, 404, "not_found", "PayPal doesn't know that subscription");
    }
    if (error instanceof PayPalGatewayError && error.retryable) {
      return sendError(request, reply, 503, "paypal_unavailable", "PayPal didn't answer; try again shortly");
    }
    request.log.error({ err: error }, "demo store route failed");
    return sendError(request, reply, 500, "internal", "Something went wrong on our side");
  });

  // Never grant access from onApprove alone: the browser's word is checked with PayPal first.
  app.post("/demo-store/subscriptions", { bodyLimit: 4096 }, async (request, reply) => {
    const { paypalSubscriptionId } = parse(DemoStoreVerifyRequest, request.body);
    const subscription = await options.gateway.getSubscription(options.merchantId, paypalSubscriptionId);
    const planName = options.plans[subscription.plan_id];
    if (planName === undefined) {
      throw new DemoStoreError(409, "unknown_plan", "That subscription isn't for a Pantry Plan plan");
    }
    if (!LIVE.has(subscription.status)) {
      throw new DemoStoreError(409, "not_active", `The subscription is ${subscription.status}`);
    }
    const exp = Math.floor(clock().getTime() / 1000) + SHOPPER_TTL_SECONDS;
    const shopperToken = signJwt(
      { kind: "shopper", mid: options.merchantId, sid: subscription.id, exp },
      options.signingSecret,
    );
    return reply.send(
      DemoStoreVerifyResponse.parse({
        paypalSubscriptionId: subscription.id,
        status: subscription.status,
        planName,
        shopperToken,
      }),
    );
  });

  app.post("/demo-store/token", { bodyLimit: 4096 }, (request, reply) => {
    const { shopperToken } = parse(DemoStoreTokenRequest, request.body);
    const shopper = verifyJwt(shopperToken, options.signingSecret, ShopperClaims, clock());
    if (!shopper.ok || shopper.claims.mid !== options.merchantId) {
      throw new DemoStoreError(401, "unauthorized", "Please subscribe or sign in again");
    }
    const signed = signWidgetToken(
      { merchantId: options.merchantId, paypalSubscriptionId: shopper.claims.sid },
      options.signingSecret,
      clock(),
    );
    return reply.send(DemoStoreTokenResponse.parse(signed));
  });

  done();
};

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new DemoStoreError(400, "invalid_request", z.prettifyError(result.error));
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
