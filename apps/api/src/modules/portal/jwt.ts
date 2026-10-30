import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import { WIDGET_TOKEN_TTL_SECONDS, WidgetTokenClaims } from "@keepwell/contracts";

// HS256 JWTs, by hand: node:crypto is enough for one algorithm, and accepting exactly one is
// the point (no "alg": "none", no RS/HS confusion). Subscriber identity, ARCHITECTURE.md §6.7.

const HEADER = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function signature(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function signJwt(claims: object, secret: string): string {
  const body = `${HEADER}.${base64url(JSON.stringify(claims))}`;
  return `${body}.${signature(body, secret).toString("base64url")}`;
}

/** Why a token was refused. The caller answers 401 either way; this is for logs and tests. */
export type JwtFailure = "malformed" | "bad_signature" | "invalid_claims" | "expired";

/**
 * Checks the signature (constant time) before reading anything, then the claims and `exp`.
 * Only our own header is accepted, so a token can't pick its algorithm.
 */
export function verifyJwt<S extends z.ZodType<{ exp: number }>>(
  token: string,
  secret: string,
  claims: S,
  now: Date,
): { ok: true; claims: z.infer<S> } | { ok: false; failure: JwtFailure } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== HEADER) return { ok: false, failure: "malformed" };
  const [header, body, sig] = parts as [string, string, string];
  const expected = signature(`${header}.${body}`, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, failure: "bad_signature" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, failure: "malformed" };
  }
  const parsed = claims.safeParse(payload);
  if (!parsed.success) return { ok: false, failure: "invalid_claims" };
  if (parsed.data.exp * 1000 <= now.getTime()) return { ok: false, failure: "expired" };
  return { ok: true, claims: parsed.data };
}

/** A widget token for one subscription, valid for 10 minutes. */
export function signWidgetToken(
  input: { merchantId: string; paypalSubscriptionId: string },
  secret: string,
  now: Date,
): { token: string; expiresAt: string } {
  const iat = Math.floor(now.getTime() / 1000);
  const claims = WidgetTokenClaims.parse({
    mid: input.merchantId,
    sid: input.paypalSubscriptionId,
    iat,
    exp: iat + WIDGET_TOKEN_TTL_SECONDS,
    nonce: randomBytes(16).toString("hex"),
  });
  return { token: signJwt(claims, secret), expiresAt: new Date(claims.exp * 1000).toISOString() };
}

export function verifyWidgetToken(token: string, secret: string, now: Date) {
  const result = verifyJwt(token, secret, WidgetTokenClaims, now);
  // A token claiming a longer life than we ever sign is forged or from a bug: refuse it.
  if (result.ok && result.claims.exp - result.claims.iat > WIDGET_TOKEN_TTL_SECONDS) {
    return { ok: false as const, failure: "invalid_claims" as const };
  }
  return result;
}
