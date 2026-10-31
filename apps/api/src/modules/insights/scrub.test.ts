import { describe, expect, it } from "vitest";
import { scrubQuote, scrubText } from "./scrub.js";

describe("scrubText", () => {
  it("removes emails", () => {
    expect(scrubText("write to maya.k+tea@example.com please")).toBe("write to [email] please");
  });

  it("removes phone and card-like numbers but keeps short numbers", () => {
    expect(scrubText("call +1 (555) 010-7788 or 555.010.7788")).toBe("call [number] or [number]");
    expect(scrubText("card 4242 4242 4242 4242 ended")).toBe("card [number] ended");
    expect(scrubText("I pay 12 dollars for 3 boxes")).toBe("I pay 12 dollars for 3 boxes");
  });

  it("removes names the subscriber introduces and titled names", () => {
    expect(scrubText("Hi, my name is Maya Rao and it is pricey")).toBe(
      "Hi, my name is [name] and it is pricey",
    );
    expect(scrubText("Thanks, Raj")).toBe("Thanks, [name]");
    expect(scrubText("ask Dr. Patel about it")).toBe("ask [name] about it");
  });

  it("removes known names, case-insensitively and only as whole words", () => {
    expect(scrubText("maya says Mayakovsky is fine", ["Maya"])).toBe("[name] says Mayakovsky is fine");
  });

  it("leaves ordinary lowercase text after a trigger alone", () => {
    expect(scrubText("this is too expensive")).toBe("this is too expensive");
  });
});

describe("scrubQuote", () => {
  it("returns null for null or blank input", () => {
    expect(scrubQuote(null)).toBeNull();
    expect(scrubQuote("   ")).toBeNull();
  });

  it("caps at 20 words", () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${String(i)}`).join(" ");
    expect(scrubQuote(long)?.split(" ")).toHaveLength(20);
  });

  it("keeps exactly 20 words and collapses whitespace", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `w${String(i)}`).join("  \n ");
    expect(scrubQuote(twenty)?.split(" ")).toHaveLength(20);
  });

  it("scrubs before capping, so a cut can't leave half an email", () => {
    expect(scrubQuote("email me at a@b.co now", [])).toBe("email me at [email] now");
  });

  it("stays within 160 characters", () => {
    const wide = Array.from({ length: 20 }, () => "x".repeat(15)).join(" ");
    expect((scrubQuote(wide) ?? "").length).toBeLessThanOrEqual(160);
  });
});
