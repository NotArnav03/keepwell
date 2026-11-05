import { describe, expect, it } from "vitest";
import { redactPii } from "./redact.js";

const UNCHANGED = [
  "I was away for 2 months and paid 12 dollars on 3 March",
  "On 2026-11-05 I paid $12.00 and then 3.50 after 2 days.",
  "Order 12345 arrived on 3/3/2026.",
  "12-31-2024 was a short stay.",
  "123456789012",
  "12345678901234567890",
  "1 2 3 4 5 6 7 8 9 0 1 2 3",
  "Balance 1234567890123.45 remains.",
  "",
];

describe("redactPii", () => {
  it.each(UNCHANGED)("leaves %j unchanged", (text) => {
    expect(redactPii(text)).toBe(text);
  });

  it.each(["maya@example.test", "Maya.R@example.co.uk", "MAYA@Example.TEST"])("redacts email %s", (email) => {
    expect(redactPii(`write ${email} today`)).toBe("write [email] today");
  });

  it.each([
    "+1 415 555 0100",
    "(415) 555-0100",
    "415-555-0100",
    "415 555 0100",
    "415.555.0100",
    "+1-415-555-0100",
    "+1 (415) 555-0100",
    "+44 20 7946 0958",
    "+91 98765 43210",
    "+14155550100",
  ])("redacts phone %s", (phone) => {
    expect(redactPii(`call ${phone} please`)).toBe("call [phone] please");
  });

  it("does not swallow a trailing price into an international number", () => {
    expect(redactPii("Call +44 20 7946 0958 about the 12 dollars")).toBe("Call [phone] about the 12 dollars");
    expect(redactPii("Call +44 20 7946 0958 12 dollars")).toBe("Call [phone] 12 dollars");
  });

  it.each([
    "4111111111111111",
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
    "1234567890123",
    "1234567890123456789",
    "1234 5678 9012 345",
    "4111-1111-1111-1111.",
  ])("redacts card-like %s", (number) => {
    expect(redactPii(`card ${number} ok`)).toBe(
      number.endsWith(".") ? "card [number]. ok" : "card [number] ok",
    );
  });

  it("redacts every kind in one reply and leaves the ordinary sentence", () => {
    const raw =
      "I was away for 2 months and paid 12 dollars on 3 March. Reach me at maya@example.test or +1 415 555 0100. Card 4111-1111-1111-1111.";
    expect(redactPii(raw)).toBe(
      "I was away for 2 months and paid 12 dollars on 3 March. Reach me at [email] or [phone]. Card [number].",
    );
  });

  it("is stable when run twice", () => {
    const once = redactPii("maya@example.test and +44 20 7946 0958 and 4111 1111 1111 1111");
    expect(redactPii(once)).toBe(once);
    expect(once).toBe("[email] and [phone] and [number]");
  });
});
