import { OfferMenu, PolicyDocument, type ReasonCategory } from "@keepwell/contracts";
import { describe, expect, it } from "vitest";
import { analyse, computeMenu, rankedKinds } from "./menu.js";
import { RULE } from "./rules.js";
import { context, NOW, plans, policy, usd, withOffers } from "./test-fixtures.js";

const ids = (menu: OfferMenu) => menu.offers.map((o) => o.id);
const excludedBecause = (menu: OfferMenu, kind: string) =>
  menu.excluded.find((e) => e.kind === kind)?.because;
/** The rule that excluded `kind`. */
const ruleFor = (doc: PolicyDocument, ctx: ReturnType<typeof context>, kind: string) =>
  analyse(doc, ctx).exclusions.find((e) => e.kind === kind)?.rule;

describe("computeMenu for Maya (Pantry Plan default policy)", () => {
  const menu = computeMenu(policy, context());

  it("offers every kind, concretely priced and dated", () => {
    expect(menu.offers).toEqual([
      { id: "pause-1", kind: "pause", cycles: 1, resumesOn: "2026-12-28T10:00:00.000Z" },
      { id: "pause-2", kind: "pause", cycles: 2, resumesOn: "2027-01-28T10:00:00.000Z" },
      { id: "pause-3", kind: "pause", cycles: 3, resumesOn: "2027-02-28T10:00:00.000Z" },
      {
        id: "downgrade-P-LITE",
        kind: "downgrade",
        toPlanId: "P-LITE",
        toPlanName: "Lite",
        newPrice: usd("6.00"),
      },
      {
        id: "switch_annual-P-ANNUAL",
        kind: "switch_annual",
        toPlanId: "P-ANNUAL",
        newPrice: usd("120.00"),
        effectiveMonthly: usd("10.00"),
      },
      {
        id: "discount-25",
        kind: "discount",
        percent: 25,
        cycles: 3,
        newPrice: usd("9.00"),
        firstAffectedBilling: "2026-11-28T10:00:00Z",
      },
      {
        id: "refund_partial",
        kind: "refund_partial",
        amount: usd("6.00"),
        ofPaymentOn: "2026-10-28T10:00:00Z",
      },
    ]);
    expect(menu.excluded).toEqual([]);
    expect(menu.policyVersion).toBe(1);
    expect(menu.computedAt).toBe(NOW);
  });

  it("gives an L1 default per reason, and none for a missing feature", () => {
    expect(menu.defaultByReason).toEqual({
      price: "downgrade-P-LITE",
      low_usage: "pause-1",
      missing_feature: null,
      quality_issue: "refund_partial",
      temporary: "pause-1",
      switching_competitor: "discount-25",
      payment_problem: "pause-1",
      other: "pause-1",
      unknown: "pause-1",
    });
  });

  it("is a valid OfferMenu and deterministic", () => {
    expect(OfferMenu.parse(menu)).toEqual(menu);
    expect(computeMenu(policy, context())).toEqual(menu);
  });
});

describe("built-in gates empty the whole menu", () => {
  const cases: [string, ReturnType<typeof context>, string][] = [
    ["cancel intent", context({ cancelIntent: true }), RULE.cancelIntent],
    ["an offer already shown", context({ offersPresentedThisSession: 1 }), RULE.oneOfferPerSession],
    ["a suspended subscription", context({ subscription: { status: "SUSPENDED" } }), RULE.notActive],
    ["a cancelled subscription", context({ subscription: { status: "CANCELLED" } }), RULE.notActive],
    ["too many saves this year", context({ history: { savesLast365d: 2 } }), RULE.maxSaves],
  ];

  it.each(cases)("%s", (_name, ctx, rule) => {
    const analysis = analyse(policy, ctx);
    expect(analysis.menu.offers).toEqual([]);
    expect(analysis.gate?.rule).toBe(rule);
    expect(analysis.menu.excluded).toHaveLength(5);
    expect(Object.values(analysis.menu.defaultByReason).every((id) => id === null)).toBe(true);
  });

  it("cancel intent wins over every other gate", () => {
    const ctx = context({
      cancelIntent: true,
      offersPresentedThisSession: 1,
      subscription: { status: "SUSPENDED" },
    });
    expect(analyse(policy, ctx).gate?.rule).toBe(RULE.cancelIntent);
  });

  it("a policy allowing zero saves never offers anything", () => {
    const doc = { ...policy, eligibility: { ...policy.eligibility, maxSavesPerSubscriberPer365d: 0 } };
    expect(computeMenu(doc, context()).offers).toEqual([]);
  });
});

