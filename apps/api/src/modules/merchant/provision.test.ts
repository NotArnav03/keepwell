import * as argon2 from "argon2";
import { describe, expect, it } from "vitest";
import { hashMerchantPassword } from "./provision.js";

describe("merchant password hashing", () => {
  it("hashes passwords with Argon2id and never stores the plaintext", async () => {
    const password = "correct horse battery staple";
    const hash = await hashMerchantPassword(password);

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(password);
    await expect(argon2.verify(hash, password)).resolves.toBe(true);
    await expect(argon2.verify(hash, "incorrect password")).resolves.toBe(false);
  });

  it("rejects short passwords", async () => {
    await expect(hashMerchantPassword("short")).rejects.toThrow(/12 bytes/);
  });
});
