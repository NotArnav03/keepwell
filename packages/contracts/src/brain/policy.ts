import { z } from "zod";
import { BillingInterval, Channel, IsoDateTime, Money, ReasonCategory } from "../shared.js";
import { SubscriptionSnapshot } from "../platform/subscriptions.js";
import { OfferKind } from "./offers.js";

// The merchant's policy document and the context the policy engine reads (owner M2).
// Built in and NOT configurable, enforced by packages/policy: at most 1 offer per session;
// cancel intent → empty menu; no price change when next billing is under 10 days away;
// amounts never exceed the plan price.

const NonNegativeInt = z.number().int().min(0);

/** Versioned and immutable once published: a new edit is a new version. */
export const PolicyDocument = z.object({
  version: z.number().int().min(1),
  offers: z.object({
    pause: z.object({
      enabled: z.boolean(),
      maxCycles: z.number().int().min(1).max(12),
      /** Days after a pause ends before another pause can be offered. */
      cooldownDays: NonNegativeInt,
    }),
    downgrade: z.object({
      enabled: z.boolean(),
      /** fromPlanId → the plan ids it may move down to. */
      targets: z.record(z.string(), z.array(z.string().min(1))),
    }),
    switch_annual: z.object({
      enabled: z.boolean(),
      /** monthly planId → its annual planId. */
      targets: z.record(z.string(), z.string().min(1)),
    }),
    discount: z.object({
      enabled: z.boolean(),
      maxPercent: z.number().int().min(1).max(100),
      maxCycles: z.number().int().min(1),
    }),
    refund_partial: z.object({
      enabled: z.boolean(),
      maxPercentOfLastPayment: z.number().int().min(1).max(100),
      maxPerMonth: Money,
    }),
  }),
  eligibility: z.object({
    minTenureDaysForDiscount: NonNegativeInt,
    maxSavesPerSubscriberPer365d: NonNegativeInt,
  }),
  /** Ranked offer kinds per reason. A missing reason falls back to the engine's default ranking. */
  reasonPreferences: z.partialRecord(ReasonCategory, z.array(OfferKind)),
  tone: z.enum(["warm", "neutral", "brief"]),
  /** Shown in L2 (API down) and in every close message. */
  supportContact: z.string().min(1),
});
export type PolicyDocument = z.infer<typeof PolicyDocument>;

/** A plan the merchant sells, so downgrade and annual offers can show a name and a real price. */
export const PlanInfo = z.object({
  planId: z.string().min(1),
  name: z.string().min(1),
  price: Money,
  interval: BillingInterval,
});
export type PlanInfo = z.infer<typeof PlanInfo>;

/** What Keepwell already did for this subscriber, from our own tables. */
export const SubscriberHistory = z.object({
  savesLast365d: NonNegativeInt,
  pausesLast365d: NonNegativeInt,
  lastPauseEndedAt: IsoDateTime.nullable(),
  /** Sum of partial refunds in the last 30 days, in the subscription's currency. */
  refundedLast30d: Money,
});
export type SubscriberHistory = z.infer<typeof SubscriberHistory>;

/**
 * Input to computeMenu / evaluate. Everything is passed in, including `now`, so the engine stays
 * pure and the dashboard can dry-run it in the browser. Tenure and days to next billing are
 * derived from `subscription` and `now`.
 */
export const PolicyContext = z.object({
  now: IsoDateTime,
  channel: Channel,
  reason: ReasonCategory,
  /** The subscriber said they want to cancel: the menu is empty (no-means-no). */
  cancelIntent: z.boolean(),
  offersPresentedThisSession: NonNegativeInt,
  subscription: SubscriptionSnapshot,
  history: SubscriberHistory,
  /** The merchant's plan catalogue. */
  plans: z.array(PlanInfo),
});
export type PolicyContext = z.infer<typeof PolicyContext>;
