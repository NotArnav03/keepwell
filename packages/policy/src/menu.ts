import {
  OfferMenu,
  ReasonCategory,
  type Offer,
  type OfferKind,
  type PolicyContext,
  type PolicyDocument,
} from "@keepwell/contracts";
import {
  DEFAULT_REASON_PREFERENCES,
  OFFERABLE_KINDS,
  PAUSE_CYCLES,
  PRICE_CHANGE_MIN_DAYS,
  REFUND_WINDOW_DAYS,
  RULE,
  type OfferableKind,
  type RuleId,
} from "./rules.js";
import { addIntervals, daysBetween, fromCents, sameInterval, toCents } from "./units.js";

export interface Check {
  rule: RuleId;
  message: string;
}

/** computeMenu's working, kept so evaluate() can name the exact rule behind a denial. */
export interface Analysis {
  menu: OfferMenu;
  /** Set when a rule empties the whole menu. */
  gate: Check | null;
  exclusions: (Check & { kind: OfferableKind })[];
  /** Why each offered kind is allowed, for PolicyDecision.explanation. Empty for excluded kinds. */
  notes: Record<OfferableKind, string[]>;
}

/** Facts derived once from the context. */
interface Facts {
  policy: PolicyDocument;
  ctx: PolicyContext;
  currency: string;
  planCents: number;
  /** What the subscriber pays now: the discount override if one is active. */
  currentCents: number;
  tenureDays: number;
  nextBilling: string | null;
}

type Built = { offers: Offer[]; notes: string[] } | Check;

/** What may be offered to this subscriber right now. Pure: the same input gives the same menu. */
export function computeMenu(policy: PolicyDocument, ctx: PolicyContext): OfferMenu {
  return analyse(policy, ctx).menu;
}

export function analyse(policy: PolicyDocument, ctx: PolicyContext): Analysis {
  const sub = ctx.subscription;
  const facts: Facts = {
    policy,
    ctx,
    currency: sub.price.currency,
    planCents: toCents(sub.price),
    currentCents: toCents(sub.priceOverride ?? sub.price),
    tenureDays: daysBetween(sub.startedAt, ctx.now),
    nextBilling: sub.nextBillingTime,
  };

  const gate = gateFor(facts);
  if (gate) {
    const exclusions = OFFERABLE_KINDS.map((kind) => ({ kind, ...gate }));
    return { menu: buildMenu(facts, [], exclusions), gate, exclusions, notes: noNotes() };
  }

  const allowedKinds = rankedKinds(policy, ctx.reason);
  const offers: Offer[] = [];
  const exclusions: Analysis["exclusions"] = [];
  const notes = noNotes();
  for (const kind of OFFERABLE_KINDS) {
    const built = BUILDERS[kind](facts);
    if ("rule" in built) {
      exclusions.push({ kind, ...built });
    } else if (!allowedKinds.includes(kind)) {
      exclusions.push({
        kind,
        rule: RULE.reasonPreferences,
        message: `Not offered when the reason is "${ctx.reason}"`,
      });
    } else {
      offers.push(...built.offers);
      notes[kind] = built.notes;
    }
  }
  const rank = (offer: Offer) => allowedKinds.indexOf(offer.kind);
  offers.sort((a, b) => rank(a) - rank(b)); // stable: keeps each kind's own order

  return { menu: buildMenu(facts, offers, exclusions), gate: null, exclusions, notes };
}

function noNotes(): Analysis["notes"] {
  return { pause: [], downgrade: [], switch_annual: [], discount: [], refund_partial: [] };
}

/** Rules that empty the whole menu, in order of precedence. */
function gateFor({ policy, ctx }: Facts): Check | null {
  if (ctx.cancelIntent) {
    return { rule: RULE.cancelIntent, message: "The subscriber asked to cancel, so nothing is offered" };
  }
  if (ctx.offersPresentedThisSession > 0) {
    return { rule: RULE.oneOfferPerSession, message: "An offer was already shown in this session" };
  }
  if (ctx.subscription.status !== "ACTIVE") {
    return {
      rule: RULE.notActive,
      message: `The subscription is ${ctx.subscription.status}, not ACTIVE`,
    };
  }
  const maxSaves = policy.eligibility.maxSavesPerSubscriberPer365d;
  if (ctx.history.savesLast365d >= maxSaves) {
    return {
      rule: RULE.maxSaves,
      message: `The subscriber was already kept ${ctx.history.savesLast365d} times in 365 days (limit ${maxSaves})`,
    };
  }
  return null;
}

