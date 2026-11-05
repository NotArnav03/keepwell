import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { signJwt, signWidgetToken } from "../portal/jwt.js";
import { sessionAuthenticator, signStreamTicket, STREAM_TICKET_TTL_SECONDS } from "./auth.js";

const NOW = new Date("2026-11-05T10:00:00.000Z");
const M = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const OTHER_M = "0199a1b2-c3d4-7e5f-8a6b-000000000bbb";
const SUB = "0199a1b2-0000-7000-8000-000000000001";
const SESSION = "0199a1b2-0000-7000-8000-0000000000a1";
const SECRETS = {
  widget: "merchant-widget-secret-long-enough",
  portal: "portal-secret-long-enough",
  ticket: "ticket-secret-long-enough",
};

const authenticate = sessionAuthenticator({
  widgetSecret: (mid) => Promise.resolve(mid === M ? SECRETS.widget : null),
  portalSecret: SECRETS.portal,
  ticketSecret: SECRETS.ticket,
  subscriptionByPayPalId: (mid, sid) => Promise.resolve(mid === M && sid === "I-MAYA0001" ? SUB : null),
  clock: () => NOW,
});

function request(input: { bearer?: string; url?: string; params?: object; query?: object }): FastifyRequest {
  return {
    headers: input.bearer === undefined ? {} : { authorization: `Bearer ${input.bearer}` },
    url: input.url ?? "/v1/sessions",
    params: input.params ?? {},
    query: input.query ?? {},
  } as unknown as FastifyRequest;
}

const portalToken = (claims: object, secret = SECRETS.portal) =>
  signJwt(
    {
      kind: "portal_session",
      mid: M,
      sub: SUB,
      iat: 1_793_000_000,
      exp: 1_793_000_000 + 600,
      nonce: "n".repeat(32),
      ...claims,
    },
    secret,
  );

describe("sessionAuthenticator", () => {
  it("accepts the merchant's widget token and maps the PayPal subscription to ours", async () => {
    const { token } = signWidgetToken(
      { merchantId: M, paypalSubscriptionId: "I-MAYA0001" },
      SECRETS.widget,
      NOW,
    );
    expect(await authenticate(request({ bearer: token }))).toEqual({
      merchantId: M,
      subscriptionId: SUB,
      channel: "widget",
    });
  });

  it("refuses a widget token signed with another key, from an unknown merchant, or for an unknown subscription", async () => {
    const forged = signWidgetToken(
      { merchantId: M, paypalSubscriptionId: "I-MAYA0001" },
      "not-the-secret-at-all",
      NOW,
    );
    const elsewhere = signWidgetToken(
      { merchantId: OTHER_M, paypalSubscriptionId: "I-MAYA0001" },
      SECRETS.widget,
      NOW,
    );
    const unknown = signWidgetToken(
      { merchantId: M, paypalSubscriptionId: "I-NOBODY0001" },
      SECRETS.widget,
      NOW,
    );
    const expired = signWidgetToken(
      { merchantId: M, paypalSubscriptionId: "I-MAYA0001" },
      SECRETS.widget,
      new Date(NOW.getTime() - 11 * 60_000),
    );
    for (const { token } of [forged, elsewhere, unknown, expired]) {
      await expect(authenticate(request({ bearer: token }))).rejects.toMatchObject({ code: "unauthorized" });
    }
    await expect(authenticate(request({ bearer: "garbage" }))).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(authenticate(request({}))).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("accepts the portal's session token as the portal channel", async () => {
    const iat = Math.floor(NOW.getTime() / 1000);
    const token = portalToken({ iat, exp: iat + 600 });
    expect(await authenticate(request({ bearer: token }))).toEqual({
      merchantId: M,
      subscriptionId: SUB,
      channel: "portal",
    });
    await expect(
      authenticate(request({ bearer: portalToken({ iat, exp: iat + 600 }, "wrong-secret-long-enough") })),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("takes a stream ticket only on that session's stream, and only for a while", async () => {
    const principal = { merchantId: M, subscriptionId: SUB, channel: "portal" as const };
    const ticket = signStreamTicket({ sessionId: SESSION, principal }, SECRETS.ticket, NOW);
    const stream = (id: string, url = `/v1/sessions/${id}/stream?ticket=x`) =>
      request({ url, params: { id }, query: { ticket } });

    expect(await authenticate(stream(SESSION))).toEqual(principal);
    // Another session's stream, or another route, doesn't take it.
    await expect(authenticate(stream("0199a1b2-0000-7000-8000-0000000000a2"))).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(
      authenticate(stream(SESSION, `/v1/sessions/${SESSION}/cancel?ticket=x`)),
    ).rejects.toMatchObject({ code: "unauthorized" });

    const later = sessionAuthenticator({
      widgetSecret: () => Promise.resolve(null),
      portalSecret: SECRETS.portal,
      ticketSecret: SECRETS.ticket,
      subscriptionByPayPalId: () => Promise.resolve(null),
      clock: () => new Date(NOW.getTime() + (STREAM_TICKET_TTL_SECONDS + 1) * 1000),
    });
    await expect(later(stream(SESSION))).rejects.toMatchObject({ code: "unauthorized" });
  });
});