describe("pause", () => {
  it("offers 1–3 cycles plus the policy's maximum, sorted", () => {
    expect(
      ids(computeMenu(withOffers({ pause: { maxCycles: 6 } }), context({ reason: "temporary" }))),
    ).toEqual(["pause-1", "pause-2", "pause-3", "pause-6"]);
    expect(
      ids(computeMenu(withOffers({ pause: { maxCycles: 1 } }), context({ reason: "temporary" }))),
    ).toEqual(["pause-1"]);
  });

  it("resumes after the skipped renewals of a weekly plan", () => {
    const ctx = context({ reason: "temporary", subscription: { interval: { unit: "WEEK", count: 1 } } });
    expect(computeMenu(policy, ctx).offers[1]).toMatchObject({
      cycles: 2,
      resumesOn: "2026-12-12T10:00:00.000Z",
    });
  });

  it("is excluded when disabled, without a next billing date, or inside the cooldown", () => {
    expect(ruleFor(withOffers({ pause: { enabled: false } }), context(), "pause")).toBe(RULE.disabled);
    expect(ruleFor(policy, context({ subscription: { nextBillingTime: null } }), "pause")).toBe(
      RULE.noNextBilling,
    );
    const recent = context({ history: { lastPauseEndedAt: "2026-09-01T10:00:00Z" } });
    expect(ruleFor(policy, recent, "pause")).toBe(RULE.pauseCooldown);
    expect(excludedBecause(computeMenu(policy, recent), "pause")).toBe(
      "The last pause ended less than 90 days ago",
    );
  });

  it("is offered again once the cooldown has passed", () => {
    const ctx = context({ history: { lastPauseEndedAt: "2026-07-31T10:00:00Z" } }); // exactly 90 days
    expect(ids(computeMenu(policy, ctx))).toContain("pause-1");
  });
});

describe("downgrade", () => {
  it("is excluded when disabled or when no target is set up for the plan", () => {
    expect(ruleFor(withOffers({ downgrade: { enabled: false } }), context(), "downgrade")).toBe(
      RULE.disabled,
    );
    expect(ruleFor(withOffers({ downgrade: { targets: {} } }), context(), "downgrade")).toBe(RULE.noTarget);
  });

  it("skips targets that are unknown, not cheaper, in another currency or another interval", () => {
    const targets = { "P-STANDARD": ["P-GONE", "P-PRICIER", "P-EUR", "P-YEARLY-LITE", "P-LITE", "P-LITE"] };
    const ctx = context({
      plans: [
        ...plans,
        { planId: "P-PRICIER", name: "Plus", price: usd("15.00"), interval: { unit: "MONTH", count: 1 } },
        {
          planId: "P-EUR",
          name: "Lite EU",
          price: { value: "5.00", currency: "EUR" },
          interval: { unit: "MONTH", count: 1 },
        },
        {
          planId: "P-YEARLY-LITE",
          name: "Lite yearly",
          price: usd("60.00"),
          interval: { unit: "YEAR", count: 1 },
        },
      ],
    });
    expect(
      ids(computeMenu(withOffers({ downgrade: { targets } }), ctx)).filter((id) =>
        id.startsWith("downgrade"),
      ),
    ).toEqual(["downgrade-P-LITE"]);
  });

  it("is excluded when no target is cheaper than what the subscriber pays now", () => {
    const ctx = context({ subscription: { priceOverride: usd("5.00") } });
    expect(ruleFor(policy, ctx, "downgrade")).toBe(RULE.notCheaper);
  });
});

