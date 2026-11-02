import type { PlanInfo, PolicyDraft } from "@keepwell/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { plans, policy, usd, withOffers } from "./test-fixtures.js";
import { validatePolicy } from "./validate.js";

const draftOf = ({ version: _version, ...rest }: typeof policy): PolicyDraft => rest;
const paths = (draft: PolicyDraft, catalogue: readonly PlanInfo[] = plans) =>
  validatePolicy(draft, catalogue).map((p) => p.path);

describe("validatePolicy", () => {
  it("accepts Pantry Plan's policy", () => {
    expect(validatePolicy(draftOf(policy), plans)).toEqual([]);
  });

  it("names each bad downgrade target by its path", () => {
    const draft = draftOf(
      withOffers({
        downgrade: {
          enabled: true,
          targets: {
            "P-STANDARD": ["P-GONE", "P-STANDARD", "P-ANNUAL", "P-LITE"],
            "P-LITE": ["P-STANDARD"],
            "P-NOPE": ["P-LITE"],
          },
        },
      }),
    );
    const problems = validatePolicy(draft, plans);
    expect(problems).toEqual([
      { path: "offers.downgrade.targets.P-STANDARD.0", message: "P-GONE isn't one of your plans" },
      { path: "offers.downgrade.targets.P-STANDARD.1", message: "Standard can't move down to itself" },
      {
        path: "offers.downgrade.targets.P-STANDARD.2",
        message: "Standard Annual must bill in the same currency and interval as Standard",
      },
      { path: "offers.downgrade.targets.P-LITE.0", message: "Standard isn't cheaper than Lite" },
      { path: "offers.downgrade.targets.P-NOPE", message: "P-NOPE isn't one of your plans" },
    ]);
  });

  it("checks currency on downgrades", () => {
    const euro = [
      ...plans,
      {
        planId: "P-EURO",
        name: "Euro",
        price: { value: "5.00", currency: "EUR" },
        interval: plans[0].interval,
      },
    ];
    const draft = draftOf(
      withOffers({ downgrade: { enabled: true, targets: { "P-STANDARD": ["P-EURO"] } } }),
    );
    expect(paths(draft, euro)).toEqual(["offers.downgrade.targets.P-STANDARD.0"]);
  });

  it("checks annual switches", () => {
    const pricey = {
      planId: "P-PRICEY",
      name: "Pricey",
      price: usd("200.00"),
      interval: { unit: "YEAR", count: 1 },
    } as const;
    const inr = {
      planId: "P-INR",
      name: "Rupee",
      price: { value: "999.00", currency: "INR" },
      interval: { unit: "YEAR", count: 1 },
    } as const;
    const catalogue = [...plans, pricey, inr];
    const draft = draftOf(
      withOffers({
        switch_annual: {
          enabled: true,
          targets: {
            "P-GONE": "P-ANNUAL",
            "P-LITE": "P-GONE",
            "P-ANNUAL": "P-ANNUAL",
            "P-STANDARD": "P-LITE",
          },
        },
      }),
    );
    expect(validatePolicy(draft, catalogue).map((p) => p.message)).toEqual([
      "P-GONE isn't one of your plans",
      "P-GONE isn't one of your plans",
      "Standard Annual isn't billed monthly",
      "Lite isn't billed yearly",
    ]);
    const currency = draftOf(
      withOffers({ switch_annual: { enabled: true, targets: { "P-STANDARD": "P-INR" } } }),
    );
    expect(validatePolicy(currency, catalogue)[0]?.message).toBe(
      "Rupee bills in a different currency from Standard",
    );
    const notCheaper = draftOf(
      withOffers({ switch_annual: { enabled: true, targets: { "P-STANDARD": "P-PRICEY" } } }),
    );
    expect(validatePolicy(notCheaper, catalogue)[0]?.message).toBe(
      "Pricey isn't cheaper per month than Standard",
    );
  });

  it("checks the refund cap's currency", () => {
    const draft = draftOf(
      withOffers({ refund_partial: { enabled: true, maxPerMonth: { value: "50.00", currency: "EUR" } } }),
    );
    expect(validatePolicy(draft, plans)).toEqual([
      { path: "offers.refund_partial.maxPerMonth", message: "None of your plans bill in EUR" },
    ]);
  });

  it("ignores offers that are switched off", () => {
    const draft = draftOf(
      withOffers({
        downgrade: { enabled: false, targets: { "P-GONE": ["P-GONE"] } },
        switch_annual: { enabled: false, targets: { "P-GONE": "P-GONE" } },
        refund_partial: { enabled: false, maxPerMonth: { value: "1.00", currency: "JPY" } },
      }),
    );
    expect(validatePolicy(draft, plans)).toEqual([]);
  });
});

