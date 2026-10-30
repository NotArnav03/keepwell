import {
  canonicalJson,
  ReasonCategory,
  type Offer,
  type OfferMenu,
  type PolicyContext,
  type PolicyDecision,
  type PolicyDocument,
} from "@keepwell/contracts";
import { analyse, type Check } from "./menu.js";
import { RULE } from "./rules.js";

/**
 * Re-checks one pick from a menu (design law 3: the AI proposes, the policy decides). The menu is
 * recomputed from `policy` and `ctx` rather than trusted, so a stale or tampered menu, or an
 * offer whose terms were changed, is denied with the rule that stops it.
 */
export function evaluate(
  policy: PolicyDocument,
  ctx: PolicyContext,
  offerId: string,
  menu: OfferMenu,
): PolicyDecision {
  const analysis = analyse(policy, ctx);
  const violations: Check[] = [];

  if (menu.policyVersion !== policy.version) {
    violations.push({
      rule: RULE.policyVersion,
      message: `The menu came from policy v${menu.policyVersion}, but v${policy.version} is in force`,
    });
  }

  const picked = menu.offers.find((o) => o.id === offerId);
  if (!picked) {
    violations.push({ rule: RULE.offerNotInMenu, message: `Offer "${offerId}" isn't on the menu` });
  }

  if (analysis.gate) {
    violations.push(analysis.gate);
  } else if (picked) {
    const allowedNow = analysis.menu.offers.find((o) => o.id === picked.id);
    const exclusion = analysis.exclusions.find((e) => e.kind === picked.kind);
    if (allowedNow && canonicalJson(allowedNow) === canonicalJson(picked)) {
      // Allowed: same id, same terms.
    } else if (!allowedNow && exclusion) {
      violations.push({ rule: exclusion.rule, message: exclusion.message });
    } else {
      violations.push({
        rule: RULE.offerNotAllowedNow,
        message: `Offer "${picked.id}" doesn't match any offer the policy allows now`,
      });
    }
  }

  const allowed = violations.length === 0 && picked !== undefined;
  return {
    allowed,
    policyVersion: policy.version,
    offer: allowed ? picked : null,
    violations: violations.map(({ rule, message }) => ({ rule, message })),
    explanation: allowed ? [...analysis.notes[picked.kind], reasonNote(ctx)] : [],
  };
}

function reasonNote(ctx: PolicyContext): string {
  return `The subscriber's reason is "${ctx.reason}"; ${ctx.history.savesLast365d} earlier saves in 365 days`;
}

/** Human-readable lines for the audit log and the dashboard's "explain this decision". */
/** What the subscriber saw on the card: the offer and the policy version it was shown under. */
export interface PresentedOffer {
  offer: Offer;
  policyVersion: number;
}

/**
 * Re-checks a presented offer when the subscriber clicks Accept (#73 review). The card may have
 * sat open for hours: the subscription may have been suspended or cancelled, the 10-day price rule
 * may have stopped holding, or the merchant may have published a new policy. Applying the decision
 * stored at pick time would push an offer the policy now refuses.
 *
 * `ctx` is loaded fresh, with the reason the offer was shown for. Two fields are fixed here so
 * callers can't get them wrong: the offer being accepted *is* the session's one offer, so it
 * doesn't count against itself, and the click is the consent, so cancel intent doesn't apply.
 * Offer terms come from billing dates and plans, not `now`, so if nothing changed the offer
 * recomputes identically and is allowed; if anything changed it is denied with the rule.
 */
export function evaluateAcceptance(
  policy: PolicyDocument,
  ctx: PolicyContext,
  presented: PresentedOffer,
): PolicyDecision {
  const menu: OfferMenu = {
    policyVersion: presented.policyVersion,
    computedAt: ctx.now,
    offers: [presented.offer],
    defaultByReason: NO_DEFAULTS,
    excluded: [],
  };
  const atAccept: PolicyContext = { ...ctx, cancelIntent: false, offersPresentedThisSession: 0 };
  return evaluate(policy, atAccept, presented.offer.id, menu);
}

const NO_DEFAULTS = Object.fromEntries(
  ReasonCategory.options.map((r) => [r, null]),
) as OfferMenu["defaultByReason"];

export function explain(decision: PolicyDecision): string[] {
  const version = `policy v${decision.policyVersion}`;
  if (decision.allowed && decision.offer) {
    return [`Allowed by ${version}: ${describeOffer(decision.offer)}`, ...decision.explanation];
  }
  return [`Denied by ${version}`, ...decision.violations.map((v) => `${v.message} (${v.rule})`)];
}

export function describeOffer(offer: Offer): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const money = (m: { value: string; currency: string }) => `${m.value} ${m.currency}`;
  const day = (iso: string) => iso.slice(0, 10);
  switch (offer.kind) {
    case "pause":
      return `pause for ${plural(offer.cycles, "billing cycle")}, resuming ${day(offer.resumesOn)}`;
    case "downgrade":
      return `downgrade to ${offer.toPlanName} at ${money(offer.newPrice)}`;
    case "switch_annual":
      return `switch to annual at ${money(offer.newPrice)} (${money(offer.effectiveMonthly)} a month)`;
    case "discount":
      return `${offer.percent}% off for ${plural(offer.cycles, "billing cycle")} (${money(offer.newPrice)}) from ${day(offer.firstAffectedBilling)}`;
    case "refund_partial":
      return `refund ${money(offer.amount)} of the payment on ${day(offer.ofPaymentOn)}`;
  }
}
