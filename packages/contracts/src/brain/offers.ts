import { z } from "zod";
import { IsoDateTime, Money, ReasonCategory } from "../shared.js";

// Offers, menus and decisions (CONTRACTS.md §1 "offers & policy", owner M2).
// The offer card renders from these objects, never from model text (design law 4).

/** "none" only appears in rankings and exclusions: it means "offer nothing for this reason". */
export const OfferKind = z.enum([
  "pause",
  "downgrade",
  "switch_annual",
  "discount",
  "refund_partial",
  "none",
]);
export type OfferKind = z.infer<typeof OfferKind>;

/** Stable within one menu; the agent's tool call and the accept route refer to offers by this id. */
const OfferId = z.string().min(1).max(64);

export const PauseOffer = z.object({
  id: OfferId,
  kind: z.literal("pause"),
  cycles: z.number().int().min(1).max(12),
  /** When billing starts again: the scheduled `activate`. */
  resumesOn: IsoDateTime,
});

export const DowngradeOffer = z.object({
  id: OfferId,
  kind: z.literal("downgrade"),
  toPlanId: z.string().min(1),
  toPlanName: z.string().min(1),
  newPrice: Money,
});

export const SwitchAnnualOffer = z.object({
  id: OfferId,
  kind: z.literal("switch_annual"),
  toPlanId: z.string().min(1),
  newPrice: Money,
  /** newPrice / 12, rounded down to the cent: shown so the saving is honest. */
  effectiveMonthly: Money,
});

export const DiscountOffer = z.object({
  id: OfferId,
  kind: z.literal("discount"),
  percent: z.number().int().min(1).max(100),
  cycles: z.number().int().min(1),
  newPrice: Money,
  /** The first billing that charges newPrice (PayPal's 10-day rule decides which one). */
  firstAffectedBilling: IsoDateTime,
});

export const RefundPartialOffer = z.object({
  id: OfferId,
  kind: z.literal("refund_partial"),
  amount: Money,
  /** The time of the payment being partly refunded. */
  ofPaymentOn: IsoDateTime,
});

export const Offer = z.discriminatedUnion("kind", [
  PauseOffer,
  DowngradeOffer,
  SwitchAnnualOffer,
  DiscountOffer,
  RefundPartialOffer,
]);
export type Offer = z.infer<typeof Offer>;

/** What computeMenu returns: everything the agent may offer this subscriber right now. */
export const OfferMenu = z.object({
  policyVersion: z.number().int().min(1),
  computedAt: IsoDateTime,
  /** May be empty: then the agent offers nothing and the subscriber sees only Cancel. */
  offers: z.array(Offer),
  /** Offer id per reason for L1 fallback (no AI); null means no offer. Every reason has an entry. */
  defaultByReason: z.record(ReasonCategory, OfferId.nullable()),
  /** Why each other kind isn't offered, for `explain` and the dashboard dry-run. */
  excluded: z.array(z.object({ kind: OfferKind, because: z.string().min(1) })),
});
export type OfferMenu = z.infer<typeof OfferMenu>;

/** evaluate()'s verdict on one pick. Stored with the audit entry, so it carries its policy version. */
export const PolicyDecision = z.object({
  allowed: z.boolean(),
  policyVersion: z.number().int().min(1),
  offer: Offer.nullable(),
  /** Empty when allowed. `rule` is a stable id, e.g. "builtin.one_offer_per_session". */
  violations: z.array(z.object({ rule: z.string().min(1), message: z.string() })),
  explanation: z.array(z.string()),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;