describe("validatePolicy properties", () => {
  const RUNS = { numRuns: 1000 };
  const currency = fc.constantFrom("USD", "EUR");
  const interval = fc.constantFrom({ unit: "MONTH", count: 1 } as const, { unit: "YEAR", count: 1 } as const);
  const catalogue = fc.uniqueArray(
    fc.record({
      planId: fc.constantFrom("P-A", "P-B", "P-C", "P-D", "P-E"),
      name: fc.constant("Plan"),
      price: fc.tuple(fc.integer({ min: 0, max: 30_000 }), currency).map(([c, cur]) => ({
        value: (c / 100).toFixed(2),
        currency: cur,
      })),
      interval,
    }),
    { selector: (p) => p.planId, minLength: 1, maxLength: 5 },
  );

  it("never throws, and every problem points into the offers it checks", () => {
    const ids = fc.constantFrom("P-A", "P-B", "P-C", "P-D", "P-E", "P-X");
    fc.assert(
      fc.property(
        catalogue,
        fc.dictionary(ids, fc.array(ids, { maxLength: 3 })),
        fc.dictionary(ids, ids),
        fc.boolean(),
        (cat, down, annual, enabled) => {
          const draft = draftOf(
            withOffers({
              downgrade: { enabled, targets: down },
              switch_annual: { enabled, targets: annual },
            }),
          );
          for (const p of validatePolicy(draft, cat)) {
            expect(p.path).toMatch(/^offers\.(downgrade|switch_annual|refund_partial)\./);
            expect(p.message.length).toBeGreaterThan(0);
          }
        },
      ),
      RUNS,
    );
  });

  it("accepts every target the catalogue makes valid", () => {
    fc.assert(
      fc.property(catalogue, (cat) => {
        const cents = (p: PlanInfo) => Math.round(Number(p.price.value) * 100);
        const same = (a: PlanInfo, b: PlanInfo) =>
          a.price.currency === b.price.currency && a.interval.unit === b.interval.unit;
        const down = Object.fromEntries(
          cat.map((from) => [
            from.planId,
            cat.filter((to) => same(from, to) && cents(to) < cents(from)).map((t) => t.planId),
          ]),
        );
        const annual = Object.fromEntries(
          cat.flatMap((from) => {
            if (from.interval.unit !== "MONTH") return [];
            const to = cat.find(
              (t) =>
                t.interval.unit === "YEAR" &&
                t.price.currency === from.price.currency &&
                Math.floor(cents(t) / 12) < cents(from),
            );
            return to ? [[from.planId, to.planId]] : [];
          }),
        );
        const refundCurrency = cat[0]?.price.currency ?? "USD";
        const draft = draftOf(
          withOffers({
            downgrade: { enabled: true, targets: down },
            switch_annual: { enabled: true, targets: annual },
            refund_partial: { enabled: true, maxPerMonth: { value: "10.00", currency: refundCurrency } },
          }),
        );
        expect(validatePolicy(draft, cat)).toEqual([]);
      }),
      RUNS,
    );
  });
});
