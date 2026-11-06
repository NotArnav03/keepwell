import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

describe("redact", () => {
  it("removes email addresses", () => {
    expect(redact("write to Maya.R+cancel@Example.co.uk please")).toBe("write to [email] please");
  });

  it("removes phone numbers in the usual shapes", () => {
    for (const phone of ["+91 98765 43210", "(555) 123-4567", "555.123.4567", "07700900123"]) {
      expect(redact(`call me on ${phone} today`)).toBe("call me on [phone] today");
    }
  });

  it("removes card-like numbers", () => {
    expect(redact("my card is 4111 1111 1111 1111")).toBe("my card is [number]");
  });

  it("leaves prices, years, plan names and short numbers alone", () => {
    const text = "It's $12.00 a month since 2024, I want Lite for 3 months, order 12345";
    expect(redact(text)).toBe(text);
  });
});
