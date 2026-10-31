import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Id } from "@keepwell/contracts";

// Reply links carry a signed token: base64url(json).base64url(hmac-sha256). The secret is
// MAGIC_LINK_SECRET, the same one that signs portal magic links. Single use is enforced by the
// case state (sent -> replied), not by the token, so the token needs no storage of its own.

export const REPLY_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const Claims = z.object({ m: Id, c: Id, exp: z.number().int() });
export type ReplyClaims = { merchantId: string; caseId: string };

export type TokenCheck = { ok: true; claims: ReplyClaims } | { ok: false; reason: "malformed" | "expired" };

function mac(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function signReplyToken(secret: string, claims: ReplyClaims, now: Date): string {
  const body = Buffer.from(
    JSON.stringify({ m: claims.merchantId, c: claims.caseId, exp: now.getTime() + REPLY_TOKEN_TTL_MS }),
  ).toString("base64url");
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

export function verifyReplyToken(secret: string, token: string, now: Date): TokenCheck {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return { ok: false, reason: "malformed" };
  const expected = mac(secret, body);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "malformed" };
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    // The signature matched, so this is our own bad payload; treat like any unusable token.
    return { ok: false, reason: "malformed" };
  }
  const claims = Claims.safeParse(json);
  if (!claims.success) return { ok: false, reason: "malformed" };
  if (claims.data.exp <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, claims: { merchantId: claims.data.m, caseId: claims.data.c } };
}
