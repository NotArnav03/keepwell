import { describe, expect, it } from "vitest";
import { closingSummary } from "./summary.js";

describe("closingSummary", () => {
  it("writes the pause date like the offer card does, not as an ISO date", () => {
    const summary = closingSummary("saved_pause", {
      id: "pause-1",
      kind: "pause",
      cycles: 1,
      resumesOn: "2027-01-11T10:00:00.000Z",
    });
    expect(summary).toBe("Your subscription is paused. Billing restarts on January 11, 2027.");
  });

  it("shows the UTC calendar day even when the instant is late in the day", () => {
    const summary = closingSummary("saved_discount", {
      id: "discount-1",
      kind: "discount",
      percent: 20,
      cycles: 3,
      newPrice: { value: "9.60", currency: "USD" },
      firstAffectedBilling: "2026-12-31T23:30:00.000Z",
    });
    expect(summary).toBe("20% off applies from December 31, 2026.");
  });

  it("formats money from its decimal string with the currency symbol", () => {
    const summary = closingSummary("saved_downgrade", {
      id: "downgrade-1",
      kind: "downgrade",
      toPlanId: "P-LITE",
      toPlanName: "Lite",
      newPrice: { value: "8.00", currency: "USD" },
    });
    expect(summary).toBe("You're now on Lite at $8.00.");
  });
});
