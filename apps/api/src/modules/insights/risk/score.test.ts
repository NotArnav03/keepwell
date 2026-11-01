import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bandFor, RISK_BANDS, RISK_WEIGHTS as W, scoreChurnRisk, type ChurnSignals } from "./score.js";

// A calm, long-standing subscriber: scores zero, so each test switches on one signal.
const CALM: ChurnSignals = {
  status: "ACTIVE",
  failedPaymentsCount: 0,
  daysSinceLastFailure: null,
  outstandingValue: null,
  daysSinceLastPayment: 10,
  billingIntervalDays: 30,
  tenureDays: 400,
  priorPauses: 0,
  priorDowngrades: 0,
  priorDiscounts: 0,
  recentRevise: false,
  daysToNextBilling: 20,
};
const with_ = (patch: Partial<ChurnSignals>): ChurnSignals => ({ ...CALM, ...patch });
const points = (patch: Partial<ChurnSignals>, id: string): number =>
  scoreChurnRisk(with_(patch)).factors.find((f) => f.id === id)?.points ?? 0;

const signals = fc.record<ChurnSignals>({
  status: fc.constantFrom("ACTIVE", "SUSPENDED"),
  failedPaymentsCount: fc.integer({ min: 0, max: 12 }),
  daysSinceLastFailure: fc.option(fc.integer({ min: 0, max: 90 }), { nil: null }),
  outstandingValue: fc.option(fc.constantFrom("0.00", "5.00", "120.50"), { nil: null }),
  daysSinceLastPayment: fc.option(fc.integer({ min: 0, max: 400 }), { nil: null }),
  billingIntervalDays: fc.constantFrom(7, 30, 365),
  tenureDays: fc.integer({ min: 0, max: 1000 }),
  priorPauses: fc.integer({ min: 0, max: 5 }),
  priorDowngrades: fc.integer({ min: 0, max: 5 }),
  priorDiscounts: fc.integer({ min: 0, max: 5 }),
  recentRevise: fc.boolean(),
  daysToNextBilling: fc.option(fc.integer({ min: 0, max: 60 }), { nil: null }),
});

