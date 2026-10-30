import { describe, expect, it } from "vitest";
import { signJwt, signWidgetToken, verifyWidgetToken } from "./jwt.js";

const SECRET = "test-signing-secret-of-decent-length";
const NOW = new Date("2026-10-30T10:00:00.000Z");
const input = { merchantId: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b", paypalSubscriptionId: "I-MAYA0001" };

describe("widget tokens", () => {
  it("verify for 10 minutes, then expire", () => {
    const { token, expiresAt } = signWidgetToken(input, SECRET, NOW);
    expect(expiresAt).toBe("2026-10-30T10:10:00.000Z");
    expect(verifyWidgetToken(token, SECRET, NOW)).toMatchObject({ ok: true, claims: { sid: "I-MAYA0001" } });
    expect(verifyWidgetToken(token, SECRET, new Date("2026-10-30T10:10:00.000Z"))).toEqual({
      ok: false,
      failure: "expired",
    });
  });

  it("each token has its own nonce", () => {
    const a = verifyWidgetToken(signWidgetToken(input, SECRET, NOW).token, SECRET, NOW);
    const b = verifyWidgetToken(signWidgetToken(input, SECRET, NOW).token, SECRET, NOW);
    expect(a.ok && b.ok && a.claims.nonce !== b.claims.nonce).toBe(true);
  });

  it("refuses another secret, a tampered body, alg none and an overlong life", () => {
    const { token } = signWidgetToken(input, SECRET, NOW);
    expect(verifyWidgetToken(token, "another-secret", NOW)).toEqual({ ok: false, failure: "bad_signature" });

    const [header, body, sig] = token.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
    const swapped = Buffer.from(JSON.stringify({ ...claims, sid: "I-SOMEONEELSE" })).toString("base64url");
    expect(verifyWidgetToken(`${header}.${swapped}.${sig}`, SECRET, NOW)).toEqual({
      ok: false,
      failure: "bad_signature",
    });

    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    expect(verifyWidgetToken(`${none}.${body}.`, SECRET, NOW)).toEqual({ ok: false, failure: "malformed" });

    const iat = Math.floor(NOW.getTime() / 1000);
    const longLived = signJwt({ ...claims, iat, exp: iat + 86_400 }, SECRET);
    expect(verifyWidgetToken(longLived, SECRET, NOW)).toEqual({ ok: false, failure: "invalid_claims" });
    expect(verifyWidgetToken("not.a.jwt", SECRET, NOW)).toEqual({ ok: false, failure: "malformed" });
  });
});
