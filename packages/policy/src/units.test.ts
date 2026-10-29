import { describe, expect, it } from "vitest";
import { addIntervals, daysBetween, fromCents, sameInterval, toCents } from "./units.js";

describe("money in cents", () => {
  it("converts both ways without floats", () => {
    expect(toCents({ value: "12.34", currency: "USD" })).toBe(1234);
    expect(toCents({ value: "0.05", currency: "USD" })).toBe(5);
    expect(fromCents(1234, "USD")).toEqual({ value: "12.34", currency: "USD" });
    expect(fromCents(5, "EUR")).toEqual({ value: "0.05", currency: "EUR" });
    expect(fromCents(0, "USD").value).toBe("0.00");
  });

  it("round-trips any cent amount", () => {
    for (const cents of [0, 1, 99, 100, 101, 999_999]) {
      expect(toCents(fromCents(cents, "USD"))).toBe(cents);
    }
  });
});

describe("time", () => {
  it("measures fractional days in either direction", () => {
    expect(daysBetween("2026-10-29T00:00:00Z", "2026-11-08T12:00:00Z")).toBe(10.5);
    expect(daysBetween("2026-10-29T00:00:00Z", "2026-10-28T00:00:00Z")).toBe(-1);
  });

  it("adds days, weeks, months and years in UTC", () => {
    const t = "2026-10-29T10:00:00Z";
    expect(addIntervals(t, { unit: "DAY", count: 1 }, 3)).toBe("2026-11-01T10:00:00.000Z");
    expect(addIntervals(t, { unit: "WEEK", count: 2 }, 1)).toBe("2026-11-12T10:00:00.000Z");
    expect(addIntervals(t, { unit: "MONTH", count: 1 }, 3)).toBe("2027-01-29T10:00:00.000Z");
    expect(addIntervals(t, { unit: "YEAR", count: 1 }, 1)).toBe("2027-10-29T10:00:00.000Z");
  });

  it("clamps month ends instead of spilling into the next month", () => {
    const month = { unit: "MONTH", count: 1 } as const;
    expect(addIntervals("2027-01-31T10:00:00Z", month, 1)).toBe("2027-02-28T10:00:00.000Z");
    expect(addIntervals("2028-01-31T10:00:00Z", month, 1)).toBe("2028-02-29T10:00:00.000Z");
    expect(addIntervals("2028-02-29T10:00:00Z", { unit: "YEAR", count: 1 }, 1)).toBe(
      "2029-02-28T10:00:00.000Z",
    );
  });

  it("compares intervals", () => {
    expect(sameInterval({ unit: "MONTH", count: 1 }, { unit: "MONTH", count: 1 })).toBe(true);
    expect(sameInterval({ unit: "MONTH", count: 1 }, { unit: "MONTH", count: 3 })).toBe(false);
    expect(sameInterval({ unit: "MONTH", count: 1 }, { unit: "YEAR", count: 1 })).toBe(false);
  });
});
