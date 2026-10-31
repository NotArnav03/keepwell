import { describe, expect, it } from "vitest";
import { recoveryConfigFromEnv } from "./config.js";
import { isPositive, messageDueAt, selectPlaybook } from "./playbooks.js";
import { rowsToRevenue } from "./revenue.js";

describe("playbook helpers", () => {
  it("maps reason codes", () => {
    expect(selectPlaybook("INTERNAL_SERVER_ERROR")).toBe("wait_for_retry");
    expect(selectPlaybook("")).toBe("generic");
  });

  it("messageDueAt is 24h before, never in the past, and now without a retry date", () => {
    const now = new Date("2026-11-01T12:00:00.000Z");
    expect(messageDueAt("2026-11-05T12:00:00.000Z", now)).toBe("2026-11-04T12:00:00.000Z");
    expect(messageDueAt("2026-11-02T00:00:00.000Z", now)).toBe(now.toISOString());
    expect(messageDueAt(null, now)).toBe(now.toISOString());
  });

  it("isPositive compares decimal strings exactly", () => {
    expect(isPositive("0.00")).toBe(false);
    expect(isPositive("0.01")).toBe(true);
  });
});

describe("recovered revenue rows", () => {
  it("keeps decimal strings per currency and drops empty rows", () => {
    expect(
      rowsToRevenue([
        { currency: "USD", total: "36.00", cases: 3 },
        { currency: "EUR", total: "0.10", cases: 1 },
        { currency: null, total: null, cases: 0 },
      ]),
    ).toEqual([
      { total: { value: "36.00", currency: "USD" }, cases: 3 },
      { total: { value: "0.10", currency: "EUR" }, cases: 1 },
    ]);
  });
});

describe("config", () => {
  it("defaults to the local portal and sandbox PayPal, and reads PORTAL_URL", () => {
    expect(recoveryConfigFromEnv({})).toEqual({
      portalUrl: "http://localhost:5174",
      paypalWebUrl: "https://www.sandbox.paypal.com",
    });
    expect(recoveryConfigFromEnv({ PORTAL_URL: "https://portal.example/" }).portalUrl).toBe(
      "https://portal.example",
    );
  });
});
