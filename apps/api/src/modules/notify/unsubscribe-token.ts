import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Id, Sha256Hex } from "@keepwell/contracts";

// Stateless signed token: base64url(JSON {m, h}) + "." + base64url(HMAC-SHA256).
// `h` is sha256 of the address, never the address itself. The link is copied into mail clients and
// Fastify records req.url, and it has no expiry: an unsubscribe link in an old email has to keep working.

const Claims = z.object({ m: Id, h: Sha256Hex });

export interface UnsubscribeSubject {
  merchantId: string;
  email: string;
}

/** What a valid token proves. The address is not recoverable from it. */
export interface VerifiedUnsubscribe {
  merchantId: string;
  emailHash: string;
}

/** Addresses are compared case-insensitively, ignoring surrounding whitespace (caps, unsubscribes). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * sha256 hex of the normalised address. Same bytes as `subscriptions.subscriber_email_hash`
 * (trim, lower-case, sha256). Shared by the token, the unsubscribe store and the dispatcher.
 */
export function hashEmail(email: string): string {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

function sign(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function createUnsubscribeToken(secret: string, subject: UnsubscribeSubject): string {
  const body = Buffer.from(JSON.stringify({ m: subject.merchantId, h: hashEmail(subject.email) })).toString(
    "base64url",
  );
  return `${body}.${sign(secret, body).toString("base64url")}`;
}

/** Returns null for anything that isn't a token we signed. The signature compare is timing-safe. */
export function verifyUnsubscribeToken(secret: string, token: string): VerifiedUnsubscribe | null {
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
  return claims.success ? { merchantId: claims.data.m, emailHash: claims.data.h } : null;
}

export function unsubscribeUrl(publicUrl: string, secret: string, subject: UnsubscribeSubject): string {
  return `${publicUrl}/v1/unsubscribe?token=${createUnsubscribeToken(secret, subject)}`;
}
