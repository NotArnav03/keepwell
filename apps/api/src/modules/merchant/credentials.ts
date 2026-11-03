import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { PayPalGatewayError } from "@keepwell/contracts";
import { merchants, type Db } from "@keepwell/db";
import type { CredentialSource, PayPalCredentials } from "../paypal/credentials.js";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

export function parseCredentialKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new Error("PAYPAL_CREDENTIALS_ENCRYPTION_KEY must be base64 for exactly 32 bytes");
  }
  return key;
}

export function encryptPayPalSecret(secret: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("AES-256-GCM needs a 32-byte key");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptPayPalSecret(encrypted: string, key: Buffer): string {
  const [version, ivPart, tagPart, ciphertextPart, extra] = encrypted.split(".");
  if (version !== VERSION || !ivPart || !tagPart || ciphertextPart === undefined || extra !== undefined) {
    throw new Error("Stored PayPal credential has an unsupported format");
  }
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Stored PayPal credential is malformed");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export class DbCredentialSource implements CredentialSource {
  private readonly key: Buffer;

  constructor(
    private readonly db: Db,
    key: string,
    private readonly fallback?: PayPalCredentials,
  ) {
    this.key = parseCredentialKey(key);
  }

  async forMerchant(merchantId: string): Promise<PayPalCredentials> {
    const [row] = await this.db.forMerchant(merchantId, (tx) =>
      tx
        .select({ clientId: merchants.paypalClientId, secretEnc: merchants.paypalSecretEnc })
        .from(merchants)
        .where(eq(merchants.id, merchantId))
        .limit(1),
    );
    if (row?.clientId && row.secretEnc) {
      try {
        return { clientId: row.clientId, clientSecret: decryptPayPalSecret(row.secretEnc, this.key) };
      } catch (cause) {
        const error = new PayPalGatewayError(
          "unavailable",
          "Stored PayPal credentials could not be decrypted",
        );
        error.cause = cause;
        throw error;
      }
    }
    if (this.fallback) return this.fallback;
    throw new PayPalGatewayError("unauthorized", "PayPal credentials have not been configured");
  }
}
