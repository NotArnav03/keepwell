import {
  OfferKind,
  PolicyContext,
  PolicyDocument,
  ReasonCategory,
  SubscriptionStatus,
  type Money,
  type OfferMenu,
} from "@keepwell/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.js";
import { analyse, computeMenu, rankedKinds } from "./menu.js";
import { OFFERABLE_KINDS, PRICE_CHANGE_MIN_DAYS, REFUND_WINDOW_DAYS } from "./rules.js";
import { daysBetween, fromCents, toCents } from "./units.js";

// "For any policy and any subscriber" (ARCHITECTURE.md §6.6): random policies and contexts,
// including nonsense ones, must never produce an offer outside the policy's limits.

const RUNS = { numRuns: 1000 };
const PLAN_IDS = ["P-A", "P-B", "P-C", "P-D"] as const;

// Mostly realistic values, so most runs reach the offer rules, with edge cases mixed in
// (other currencies, odd intervals, inactive subscriptions, prices of 0.00).
const DAY_MS = 86_400_000;
/** `usual` 9 times in 10, otherwise one of `rare`. */
const mostly = <T>(usual: T, ...rare: T[]) =>
  fc.oneof({ weight: 9, arbitrary: fc.constant(usual) }, { weight: 1, arbitrary: fc.constantFrom(...rare) });
const currency = mostly("USD", "EUR");
const moneyIn = (cur: fc.Arbitrary<string>, max = 50_000) =>
  fc.tuple(fc.integer({ min: 0, max }), cur).map(([c, code]) => fromCents(c, code));
const usd = moneyIn(fc.constant("USD"));
const interval = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ unit: "MONTH" as const, count: 1 }) },
  {
    weight: 1,
    arbitrary: fc.record({
      unit: fc.constantFrom("DAY", "WEEK", "MONTH", "YEAR"),
      count: fc.integer({ min: 1, max: 3 }),
    }),
  },
);
const planId = fc.constantFrom(...PLAN_IDS);
/** null 9 times in 10. */
const rarely = <T>(arb: fc.Arbitrary<T>) =>
  fc.oneof({ weight: 9, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: arb });
const enabled = mostly(true, false);
/** Days relative to `now`, in whole hours (fc.double clusters at the edges of its range). */
const hoursAsDays = (min: number, max: number) =>
  fc.integer({ min: min * 24, max: max * 24 }).map((hours) => hours / 24);
const daysAgo = (max: number) => hoursAsDays(0, max);

const policyArb = fc
  .record({
    version: fc.integer({ min: 1, max: 5 }),
    offers: fc.record({
      pause: fc.record({
        enabled,
        maxCycles: fc.integer({ min: 1, max: 12 }),
        cooldownDays: fc.integer({ min: 0, max: 365 }),
      }),
      downgrade: fc.record({
        enabled,
        targets: fc.dictionary(planId, fc.array(planId, { maxLength: 3 }), { minKeys: 2 }),
      }),
      switch_annual: fc.record({ enabled, targets: fc.dictionary(planId, planId, { minKeys: 2 }) }),
      discount: fc.record({
        enabled,
        maxPercent: fc.integer({ min: 1, max: 100 }),
        maxCycles: fc.integer({ min: 1, max: 12 }),
      }),
      refund_partial: fc.record({
        enabled,
        maxPercentOfLastPayment: fc.integer({ min: 1, max: 100 }),
        maxPerMonth: moneyIn(currency),
      }),
    }),
    eligibility: fc.record({
      minTenureDaysForDiscount: fc.integer({ min: 0, max: 120 }),
      maxSavesPerSubscriberPer365d: mostly(2, 0, 1, 4),
    }),
    reasonPreferences: fc.oneof(
      { weight: 2, arbitrary: fc.constant({}) },
      {
        weight: 1,
        arbitrary: fc.dictionary(
          fc.constantFrom(...ReasonCategory.options),
          fc.array(fc.constantFrom(...OfferKind.options), { maxLength: 6 }),
        ),
      },
    ),
    tone: fc.constantFrom("warm", "neutral", "brief"),
    supportContact: fc.constant("help@pantryplan.example"),
  })
  .map((doc) => PolicyDocument.parse(doc));

