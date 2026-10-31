import { describe, expect, it } from "vitest";
import { PayPalSubscription } from "@keepwell/contracts";
import { pantryPlanSubscription } from "@keepwell/contracts/fakes";
import { fixtureSubscriptionId, pantryPlanFixture } from "./fixtures.js";

const NOW = new Date("2026-11-01T12:00:00Z");
const DAY_MS = 86_400_000;
const fixture = pantryPlanFixture(NOW);
const byKey = (key: string) => {
  const found = fixture.subscriptions.find((s) => s.id === fixtureSubscriptionId(key));
  if (!found) throw new Error(`no fixture for ${key}`);
  return found;
};
const daysFromNow = (iso: string | undefined) => (Date.parse(iso ?? "") - NOW.getTime()) / DAY_MS;

describe("Pantry Plan fixtures (CONTRACTS.md §6)", () => {
  it("has 12 subscribers, every one a valid PayPal subscription with a unique id", () => {
    expect(fixture.subscriptions).toHaveLength(12);
    expect(new Set(fixture.subscriptions.map((s) => s.id)).size).toBe(12);
    for (const s of fixture.subscriptions) expect(() => PayPalSubscription.parse(s)).not.toThrow();
  });

  it("shares Maya's ids with @keepwell/contracts/fakes", () => {
    const maya = byKey("maya");
    const fake = pantryPlanSubscription(NOW);
    expect(maya.id).toBe(fake.paypalSubscriptionId);
    expect(maya.plan_id).toBe(fake.paypalPlanId);
    expect(maya.status).toBe("ACTIVE");
    expect(daysFromNow(maya.billing_info?.next_billing_time)).toBe(20);
  });

  it("puts each named subscriber in the state their story needs", () => {
    expect(byKey("raj").billing_info).toMatchObject({
      failed_payments_count: 2,
      outstanding_balance: { value: "24.00", currency_code: "USD" },
      last_failed_payment: { reason_code: "PAYER_CANNOT_PAY" },
    });
    expect(byKey("ana").status).toBe("SUSPENDED");
    expect(byKey("tom").status).toBe("CANCELLED");
    expect(byKey("sara")).toMatchObject({ status: "APPROVAL_PENDING" });
    expect(byKey("sara").billing_info).toBeUndefined();
    expect(byKey("ben")).toMatchObject({ status: "SUSPENDED", billing_info: { failed_payments_count: 3 } });
    expect(byKey("diego").plan_overridden).toBe(true);
    expect(fixture.priceOverrides?.[byKey("diego").id]).toEqual({ currency_code: "USD", value: "9.00" });
    // Inside the 10-day window, and under the 60-day tenure: offers the policy must refuse.
    expect(daysFromNow(byKey("chloe").billing_info?.next_billing_time)).toBeLessThan(10);
    expect(daysFromNow(byKey("priya").start_time)).toBeGreaterThan(-60);
  });

  it("records one completed payment per paid cycle, with PayPal-length ids", () => {
    const maya = fixture.transactions.filter((t) => t.subscriptionId === byKey("maya").id);
    expect(maya).toHaveLength(8);
    expect(maya.at(-1)?.time).toBe(byKey("maya").billing_info?.last_payment?.time);
    // As sandbox sends it (spike Q1), so clients have to normalise.
    expect(byKey("maya").billing_info?.last_payment?.amount.value).toBe("12.0");
    for (const t of fixture.transactions) expect(t.id).toMatch(/^[A-Z0-9]{17}$/);
    expect(new Set(fixture.transactions.map((t) => t.id)).size).toBe(fixture.transactions.length);
  });
});
