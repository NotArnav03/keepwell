import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money } from "@keepwell/contracts";
import {
  DeterministicEstimateProvider,
  estimateCreatePlan,
  fromCents,
  toCents,
  type EstimateInputs,
  type PlanFootprint,
} from "./estimate.js";

const monthly = { unit: "MONTH", count: 1 } as const;
const usd = (value: string) => ({ value, currency: "USD" });
const standard: PlanFootprint = {
  planName: "Standard",
  activeSubscribers: 40,
  price: usd("10.00"),
  interval: monthly,
};

describe("estimateCreatePlan", () => {
  it("works the Basics $4 example out from its inputs", () => {
    const { estimate, basis } = estimateCreatePlan({
      price: usd("4.00"),
      interval: monthly,
      priceCancellations: 23,
      lookbackDays: 30,
      plans: [standard],
    });
    // 23 × 30% × $4.00 = $27.60; 40 × 10% × $6.00 = $24.00.
    expect(estimate?.monthlyRevenueImpact).toEqual(usd("3.60"));
    expect(estimate?.basis).toBe(basis);
    expect(basis).toContain(
      "23 price-reason cancellations in 30 days × 30% capture × $4.00 per month = $27.60",
    );
    expect(basis).toContain("40 subscribers on Standard × 10% downgrading × $6.00 saved = $24.00");
    expect(basis).toContain("net $3.60 per month");
  });

  it("is the gain alone when nobody is on a pricier plan", () => {
    const { estimate } = estimateCreatePlan({
      price: usd("4.00"),
      interval: monthly,
      priceCancellations: 23,
      lookbackDays: 30,
      plans: [],
    });
    expect(estimate?.monthlyRevenueImpact).toEqual(usd("27.60"));
  });

  it("returns null with a clear basis when no one left over price", () => {
    const result = estimateCreatePlan({
      price: usd("4.00"),
      interval: monthly,
      priceCancellations: 0,
      lookbackDays: 30,
      plans: [standard],
    });
    expect(result.estimate).toBeNull();
    expect(result.basis).toMatch(/no cancellations citing price in the last 30 days/i);
  });

  it("shows a net loss as 0.00 and says how big it is", () => {
    const { estimate } = estimateCreatePlan({
      price: usd("4.00"),
      interval: monthly,
      priceCancellations: 1,
      lookbackDays: 30,
      plans: [{ ...standard, activeSubscribers: 400 }],
    });
    expect(estimate?.monthlyRevenueImpact).toEqual(usd("0.00"));
    expect(estimate?.basis).toMatch(/net a loss of \$238\.80 per month, shown as \$0\.00/);
  });

  it("ignores plans that are not pricier, other currencies and empty plans", () => {
    const { estimate } = estimateCreatePlan({
      price: usd("4.00"),
      interval: monthly,
      priceCancellations: 10,
      lookbackDays: 30,
      plans: [
        { ...standard, price: usd("4.00") },
        { ...standard, price: usd("3.00") },
        { ...standard, price: { value: "10.00", currency: "EUR" } },
        { ...standard, activeSubscribers: 0 },
      ],
    });
    expect(estimate?.monthlyRevenueImpact).toEqual(usd("12.00"));
  });

  it("compares plans by their monthly equivalent", () => {
    // $48/year is $4/month: not pricier than the new $4 monthly plan, so no cannibalisation.
    const yearly = { ...standard, price: usd("48.00"), interval: { unit: "YEAR", count: 1 } as const };
    const { estimate } = estimateCreatePlan({
      price: usd("4.00"),
      interval: monthly,
      priceCancellations: 10,
      lookbackDays: 30,
      plans: [yearly],
    });
    expect(estimate?.monthlyRevenueImpact).toEqual(usd("12.00"));
  });

  it("converts a new yearly plan to a monthly figure", () => {
    const { estimate } = estimateCreatePlan({
      price: usd("120.00"),
      interval: { unit: "YEAR", count: 1 },
      priceCancellations: 10,
      lookbackDays: 30,
      plans: [],
    });
    // 10 × 30% × $10.00/month.
    expect(estimate?.monthlyRevenueImpact).toEqual(usd("30.00"));
  });

  it("scales a longer lookback down to 30 days", () => {
    const { estimate } = estimateCreatePlan({
      price: usd("4.00"),
      interval: monthly,
      priceCancellations: 60,
      lookbackDays: 60,
      plans: [],
    });
    expect(estimate?.monthlyRevenueImpact).toEqual(usd("36.00"));
  });

  it("rounds halves up, once, at the end", () => {
    // 1 × 30% × $0.05 = 1.5 cents -> 2 cents.
    const { estimate } = estimateCreatePlan({
      price: usd("0.05"),
      interval: monthly,
      priceCancellations: 1,
      lookbackDays: 30,
      plans: [],
    });
    expect(estimate?.monthlyRevenueImpact).toEqual(usd("0.02"));
  });

  it("uses the assumptions it is given and writes them into the basis", () => {
    const { estimate } = estimateCreatePlan({
      price: usd("4.00"),
      interval: monthly,
      priceCancellations: 10,
      lookbackDays: 30,
      plans: [],
      assumptions: { captureRateBp: 1250, downgradeRateBp: 1000 },
    });
    expect(estimate?.monthlyRevenueImpact).toEqual(usd("5.00"));
    expect(estimate?.basis).toContain("12.50% capture");
  });

  it("singular wording for one cancellation", () => {
    const { basis } = estimateCreatePlan({
      price: usd("4.00"),
      interval: monthly,
      priceCancellations: 1,
      lookbackDays: 30,
      plans: [],
    });
    expect(basis).toContain("1 price-reason cancellation in 30 days");
  });

  describe("properties", () => {
    const cents = fc.integer({ min: 1, max: 1_000_000 });
    const planArb = fc.record({
      planName: fc.constant("Plan"),
      activeSubscribers: fc.integer({ min: 0, max: 5000 }),
      price: cents.map((c) => fromCents(BigInt(c), "USD")),
      interval: fc.record({
        unit: fc.constantFrom("DAY", "WEEK", "MONTH", "YEAR"),
        count: fc.integer({ min: 1, max: 12 }),
      }),
    });

    it("always returns valid Money: a decimal string, never negative, no float artefacts", () => {
      fc.assert(
        fc.property(
          cents,
          fc.integer({ min: 1, max: 10_000 }),
          fc.integer({ min: 1, max: 365 }),
          fc.array(planArb, { maxLength: 5 }),
          (price, cancellations, lookbackDays, plans) => {
            const { estimate } = estimateCreatePlan({
              price: fromCents(BigInt(price), "USD"),
              interval: monthly,
              priceCancellations: cancellations,
              lookbackDays,
              plans,
            });
            expect(estimate).not.toBeNull();
            expect(Money.safeParse(estimate?.monthlyRevenueImpact).success).toBe(true);
          },
        ),
      );
    });

    it("with no cannibalisation, more cancellations never lowers the estimate", () => {
      fc.assert(
        fc.property(
          cents,
          fc.integer({ min: 1, max: 5000 }),
          fc.integer({ min: 0, max: 5000 }),
          (price, n, extra) => {
            const impact = (count: number) =>
              toCents(
                estimateCreatePlan({
                  price: fromCents(BigInt(price), "USD"),
                  interval: monthly,
                  priceCancellations: count,
                  lookbackDays: 30,
                  plans: [],
                }).estimate?.monthlyRevenueImpact ?? usd("0.00"),
              );
            expect(impact(n + extra)).toBeGreaterThanOrEqual(impact(n));
          },
        ),
      );
    });

    it("a gain-only estimate stays within one cent of the exact 30% × count × price", () => {
      fc.assert(
        fc.property(cents, fc.integer({ min: 1, max: 5000 }), (price, n) => {
          const got = toCents(
            estimateCreatePlan({
              price: fromCents(BigInt(price), "USD"),
              interval: monthly,
              priceCancellations: n,
              lookbackDays: 30,
              plans: [],
            }).estimate?.monthlyRevenueImpact ?? usd("0.00"),
          );
          const exact = (BigInt(n) * 3n * BigInt(price)) / 10n;
          const diff = got > exact ? got - exact : exact - got;
          expect(diff <= 1n).toBe(true);
        }),
      );
    });

    it("cents round-trip through money strings", () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 100_000_000 }), (c) => {
          expect(toCents(fromCents(BigInt(c), "USD"))).toBe(BigInt(c));
        }),
      );
    });
  });
});

