import { describe, expect, it } from "vitest";
import { Id, PayPalGatewayError } from "@keepwell/contracts";
import type { Db } from "@keepwell/db";
import { PLATFORM_APP_ID } from "../paypal/credentials.js";
import {
  DbCredentialSource,
  decryptPayPalSecret,
  encryptPayPalSecret,
  parseCredentialKey,
} from "./credentials.js";

const KEY = Buffer.from("a 32-byte encryption key for tests!", "utf8").subarray(0, 32);
const M1 = "01990000-0000-7000-8000-000000000001";
const M2 = "01990000-0000-7000-8000-000000000002";

describe("PayPal credential encryption", () => {
  it("round-trips AES-256-GCM secrets with a fresh IV each time", () => {
    const first = encryptPayPalSecret("private sandbox secret", KEY, M1);
    const second = encryptPayPalSecret("private sandbox secret", KEY, M1);
    expect(first).not.toBe(second);
    expect(decryptPayPalSecret(first, KEY, M1)).toBe("private sandbox secret");
  });

  it("rejects tampered ciphertext and invalid key sizes", () => {
    const encrypted = encryptPayPalSecret("secret", KEY, M1);
    const parts = encrypted.split(".");
    const ciphertext = parts[3] ?? "";
    parts[3] = `${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`;
    expect(() => decryptPayPalSecret(parts.join("."), KEY, M1)).toThrow();
    expect(() => parseCredentialKey("not-base64-key")).toThrow(/32 bytes/);
  });

  it("will not decrypt a secret copied onto another merchant", () => {
    const encrypted = encryptPayPalSecret("secret", KEY, M1);
    expect(() => decryptPayPalSecret(encrypted, KEY, M2)).toThrow();
  });
});

describe("DbCredentialSource", () => {
  const dbWith = (row: { clientId: string; secretEnc: string }): Db =>
    ({ forMerchant: () => Promise.resolve([row]) }) as unknown as Db;
  const key = KEY.toString("base64");

  it("returns the decrypted credentials", async () => {
    const secretEnc = encryptPayPalSecret("s3cret", KEY, M1);
    const source = new DbCredentialSource(dbWith({ clientId: "id", secretEnc }), key);
    await expect(source.forMerchant(M1)).resolves.toEqual({ clientId: "id", clientSecret: "s3cret" });
  });

  it("serves the platform app for /status's key, which no merchant has", async () => {
    // Like the real forMerchant, this parses the id first: the old "status" key threw here, so
    // /status showed PayPal as down whenever merchant credentials were stored in the database.
    const db = {
      forMerchant: (merchantId: string) => {
        Id.parse(merchantId);
        return Promise.resolve([]);
      },
    } as unknown as Db;
    const platformApp = { clientId: "platform-id", clientSecret: "platform-secret" };
    const source = new DbCredentialSource(db, key, platformApp);
    await expect(source.forMerchant(PLATFORM_APP_ID)).resolves.toEqual(platformApp);
    await expect(source.forMerchant("status")).rejects.toThrow();
  });

  it("fails with a non-retryable error when the secret cannot be decrypted", async () => {
    const secretEnc = encryptPayPalSecret("s3cret", KEY, M2);
    const source = new DbCredentialSource(dbWith({ clientId: "id", secretEnc }), key);
    const error = await source.forMerchant(M1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalGatewayError);
    expect(error).toMatchObject({ kind: "unauthorized", retryable: false });
  });
});
