import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Id } from "@keepwell/contracts";

// Stateless signed token: base64url(JSON {m, e}) + "." + base64url(HMAC-SHA256). It has no expiry on
// purpose: an unsubscribe link in an old email has to keep working.

const Claims = z.object({ m: Id, e: z.email() });

export interface UnsubscribeSubject {
  merchantId: string;
  email: string;
}

/** Addresses are compared case-insensitively everywhere (caps, unsubscribes). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sign(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function createUnsubscribeToken(secret: string, subject: UnsubscribeSubject): string {
  const body = Buffer.from(
    JSON.stringify({ m: subject.merchantId, e: normalizeEmail(subject.email) }),
  ).toString("base64url");
  return `${body}.${sign(secret, body).toString("base64url")}`;
}

/** Returns null for anything that isn't a token we signed. */
export function verifyUnsubscribeToken(secret: string, token: string): UnsubscribeSubject | null {
  const [body, signature, ...rest] = token.split(".");
  if (!body || !signature || rest.length > 0) return null;
  const given = Buffer.from(signature, "base64url");
  const expected = sign(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    // Correctly signed but not JSON can't happen for our own tokens; treat it as invalid.
    return null;
  }
  const claims = Claims.safeParse(json);
  return claims.success ? { merchantId: claims.data.m, email: claims.data.e } : null;
}

export function unsubscribeUrl(publicUrl: string, secret: string, subject: UnsubscribeSubject): string {
  return `${publicUrl}/v1/unsubscribe?token=${createUnsubscribeToken(secret, subject)}`;
}
