import { PolicyDecision, PolicyDocument, type Offer } from "@keepwell/contracts";
import { describe, expect, it } from "vitest";
import { describeOffer, evaluate, explain } from "./evaluate.js";
import { computeMenu } from "./menu.js";
import { RULE } from "./rules.js";
import { pantryPlanPolicy } from "./defaults.js";
import { context, PLAN_IDS, policy, usd } from "./test-fixtures.js";

const ctx = context();
const menu = computeMenu(policy, ctx);
const rules = (d: PolicyDecision) => d.violations.map((v) => v.rule);

describe("evaluate", () => {
  it("allows every offer on the menu it was given", () => {
    for (const offer of menu.offers) {
      const decision = evaluate(policy, ctx, offer.id, menu);
      expect(decision).toMatchObject({ allowed: true, policyVersion: 1, offer, violations: [] });
      expect(decision.explanation.length).toBeGreaterThan(0);
      expect(PolicyDecision.parse(decision)).toEqual(decision);
    }
  });

  it("denies an id that isn't on the menu", () => {
    const decision = evaluate(policy, ctx, "year-free", menu);
    expect(decision).toMatchObject({ allowed: false, offer: null, explanation: [] });
    expect(rules(decision)).toEqual([RULE.offerNotInMenu]);
  });

  it("denies a menu from another policy version", () => {
    const decision = evaluate({ ...policy, version: 2 }, ctx, "pause-1", menu);
    expect(rules(decision)).toEqual([RULE.policyVersion]);
  });

  it("denies an offer whose terms were changed (prompt injection can't edit the menu)", () => {
    const tampered = (offers: Offer[]) => ({ ...menu, offers });
    const cheaper = menu.offers.map((o) =>
      o.kind === "discount" ? { ...o, percent: 90, newPrice: usd("1.20") } : o,
    );
    expect(rules(evaluate(policy, ctx, "discount-25", tampered(cheaper)))).toEqual([RULE.offerNotAllowedNow]);
    const longer = menu.offers.map((o) => (o.id === "pause-1" ? { ...o, cycles: 12 } : o));
    expect(rules(evaluate(policy, ctx, "pause-1", tampered(longer)))).toEqual([RULE.offerNotAllowedNow]);
    const invented: Offer = {
      id: "pause-12",
      kind: "pause",
      cycles: 12,
      resumesOn: "2027-11-28T10:00:00.000Z",
    };
    expect(rules(evaluate(policy, ctx, "pause-12", tampered([...menu.offers, invented])))).toEqual([
      RULE.offerNotAllowedNow,
    ]);
  });

  it("re-checks against the context at pick time", () => {
    expect(rules(evaluate(policy, context({ cancelIntent: true }), "pause-1", menu))).toEqual([
      RULE.cancelIntent,
    ]);
    expect(rules(evaluate(policy, context({ offersPresentedThisSession: 1 }), "pause-1", menu))).toEqual([
      RULE.oneOfferPerSession,
    ]);
    // The reason became known after the menu was computed, and it rules out a discount.
    expect(rules(evaluate(policy, context({ reason: "temporary" }), "discount-25", menu))).toEqual([
      RULE.reasonPreferences,
    ]);
    // Billing moved closer: the 10-day rule now blocks the discount.
    const soon = context({ subscription: { nextBillingTime: "2026-11-02T10:00:00Z" } });
    expect(rules(evaluate(policy, soon, "discount-25", menu))).toEqual([RULE.priceChangeTooSoon]);
  });

  it("reports every violation at once", () => {
    const decision = evaluate({ ...policy, version: 2 }, context({ cancelIntent: true }), "nope", menu);
    expect(rules(decision)).toEqual([RULE.policyVersion, RULE.offerNotInMenu, RULE.cancelIntent]);
  });
});

describe("explain", () => {
  it("says what was allowed and why", () => {
    const lines = explain(evaluate(policy, ctx, "pause-2", menu));
    expect(lines[0]).toBe("Allowed by policy v1: pause for 2 billing cycles, resuming 2027-01-28");
    expect(lines).toContain("Pause is enabled for up to 3 billing cycles");
    expect(lines.at(-1)).toBe(`The subscriber's reason is "unknown"; 0 earlier saves in 365 days`);
  });

  it("says what was denied and by which rule", () => {
    expect(explain(evaluate(policy, context({ cancelIntent: true }), "pause-1", menu))).toEqual([
      "Denied by policy v1",
      "The subscriber asked to cancel, so nothing is offered (builtin.cancel_intent)",
    ]);
  });

  it("describes every offer kind", () => {
    expect(menu.offers.map(describeOffer)).toEqual([
      "pause for 1 billing cycle, resuming 2026-12-28",
      "pause for 2 billing cycles, resuming 2027-01-28",
      "pause for 3 billing cycles, resuming 2027-02-28",
      "downgrade to Lite at 6.00 USD",
      "switch to annual at 120.00 USD (10.00 USD a month)",
      "25% off for 3 billing cycles (9.00 USD) from 2026-11-28",
      "refund 6.00 USD of the payment on 2026-10-28",
    ]);
  });
});

describe("pantryPlanPolicy", () => {
  it("is a valid policy document wired to the given plan ids", () => {
    const doc = pantryPlanPolicy(PLAN_IDS);
    expect(PolicyDocument.parse(doc)).toEqual(doc);
    expect(doc.offers.downgrade.targets).toEqual({ "P-STANDARD": ["P-LITE"] });
    expect(doc.offers.switch_annual.targets).toEqual({ "P-STANDARD": "P-ANNUAL" });
  });
});
