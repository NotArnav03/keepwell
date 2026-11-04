import { PortalClaims, PORTAL_SESSION_TTL_SECONDS } from "@keepwell/contracts";
import { signJwt, verifyJwt } from "./jwt.js";

// The PORTAL cookie's value: a signed HS256 token naming who clicked a magic link (§6.7).

export const PORTAL_COOKIE = "kw_portal";

export function signPortalSession(
  who: { merchantId: string; emailHash: string },
  secret: string,
  now: Date,
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const claims = PortalClaims.parse({
    kind: "portal",
    mid: who.merchantId,
    eh: who.emailHash,
    iat,
    exp: iat + PORTAL_SESSION_TTL_SECONDS,
  });
  return signJwt(claims, secret);
}

export function verifyPortalSession(token: string, secret: string, now: Date) {
  const result = verifyJwt(token, secret, PortalClaims, now);
  if (result.ok && result.claims.exp - result.claims.iat > PORTAL_SESSION_TTL_SECONDS) {
    return { ok: false as const, failure: "invalid_claims" as const };
  }
  return result;
}