describe("scoreChurnRisk", () => {
  it("scores a calm long-standing subscriber at zero, low, with no factors", () => {
    expect(scoreChurnRisk(CALM)).toEqual({ score: 0, band: "low", factors: [] });
  });

  it("scores a brand-new subscription as early-life risk only, still low", () => {
    const r = scoreChurnRisk(with_({ tenureDays: 0, daysSinceLastPayment: null }));
    expect(r.score).toBe(W.tenureUnder30DaysPoints);
    expect(r.band).toBe("low");
    expect(r.factors.map((f) => f.id)).toEqual(["early_tenure"]);
  });

  it("handles the all-empty edge without NaN", () => {
    const r = scoreChurnRisk(
      with_({
        tenureDays: Number.NaN,
        failedPaymentsCount: -3,
        priorPauses: Number.NaN,
        billingIntervalDays: 0,
      }),
    );
    expect(Number.isInteger(r.score)).toBe(true);
  });

  describe("each signal on its own", () => {
    it("failed payments, capped", () => {
      expect(points({ failedPaymentsCount: 1 }, "failed_payments")).toBe(W.failedPaymentPoints);
      expect(points({ failedPaymentsCount: 2 }, "failed_payments")).toBe(2 * W.failedPaymentPoints);
      expect(points({ failedPaymentsCount: 9 }, "failed_payments")).toBe(
        W.failedPaymentCap * W.failedPaymentPoints,
      );
    });
    it("failure recency only counts when something failed", () => {
      expect(points({ daysSinceLastFailure: 2 }, "recent_failure")).toBe(0);
      expect(points({ failedPaymentsCount: 1, daysSinceLastFailure: 7 }, "recent_failure")).toBe(
        W.failureWithin7DaysPoints,
      );
      expect(points({ failedPaymentsCount: 1, daysSinceLastFailure: 8 }, "recent_failure")).toBe(
        W.failureWithin30DaysPoints,
      );
      expect(points({ failedPaymentsCount: 1, daysSinceLastFailure: 31 }, "recent_failure")).toBe(0);
    });
    it("outstanding balance", () => {
      expect(points({ outstandingValue: "12.00" }, "outstanding_balance")).toBe(W.outstandingBalancePoints);
      expect(points({ outstandingValue: "0.00" }, "outstanding_balance")).toBe(0);
      expect(points({ outstandingValue: null }, "outstanding_balance")).toBe(0);
    });
    it("overdue payment relative to the billing cycle", () => {
      expect(points({ daysSinceLastPayment: 37 }, "overdue_payment")).toBe(0);
      expect(points({ daysSinceLastPayment: 38 }, "overdue_payment")).toBe(W.overdue125Points);
      expect(points({ daysSinceLastPayment: 60 }, "overdue_payment")).toBe(W.overdue200Points);
      expect(points({ daysSinceLastPayment: 60, billingIntervalDays: 365 }, "overdue_payment")).toBe(0);
    });
    it("tenure tiers", () => {
      expect(points({ tenureDays: 29 }, "early_tenure")).toBe(W.tenureUnder30DaysPoints);
      expect(points({ tenureDays: 30 }, "early_tenure")).toBe(W.tenureUnder90DaysPoints);
      expect(points({ tenureDays: 90 }, "early_tenure")).toBe(W.tenureUnder180DaysPoints);
      expect(points({ tenureDays: 180 }, "early_tenure")).toBe(0);
    });
    it("prior saves, each capped", () => {
      expect(points({ priorPauses: 1 }, "prior_pauses")).toBe(W.priorPausePoints);
      expect(points({ priorPauses: 5 }, "prior_pauses")).toBe(W.priorSaveCap * W.priorPausePoints);
      expect(points({ priorDowngrades: 1 }, "prior_downgrades")).toBe(W.priorDowngradePoints);
      expect(points({ priorDiscounts: 9 }, "prior_discounts")).toBe(W.priorSaveCap * W.priorDiscountPoints);
    });
    it("recent revise, suspended and imminent renewal", () => {
      expect(points({ recentRevise: true }, "recent_revise")).toBe(W.recentRevisePoints);
      expect(points({ status: "SUSPENDED" }, "suspended")).toBe(W.suspendedPoints);
      expect(points({ daysToNextBilling: 3 }, "renewal_soon")).toBe(W.renewalSoonPoints);
      expect(points({ daysToNextBilling: 4 }, "renewal_soon")).toBe(0);
      expect(points({ daysToNextBilling: -1 }, "renewal_soon")).toBe(0);
    });
  });

  describe("bands", () => {
    it("switch exactly at the boundaries", () => {
      expect(bandFor(RISK_BANDS.mediumMin - 1)).toBe("low");
      expect(bandFor(RISK_BANDS.mediumMin)).toBe("medium");
      expect(bandFor(RISK_BANDS.highMin - 1)).toBe("medium");
      expect(bandFor(RISK_BANDS.highMin)).toBe("high");
    });
    it("a suspended subscriber with repeated recent failures is high", () => {
      const r = scoreChurnRisk(
        with_({
          status: "SUSPENDED",
          failedPaymentsCount: 3,
          daysSinceLastFailure: 2,
          outstandingValue: "10.00",
        }),
      );
      expect(r.band).toBe("high");
    });
  });

  describe("properties", () => {
    it("is an integer from 0 to 100 whose band matches its score", () => {
      fc.assert(
        fc.property(signals, (s) => {
          const r = scoreChurnRisk(s);
          expect(Number.isInteger(r.score)).toBe(true);
          expect(r.score).toBeGreaterThanOrEqual(0);
          expect(r.score).toBeLessThanOrEqual(100);
          expect(r.band).toBe(bandFor(r.score));
        }),
      );
    });
    it("factor points sum to the score before clamping", () => {
      fc.assert(
        fc.property(signals, (s) => {
          const r = scoreChurnRisk(s);
          const sum = r.factors.reduce((t, f) => t + f.points, 0);
          expect(r.score).toBe(Math.min(100, sum));
          expect(r.factors.every((f) => f.points > 0 && f.detail.length > 0)).toBe(true);
        }),
      );
    });
    it("is deterministic", () => {
      fc.assert(
        fc.property(signals, (s) => {
          expect(scoreChurnRisk(s)).toEqual(scoreChurnRisk({ ...s }));
        }),
      );
    });
    it("more failed payments never lowers risk", () => {
      fc.assert(
        fc.property(signals, fc.integer({ min: 1, max: 5 }), (s, extra) => {
          const more = { ...s, failedPaymentsCount: s.failedPaymentsCount + extra };
          expect(scoreChurnRisk(more).score).toBeGreaterThanOrEqual(scoreChurnRisk(s).score);
        }),
      );
    });
    it("more prior saves, an outstanding balance, a recent revise or a suspension never lower risk", () => {
      fc.assert(
        fc.property(signals, (s) => {
          const base = scoreChurnRisk(s).score;
          expect(scoreChurnRisk({ ...s, priorPauses: s.priorPauses + 1 }).score).toBeGreaterThanOrEqual(base);
          expect(
            scoreChurnRisk({ ...s, priorDowngrades: s.priorDowngrades + 1 }).score,
          ).toBeGreaterThanOrEqual(base);
          expect(scoreChurnRisk({ ...s, priorDiscounts: s.priorDiscounts + 1 }).score).toBeGreaterThanOrEqual(
            base,
          );
          expect(scoreChurnRisk({ ...s, outstandingValue: "9.00" }).score).toBeGreaterThanOrEqual(base);
          expect(scoreChurnRisk({ ...s, recentRevise: true }).score).toBeGreaterThanOrEqual(base);
          expect(scoreChurnRisk({ ...s, status: "SUSPENDED" }).score).toBeGreaterThanOrEqual(base);
        }),
      );
    });
    it("a longer-tenured subscriber is never riskier on tenure alone", () => {
      fc.assert(
        fc.property(signals, fc.integer({ min: 1, max: 500 }), (s, extra) => {
          const older = scoreChurnRisk({ ...s, tenureDays: s.tenureDays + extra }).score;
          expect(older).toBeLessThanOrEqual(scoreChurnRisk(s).score);
        }),
      );
    });
  });
});