describe("switch_annual", () => {
  it("is excluded when disabled or not set up for the plan", () => {
    expect(ruleFor(withOffers({ switch_annual: { enabled: false } }), context(), "switch_annual")).toBe(
      RULE.disabled,
    );
    expect(ruleFor(withOffers({ switch_annual: { targets: {} } }), context(), "switch_annual")).toBe(
      RULE.noTarget,
    );
  });

  it("needs a monthly subscription and a 1-year target in the same currency", () => {
    const weekly = context({ subscription: { interval: { unit: "WEEK", count: 1 } } });
    expect(ruleFor(policy, weekly, "switch_annual")).toBe(RULE.badTarget);
    const missing = context({ plans: plans.filter((p) => p.planId !== "P-ANNUAL") });
    expect(ruleFor(policy, missing, "switch_annual")).toBe(RULE.badTarget);
    const eur = context({
      plans: [...plans.slice(0, 2), { ...plans[2], price: { value: "120.00", currency: "EUR" } }],
    });
    expect(ruleFor(policy, eur, "switch_annual")).toBe(RULE.badTarget);
    const twoYears = context({
      plans: [...plans.slice(0, 2), { ...plans[2], interval: { unit: "YEAR", count: 2 } }],
    });
    expect(ruleFor(policy, twoYears, "switch_annual")).toBe(RULE.badTarget);
  });

  it("is excluded when it isn't cheaper per month", () => {
    const ctx = context({ plans: [...plans.slice(0, 2), { ...plans[2], price: usd("144.00") }] });
    expect(ruleFor(policy, ctx, "switch_annual")).toBe(RULE.notCheaper);
  });

  it("rounds the monthly equivalent down to the cent", () => {
    const ctx = context({ plans: [...plans.slice(0, 2), { ...plans[2], price: usd("100.00") }] });
    expect(computeMenu(policy, ctx).offers.find((o) => o.kind === "switch_annual")).toMatchObject({
      effectiveMonthly: usd("8.33"),
    });
  });
});

describe("discount", () => {
  it("is excluded when disabled, too early in the subscription, or already discounted", () => {
    expect(ruleFor(withOffers({ discount: { enabled: false } }), context(), "discount")).toBe(RULE.disabled);
    expect(
      ruleFor(policy, context({ subscription: { startedAt: "2026-09-15T10:00:00Z" } }), "discount"),
    ).toBe(RULE.minTenure);
    expect(ruleFor(policy, context({ subscription: { priceOverride: usd("9.00") } }), "discount")).toBe(
      RULE.alreadyDiscounted,
    );
  });

  it("applies the 10-day rule: under 10 days to next billing means no price change", () => {
    const at = (days: number) =>
      context({
        subscription: { nextBillingTime: new Date(Date.parse(NOW) + days * 86_400_000).toISOString() },
      });
    expect(ruleFor(policy, at(9.99), "discount")).toBe(RULE.priceChangeTooSoon);
    expect(ids(computeMenu(policy, at(10)))).toContain("discount-25");
    expect(ruleFor(policy, context({ subscription: { nextBillingTime: null } }), "discount")).toBe(
      RULE.priceChangeTooSoon,
    );
  });

  it("offers a partial refund instead when the 10-day rule blocks the discount", () => {
    const ctx = context({ reason: "unknown", subscription: { nextBillingTime: "2026-11-02T10:00:00Z" } });
    const kinds = computeMenu(policy, ctx).offers.map((o) => o.kind);
    expect(kinds).not.toContain("discount");
    expect(kinds).toContain("refund_partial");
  });

  it("rounds the new price down, never up", () => {
    const ctx = context({ subscription: { price: usd("9.99") } });
    expect(
      computeMenu(withOffers({ discount: { maxPercent: 15 } }), ctx).offers.find(
        (o) => o.kind === "discount",
      ),
    ).toMatchObject({
      newPrice: usd("8.49"), // 9.99 × 0.85 = 8.4915
    });
  });

  it("never offers a 0.00 price", () => {
    expect(ruleFor(withOffers({ discount: { maxPercent: 100 } }), context(), "discount")).toBe(
      RULE.zeroPrice,
    );
  });
});