const ctxArb = fc
  .record({
    nowMs: fc.integer({ min: Date.parse("2025-01-01T00:00:00Z"), max: Date.parse("2028-12-31T00:00:00Z") }),
    channel: fc.constantFrom("widget", "portal", "subscriber_agent"),
    reason: fc.constantFrom(...ReasonCategory.options),
    cancelIntent: mostly(false, true),
    offersPresentedThisSession: mostly(0, 1, 2),
    paypalPlanId: planId,
    price: usd,
    priceOverride: rarely(usd),
    interval,
    status: mostly("ACTIVE", ...SubscriptionStatus.options.filter((st) => st !== "ACTIVE")),
    tenureDays: daysAgo(800),
    /** Next billing from 5 days ago (overdue) to 60 days ahead. */
    nextBillingInDays: fc.option(hoursAsDays(-5, 60), { freq: 8 }),
    lastPayment: fc.option(fc.record({ amount: moneyIn(currency), daysAgo: daysAgo(400) }), { freq: 8 }),
    savesLast365d: mostly(0, 1, 2, 3),
    pausesLast365d: fc.integer({ min: 0, max: 4 }),
    lastPauseEndedDaysAgo: rarely(daysAgo(400)),
    refundedLast30d: moneyIn(currency, 2_000),
    plans: fc.uniqueArray(
      fc.record({
        planId,
        name: fc.constant("Plan"),
        price: moneyIn(currency),
        interval: fc.oneof(interval, fc.constant({ unit: "YEAR" as const, count: 1 })),
      }),
      { selector: (p) => p.planId, minLength: 2, maxLength: 4 },
    ),
  })
  .map((g) => {
    const at = (daysFromNow: number) => new Date(g.nowMs + daysFromNow * DAY_MS).toISOString();
    const now = at(0);
    return PolicyContext.parse({
      now,
      channel: g.channel,
      reason: g.reason,
      cancelIntent: g.cancelIntent,
      offersPresentedThisSession: g.offersPresentedThisSession,
      plans: g.plans,
      subscription: {
        id: "01972f3e-8c4a-7b1e-9d2a-000000000001",
        merchantId: "01972f3e-8c4a-7b1e-9d2a-3f4b5c6d7e8f",
        paypalSubscriptionId: "I-PROPERTY",
        paypalPlanId: g.paypalPlanId,
        planName: "Plan",
        price: g.price,
        priceOverride: g.priceOverride,
        interval: g.interval,
        status: g.status,
        startedAt: at(-g.tenureDays),
        nextBillingTime: g.nextBillingInDays === null ? null : at(g.nextBillingInDays),
        lastPayment: g.lastPayment && { amount: g.lastPayment.amount, time: at(-g.lastPayment.daysAgo) },
        outstandingBalance: null,
        failedPaymentsCount: 0,
        lastFailure: null,
        subscriberFirstName: null,
        syncedAt: now,
      },
      history: {
        savesLast365d: g.savesLast365d,
        pausesLast365d: g.pausesLast365d,
        lastPauseEndedAt: g.lastPauseEndedDaysAgo === null ? null : at(-g.lastPauseEndedDaysAgo),
        refundedLast30d: g.refundedLast30d,
      },
    });
  });

const cents = (m: Money) => toCents(m);
const isEmpty = (menu: OfferMenu) =>
  menu.offers.length === 0 && Object.values(menu.defaultByReason).every((id) => id === null);