/** The kinds allowed for `reason`, best first: the policy's ranking or the default, cut at "none". */
export function rankedKinds(policy: PolicyDocument, reason: ReasonCategory): OfferableKind[] {
  const ranking: readonly OfferKind[] =
    policy.reasonPreferences[reason] ?? DEFAULT_REASON_PREFERENCES[reason];
  const stop = ranking.indexOf("none");
  const kinds = (stop === -1 ? ranking : ranking.slice(0, stop)).filter(
    (kind): kind is OfferableKind => kind !== "none",
  );
  return [...new Set(kinds)];
}

function buildMenu({ policy, ctx }: Facts, offers: Offer[], exclusions: Analysis["exclusions"]): OfferMenu {
  const defaultFor = (reason: ReasonCategory): string | null => {
    for (const kind of rankedKinds(policy, reason)) {
      const offer = offers.find((o) => o.kind === kind);
      if (offer) return offer.id;
    }
    return null;
  };
  return OfferMenu.parse({
    policyVersion: policy.version,
    computedAt: ctx.now,
    offers,
    defaultByReason: Object.fromEntries(ReasonCategory.options.map((r) => [r, defaultFor(r)])),
    excluded: exclusions.map(({ kind, message }) => ({ kind, because: message })),
  });
}

const disabled = (kind: OfferableKind): Check => ({
  rule: RULE.disabled,
  message: `The merchant's policy doesn't offer ${kind.replace("_", " ")}`,
});

