import { createHash, randomBytes } from "node:crypto";

// Opaque bearer secrets (magic links, delegation tokens). Only the sha256 is ever stored, so a
// database leak doesn't hand out working tokens. 32 random bytes need no salt or slow hash.

export function newToken(prefix = ""): string {
  return prefix + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The value `subscriptions.subscriber_email_hash` holds: sha256 of the trimmed, lower-cased email. */
export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}
