import { describe, expect, it } from "vitest";
import { decryptPayPalSecret, encryptPayPalSecret, parseCredentialKey } from "./credentials.js";

const KEY = Buffer.from("a 32-byte encryption key for tests!", "utf8").subarray(0, 32);

describe("PayPal credential encryption", () => {
  it("round-trips AES-256-GCM secrets with a fresh IV each time", () => {
    const first = encryptPayPalSecret("private sandbox secret", KEY);
    const second = encryptPayPalSecret("private sandbox secret", KEY);
    expect(first).not.toBe(second);
    expect(decryptPayPalSecret(first, KEY)).toBe("private sandbox secret");
  });

  it("rejects tampered ciphertext and invalid key sizes", () => {
    const encrypted = encryptPayPalSecret("secret", KEY);
    const parts = encrypted.split(".");
    const ciphertext = parts[3] ?? "";
    parts[3] = `${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`;
    expect(() => decryptPayPalSecret(parts.join("."), KEY)).toThrow();
    expect(() => parseCredentialKey("not-base64-key")).toThrow(/32 bytes/);
  });
});