describe("DeterministicEstimateProvider", () => {
  const inputs = (cancellations: number): EstimateInputs & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      priceCancellations(merchantId, days) {
        calls.push(`cancellations:${merchantId}:${days}`);
        return Promise.resolve(cancellations);
      },
      planFootprints(merchantId, currency) {
        calls.push(`plans:${merchantId}:${currency}`);
        return Promise.resolve([standard]);
      },
    };
  };
  const proposal = {
    kind: "create_plan",
    params: {
      name: "Basics",
      description: null,
      price: usd("4.00"),
      interval: monthly,
      basedOnPaypalPlanId: "P-1",
    },
  } as const;

  it("reads the merchant's own aggregates for a create_plan", async () => {
    const source = inputs(23);
    const result = await new DeterministicEstimateProvider(source).estimate("m-1", proposal);
    expect(result.estimate?.monthlyRevenueImpact).toEqual(usd("3.60"));
    expect(source.calls).toEqual(["cancellations:m-1:30", "plans:m-1:USD"]);
  });

  it("gives other kinds no estimate and says so", async () => {
    const result = await new DeterministicEstimateProvider(inputs(23)).estimate("m-1", {
      kind: "send_winback_batch",
      params: { subscriptionIds: ["0199a1b2-c3d4-7e5f-8a6b-000000000001"], reason: "price" },
    });
    expect(result.estimate).toBeNull();
    expect(result.basis).toContain("send_winback_batch");
  });
});