describe("policy properties", () => {
  it("cancel intent always gives an empty menu", () => {
    fc.assert(
      fc.property(policyArb, ctxArb, (policy, ctx) => {
        expect(isEmpty(computeMenu(policy, { ...ctx, cancelIntent: true }))).toBe(true);
      }),
      RUNS,
    );
  });

  it("never more than one offer per session", () => {
    fc.assert(
      fc.property(policyArb, ctxArb, fc.integer({ min: 1, max: 5 }), (policy, ctx, shown) => {
        expect(isEmpty(computeMenu(policy, { ...ctx, offersPresentedThisSession: shown }))).toBe(true);
      }),
      RUNS,
    );
  });

  it("nothing is offered on a subscription that isn't ACTIVE, or past the yearly save limit", () => {
    fc.assert(
      fc.property(policyArb, ctxArb, (policy, ctx) => {
        const inactive = ctx.subscription.status !== "ACTIVE";
        const tooMany = ctx.history.savesLast365d >= policy.eligibility.maxSavesPerSubscriberPer365d;
        if (inactive || tooMany) expect(isEmpty(computeMenu(policy, ctx))).toBe(true);
      }),
      RUNS,
    );
  });

  it("every offer is enabled, allowed for the reason, and within the policy's limits", () => {
    fc.assert(
      fc.property(policyArb, ctxArb, (policy, ctx) => {
        const sub = ctx.subscription;
        const cur = sub.price.currency;
        const planPrice = cents(sub.price);
        const paying = cents(sub.priceOverride ?? sub.price);
        const allowedKinds = rankedKinds(policy, ctx.reason);
        for (const offer of computeMenu(policy, ctx).offers) {
          expect(policy.offers[offer.kind].enabled).toBe(true);
          expect(allowedKinds).toContain(offer.kind);
          switch (offer.kind) {
            case "pause":
              expect(offer.cycles).toBeLessThanOrEqual(policy.offers.pause.maxCycles);
              expect(sub.nextBillingTime).not.toBeNull();
              expect(Date.parse(offer.resumesOn)).toBeGreaterThan(Date.parse(sub.nextBillingTime ?? ""));
              break;
            case "downgrade":
              expect(policy.offers.downgrade.targets[sub.paypalPlanId]).toContain(offer.toPlanId);
              expect(offer.newPrice.currency).toBe(cur);
              expect(cents(offer.newPrice)).toBeLessThan(paying);
              break;
            case "switch_annual":
              expect(policy.offers.switch_annual.targets[sub.paypalPlanId]).toBe(offer.toPlanId);
              expect(offer.newPrice.currency).toBe(cur);
              expect(cents(offer.effectiveMonthly)).toBeLessThan(paying);
              expect(cents(offer.effectiveMonthly) * 12).toBeLessThanOrEqual(cents(offer.newPrice));
              break;
            case "discount":
              expect(offer.percent).toBeLessThanOrEqual(policy.offers.discount.maxPercent);
              expect(offer.cycles).toBeLessThanOrEqual(policy.offers.discount.maxCycles);
              expect(cents(offer.newPrice)).toBeGreaterThan(0);
              expect(cents(offer.newPrice)).toBeLessThanOrEqual(planPrice);
              expect(sub.priceOverride).toBeNull();
              expect(daysBetween(ctx.now, offer.firstAffectedBilling)).toBeGreaterThanOrEqual(
                PRICE_CHANGE_MIN_DAYS,
              );
              expect(daysBetween(sub.startedAt, ctx.now)).toBeGreaterThanOrEqual(
                policy.eligibility.minTenureDaysForDiscount,
              );
              break;
            case "refund_partial": {
              const rule = policy.offers.refund_partial;
              const paid = sub.lastPayment;
              expect(paid).not.toBeNull();
              if (!paid) break;
              const amount = cents(offer.amount);
              expect(offer.amount.currency).toBe(cur);
              expect(amount).toBeGreaterThan(0);
              expect(amount).toBeLessThanOrEqual(planPrice);
              expect(amount * 100).toBeLessThanOrEqual(cents(paid.amount) * rule.maxPercentOfLastPayment);
              expect(cents(ctx.history.refundedLast30d) + amount).toBeLessThanOrEqual(
                cents(rule.maxPerMonth),
              );
              expect(daysBetween(paid.time, ctx.now)).toBeLessThanOrEqual(REFUND_WINDOW_DAYS);
              break;
            }
          }
        }
      }),
      RUNS,
    );
  });

  it("evaluate allows every pick from computeMenu, unchanged", () => {
    fc.assert(
      fc.property(policyArb, ctxArb, (policy, ctx) => {
        const menu = computeMenu(policy, ctx);
        for (const offer of menu.offers) {
          const decision = evaluate(policy, ctx, offer.id, menu);
          expect(decision.violations).toEqual([]);
          expect(decision.allowed).toBe(true);
          expect(decision.offer).toEqual(offer);
        }
      }),
      RUNS,
    );
  });

  it("evaluate denies any id the menu doesn't hold", () => {
    fc.assert(
      fc.property(policyArb, ctxArb, fc.string({ minLength: 1, maxLength: 20 }), (policy, ctx, id) => {
        const menu = computeMenu(policy, ctx);
        fc.pre(!menu.offers.some((o) => o.id === id));
        const decision = evaluate(policy, ctx, id, menu);
        expect(decision.allowed).toBe(false);
        expect(decision.offer).toBeNull();
      }),
      RUNS,
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(policyArb, ctxArb, (policy, ctx) => {
        expect(computeMenu(policy, ctx)).toEqual(computeMenu(structuredClone(policy), structuredClone(ctx)));
      }),
      RUNS,
    );
  });

  it("menus are well formed: unique ids, defaults on the menu, every kind offered or explained", () => {
    fc.assert(
      fc.property(policyArb, ctxArb, (policy, ctx) => {
        const { menu, exclusions } = analyse(policy, ctx);
        const ids = menu.offers.map((o) => o.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of Object.values(menu.defaultByReason)) {
          if (id !== null) expect(ids).toContain(id);
        }
        const offered = new Set(menu.offers.map((o) => o.kind));
        const excluded = exclusions.map((e) => e.kind);
        expect(new Set(excluded).size).toBe(excluded.length);
        expect([...offered, ...excluded].sort()).toEqual([...OFFERABLE_KINDS].sort());
        expect(menu.policyVersion).toBe(policy.version);
      }),
      RUNS,
    );
  });
});
