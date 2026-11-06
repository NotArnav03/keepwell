import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { Channel, Id, SessionError, type SubscriberPrincipal } from "@keepwell/contracts";
import { signJwt, verifyJwt, verifyPortalSessionToken, verifyWidgetToken } from "../portal/jwt.js";

// Who is calling /v1/sessions (ARCHITECTURE.md §6.7), for the real module (#32):
// - `Authorization: Bearer <widget token>`: HS256 from the merchant's backend, bound to one PayPal
//   subscription. The token names its merchant, whose secret then checks the signature.
// - `Authorization: Bearer <portal session token>`: from POST /v1/portal/token, bound to one of our
//   subscription ids, channel portal.
// - `?ticket=` on the stream URL only: EventSource can't send headers, so create() hands back a
//   stream URL carrying a ticket for that one session, read-only.
// Anything else is unauthorized, with one message for every failure.

/** How long a stream URL works. Reconnects reuse it, so it outlives the 10-minute widget token. */
export const STREAM_TICKET_TTL_SECONDS = 2 * 3600;

const StreamTicketClaims = z.object({
  kind: z.literal("stream"),
  mid: Id,
  /** Our subscription id. */
  sub: Id,
  /** The one session this ticket reads. */
  sid: Id,
  ch: Channel,
  iat: z.number().int(),
  exp: z.number().int(),
  nonce: z.string().min(16).max(64),
});

export function signStreamTicket(
  input: { sessionId: string; principal: SubscriberPrincipal },
  secret: string,
  now: Date,
): string {
  const iat = Math.floor(now.getTime() / 1000);
  return signJwt(
    StreamTicketClaims.parse({
      kind: "stream",
      mid: input.principal.merchantId,
      sub: input.principal.subscriptionId,
      sid: input.sessionId,
      ch: input.principal.channel,
      iat,
      exp: iat + STREAM_TICKET_TTL_SECONDS,
      nonce: randomBytes(16).toString("hex"),
    }),
    secret,
  );
}

/**
 * The hackathon's widget-token secrets: one `WIDGET_TOKEN_SECRET`, for the demo merchant only.
 * Every other merchant gets null, so no other merchant's widget token is ever accepted. Per-merchant
 * secrets in `merchants.keepwell_signing_secret_enc` are the next step (sessions README).
 */
export function demoMerchantWidgetSecret(
  demoMerchantId: string,
  secret: string | undefined,
): (merchantId: string) => Promise<string | null> {
  return (merchantId) => Promise.resolve(secret && merchantId === demoMerchantId ? secret : null);
}

export interface SessionAuthOptions {
  /** The merchant's widget-token secret, or null if it has none. */
  widgetSecret: (merchantId: string) => Promise<string | null>;
  /** Signs portal session tokens (the same secret as the portal routes). */
  portalSecret: string;
  /** Signs stream tickets. */
  ticketSecret: string;
  /** Our subscription id for a merchant's PayPal subscription, or null. */
  subscriptionByPayPalId: (merchantId: string, paypalSubscriptionId: string) => Promise<string | null>;
  clock?: () => Date;
}

const StreamParams = z.object({ id: z.string() });
const TicketQuery = z.object({ ticket: z.string().min(1).max(2048) });
const UnverifiedMid = z.object({ mid: Id });

/** The `authenticate` that sessionRoutes takes. */
export function sessionAuthenticator(options: SessionAuthOptions) {
  const clock = options.clock ?? (() => new Date());

  return async (request: FastifyRequest): Promise<SubscriberPrincipal> => {
    const now = clock();
    const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (bearer !== undefined) return fromBearer(bearer, now);

    // Only the stream takes a ticket, and only for the session it names.
    const ticket = TicketQuery.safeParse(request.query);
    const params = StreamParams.safeParse(request.params);
    if (ticket.success && params.success && request.url.split("?")[0]?.endsWith("/stream")) {
      const verified = verifyJwt(ticket.data.ticket, options.ticketSecret, StreamTicketClaims, now);
      if (verified.ok && verified.claims.sid === params.data.id) {
        if (verified.claims.exp - verified.claims.iat <= STREAM_TICKET_TTL_SECONDS) {
          return {
            merchantId: verified.claims.mid,
            subscriptionId: verified.claims.sub,
            channel: verified.claims.ch,
          };
        }
      }
    }
    throw unauthorized();
  };

  async function fromBearer(token: string, now: Date): Promise<SubscriberPrincipal> {
    const portal = verifyPortalSessionToken(token, options.portalSecret, now);
    if (portal.ok) {
      return { merchantId: portal.claims.mid, subscriptionId: portal.claims.sub, channel: "portal" };
    }
    // The token says which merchant signed it; that merchant's secret then decides.
    const mid = UnverifiedMid.safeParse(payloadOf(token));
    if (!mid.success) throw unauthorized();
    const secret = await options.widgetSecret(mid.data.mid);
    if (secret === null) throw unauthorized();
    const widget = verifyWidgetToken(token, secret, now);
    if (!widget.ok || widget.claims.mid !== mid.data.mid) throw unauthorized();
    const subscriptionId = await options.subscriptionByPayPalId(widget.claims.mid, widget.claims.sid);
    if (subscriptionId === null) throw unauthorized();
    return { merchantId: widget.claims.mid, subscriptionId, channel: "widget" };
  }
}

/** A JWT's payload, unverified: only to pick which key verifies it. */
function payloadOf(token: string): unknown {
  const body = token.split(".")[1];
  if (body === undefined) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function unauthorized(): SessionError {
  return new SessionError("unauthorized", "Invalid or expired credential");
}