describe("refund_partial", () => {
  const refund = (doc: PolicyDocument, ctx: ReturnType<typeof context>) =>
    computeMenu(doc, ctx).offers.find((o) => o.kind === "refund_partial");

  it("is excluded when disabled, with no payment, or with a payment over 180 days old", () => {
    expect(ruleFor(withOffers({ refund_partial: { enabled: false } }), context(), "refund_partial")).toBe(
      RULE.disabled,
    );
    expect(ruleFor(policy, context({ subscription: { lastPayment: null } }), "refund_partial")).toBe(
      RULE.noPayment,
    );
    const old = context({
      subscription: { lastPayment: { amount: usd("12.00"), time: "2026-04-01T10:00:00Z" } },
    });
    expect(ruleFor(policy, old, "refund_partial")).toBe(RULE.refundTooOld);
  });

  it("is excluded when any amount is in another currency", () => {
    const eur = { value: "12.00", currency: "EUR" };
    expect(
      ruleFor(
        policy,
        context({ subscription: { lastPayment: { amount: eur, time: NOW } } }),
        "refund_partial",
      ),
    ).toBe(RULE.currencyMismatch);
    expect(ruleFor(withOffers({ refund_partial: { maxPerMonth: eur } }), context(), "refund_partial")).toBe(
      RULE.currencyMismatch,
    );
    expect(
      ruleFor(
        policy,
        context({ history: { refundedLast30d: { value: "0.00", currency: "EUR" } } }),
        "refund_partial",
      ),
    ).toBe(RULE.currencyMismatch);
  });

  it("is capped by the percentage, what's left of the monthly limit, and the plan price", () => {
    expect(refund(policy, context({ history: { refundedLast30d: usd("9.00") } }))).toMatchObject({
      amount: usd("3.00"),
    });
    const bigPayment = context({ subscription: { lastPayment: { amount: usd("40.00"), time: NOW } } });
    expect(
      refund(
        withOffers({ refund_partial: { maxPercentOfLastPayment: 100, maxPerMonth: usd("100.00") } }),
        bigPayment,
      ),
    ).toMatchObject({
      amount: usd("12.00"),
    });
  });

  it("is excluded once the monthly limit is used up", () => {
    expect(ruleFor(policy, context({ history: { refundedLast30d: usd("12.00") } }), "refund_partial")).toBe(
      RULE.refundMonthlyCap,
    );
  });
});

describe("reason preferences", () => {
  it("only offers the kinds ranked for the reason, best first", () => {
    const menu = computeMenu(policy, context({ reason: "price" }));
    expect(menu.offers.map((o) => o.kind)).toEqual([
      "downgrade",
      "switch_annual",
      "discount",
      "pause",
      "pause",
      "pause",
    ]);
    expect(excludedBecause(menu, "refund_partial")).toBe('Not offered when the reason is "price"');
  });

  it("offers nothing for a missing feature by default", () => {
    const menu = computeMenu(policy, context({ reason: "missing_feature" }));
    expect(menu.offers).toEqual([]);
    expect(menu.excluded).toHaveLength(5);
  });

  it("uses the merchant's ranking over the default, and stops at 'none'", () => {
    const doc = { ...policy, reasonPreferences: { price: ["discount", "none", "downgrade"] } } as const;
    expect(
      computeMenu(PolicyDocument.parse(doc), context({ reason: "price" })).offers.map((o) => o.kind),
    ).toEqual(["discount"]);
  });

  it("ranks each kind once and drops 'none'", () => {
    const doc = PolicyDocument.parse({
      ...policy,
      reasonPreferences: { other: ["pause", "pause", "discount"] },
    });
    expect(rankedKinds(doc, "other")).toEqual(["pause", "discount"]);
    expect(rankedKinds(policy, "missing_feature")).toEqual([]);
  });

  it("only points defaults at offers that are on the menu", () => {
    const reasons: ReasonCategory[] = ["price", "temporary", "quality_issue", "unknown"];
    for (const reason of reasons) {
      const menu = computeMenu(policy, context({ reason }));
      for (const id of Object.values(menu.defaultByReason)) {
        if (id !== null) expect(ids(menu)).toContain(id);
      }
    }
  });
});