const BUILDERS: Record<OfferableKind, (facts: Facts) => Built> = {
  pause({ policy, ctx, nextBilling }) {
    const rule = policy.offers.pause;
    if (!rule.enabled) return disabled("pause");
    if (nextBilling === null) {
      return { rule: RULE.noNextBilling, message: "The subscription has no next billing date" };
    }
    const lastEnded = ctx.history.lastPauseEndedAt;
    if (lastEnded !== null && daysBetween(lastEnded, ctx.now) < rule.cooldownDays) {
      return {
        rule: RULE.pauseCooldown,
        message: `The last pause ended less than ${rule.cooldownDays} days ago`,
      };
    }
    const cycles = [...new Set([...PAUSE_CYCLES, rule.maxCycles])]
      .filter((c) => c <= rule.maxCycles)
      .sort((a, b) => a - b);
    return {
      // Billing skips `c` renewals from the next one, then resumes.
      offers: cycles.map((c) => ({
        id: `pause-${c}`,
        kind: "pause",
        cycles: c,
        resumesOn: addIntervals(nextBilling, ctx.subscription.interval, c),
      })),
      notes: [`Pause is enabled for up to ${rule.maxCycles} billing cycles`],
    };
  },

  downgrade({ policy, ctx, currency, currentCents }) {
    const rule = policy.offers.downgrade;
    if (!rule.enabled) return disabled("downgrade");
    const sub = ctx.subscription;
    const targets = rule.targets[sub.paypalPlanId] ?? [];
    if (targets.length === 0) {
      return { rule: RULE.noTarget, message: `No downgrade is set up for ${sub.planName}` };
    }
    const offers: Offer[] = [];
    for (const planId of new Set(targets)) {
      const plan = ctx.plans.find((p) => p.planId === planId);
      if (
        plan &&
        plan.price.currency === currency &&
        sameInterval(plan.interval, sub.interval) &&
        toCents(plan.price) < currentCents
      ) {
        offers.push({
          id: `downgrade-${planId}`,
          kind: "downgrade",
          toPlanId: planId,
          toPlanName: plan.name,
          newPrice: plan.price,
        });
      }
    }
    if (offers.length === 0) {
      return {
        rule: RULE.notCheaper,
        message: "No downgrade plan is cheaper with the same currency and billing interval",
      };
    }
    return { offers, notes: [`Downgrade from ${sub.planName} is enabled`] };
  },

  switch_annual({ policy, ctx, currency, currentCents }) {
    const rule = policy.offers.switch_annual;
    if (!rule.enabled) return disabled("switch_annual");
    const sub = ctx.subscription;
    const planId = rule.targets[sub.paypalPlanId];
    if (planId === undefined) {
      return { rule: RULE.noTarget, message: `No annual plan is set up for ${sub.planName}` };
    }
    const plan = ctx.plans.find((p) => p.planId === planId);
    const oneMonth = { unit: "MONTH", count: 1 } as const;
    const oneYear = { unit: "YEAR", count: 1 } as const;
    if (
      !sameInterval(sub.interval, oneMonth) ||
      !plan ||
      plan.price.currency !== currency ||
      !sameInterval(plan.interval, oneYear)
    ) {
      return {
        rule: RULE.badTarget,
        message: "Switching to annual needs a monthly plan and a 1-year target in the same currency",
      };
    }
    const effectiveMonthly = Math.floor(toCents(plan.price) / 12);
    if (effectiveMonthly >= currentCents) {
      return { rule: RULE.notCheaper, message: "The annual plan isn't cheaper per month" };
    }
    return {
      offers: [
        {
          id: `switch_annual-${planId}`,
          kind: "switch_annual",
          toPlanId: planId,
          newPrice: plan.price,
          effectiveMonthly: fromCents(effectiveMonthly, currency),
        },
      ],
      notes: [`Switching ${sub.planName} to annual billing is enabled`],
    };
  },

  discount({ policy, ctx, currency, planCents, tenureDays, nextBilling }) {
    const rule = policy.offers.discount;
    if (!rule.enabled) return disabled("discount");
    const minTenure = policy.eligibility.minTenureDaysForDiscount;
    if (tenureDays < minTenure) {
      return { rule: RULE.minTenure, message: `Discounts need at least ${minTenure} days as a subscriber` };
    }
    if (ctx.subscription.priceOverride !== null) {
      return { rule: RULE.alreadyDiscounted, message: "A discount is already active" };
    }
    if (nextBilling === null || daysBetween(ctx.now, nextBilling) < PRICE_CHANGE_MIN_DAYS) {
      return {
        rule: RULE.priceChangeTooSoon,
        message: `Next billing is under ${PRICE_CHANGE_MIN_DAYS} days away, so a price change wouldn't apply to it`,
      };
    }
    // Rounded down: the subscriber never pays more than the advertised percentage implies.
    const newCents = Math.floor((planCents * (100 - rule.maxPercent)) / 100);
    if (newCents < 1) {
      return {
        rule: RULE.zeroPrice,
        message: "The discount would make the price 0.00; offer a pause instead",
      };
    }
    return {
      offers: [
        {
          id: `discount-${rule.maxPercent}`,
          kind: "discount",
          percent: rule.maxPercent,
          cycles: rule.maxCycles,
          newPrice: fromCents(newCents, currency),
          firstAffectedBilling: nextBilling,
        },
      ],
      notes: [
        `Discounts up to ${rule.maxPercent}% for ${rule.maxCycles} cycles are enabled`,
        `Next billing is at least ${PRICE_CHANGE_MIN_DAYS} days away`,
      ],
    };
  },

  refund_partial({ policy, ctx, currency, planCents }) {
    const rule = policy.offers.refund_partial;
    if (!rule.enabled) return disabled("refund_partial");
    const payment = ctx.subscription.lastPayment;
    if (payment === null) return { rule: RULE.noPayment, message: "There is no payment to refund" };
    if (
      payment.amount.currency !== currency ||
      rule.maxPerMonth.currency !== currency ||
      ctx.history.refundedLast30d.currency !== currency
    ) {
      return { rule: RULE.currencyMismatch, message: `Refund limits aren't in ${currency}` };
    }
    if (daysBetween(payment.time, ctx.now) > REFUND_WINDOW_DAYS) {
      return {
        rule: RULE.refundTooOld,
        message: `The last payment is over ${REFUND_WINDOW_DAYS} days old`,
      };
    }
    const cents = Math.min(
      Math.floor((toCents(payment.amount) * rule.maxPercentOfLastPayment) / 100),
      toCents(rule.maxPerMonth) - toCents(ctx.history.refundedLast30d),
      planCents,
    );
    if (cents < 1) {
      return { rule: RULE.refundMonthlyCap, message: "The refund limit for this month is used up" };
    }
    return {
      offers: [
        {
          id: "refund_partial",
          kind: "refund_partial",
          amount: fromCents(cents, currency),
          ofPaymentOn: payment.time,
        },
      ],
      notes: [
        `Partial refunds up to ${rule.maxPercentOfLastPayment}% of the last payment are enabled`,
        `Refunds stay within ${rule.maxPerMonth.value} ${currency} per 30 days`,
      ],
    };
  },
};
