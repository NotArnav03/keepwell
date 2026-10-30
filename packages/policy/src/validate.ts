import type { PlanInfo, PolicyDraft, PolicyProblem } from "@keepwell/contracts";
import { sameInterval, toCents } from "./units.js";

const MONTH = { unit: "MONTH", count: 1 } as const;
const YEAR = { unit: "YEAR", count: 1 } as const;

/**
 * Checks a draft against the merchant's plan catalogue before it is published: what zod can't see.
 * computeMenu already skips bad targets at runtime; this tells the merchant at publish time instead
 * of leaving an offer silently missing. Only enabled offers are checked, so a merchant can keep a
 * half-finished setup switched off. An empty list means the draft can be published.
 */
export function validatePolicy(draft: PolicyDraft, plans: readonly PlanInfo[]): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  const add = (path: string, message: string) => problems.push({ path, message });
  const byId = new Map(plans.map((p) => [p.planId, p]));
  const { downgrade, switch_annual, refund_partial } = draft.offers;

  if (downgrade.enabled) {
    for (const [fromId, targets] of Object.entries(downgrade.targets)) {
      const path = `offers.downgrade.targets.${fromId}`;
      const from = byId.get(fromId);
      if (!from) {
        add(path, `${fromId} isn't one of your plans`);
        continue;
      }
      targets.forEach((toId, i) => {
        const to = byId.get(toId);
        const at = `${path}.${i}`;
        if (!to) add(at, `${toId} isn't one of your plans`);
        else if (to.planId === from.planId) add(at, `${from.name} can't move down to itself`);
        else if (to.price.currency !== from.price.currency || !sameInterval(to.interval, from.interval)) {
          add(at, `${to.name} must bill in the same currency and interval as ${from.name}`);
        } else if (toCents(to.price) >= toCents(from.price))
          add(at, `${to.name} isn't cheaper than ${from.name}`);
      });
    }
  }

  if (switch_annual.enabled) {
    for (const [fromId, toId] of Object.entries(switch_annual.targets)) {
      const path = `offers.switch_annual.targets.${fromId}`;
      const from = byId.get(fromId);
      const to = byId.get(toId);
      if (!from) add(path, `${fromId} isn't one of your plans`);
      else if (!to) add(path, `${toId} isn't one of your plans`);
      else if (!sameInterval(from.interval, MONTH)) add(path, `${from.name} isn't billed monthly`);
      else if (!sameInterval(to.interval, YEAR)) add(path, `${to.name} isn't billed yearly`);
      else if (to.price.currency !== from.price.currency) {
        add(path, `${to.name} bills in a different currency from ${from.name}`);
      } else if (Math.floor(toCents(to.price) / 12) >= toCents(from.price)) {
        add(path, `${to.name} isn't cheaper per month than ${from.name}`);
      }
    }
  }

  const refundCurrency = refund_partial.maxPerMonth.currency;
  if (refund_partial.enabled && !plans.some((p) => p.price.currency === refundCurrency)) {
    add("offers.refund_partial.maxPerMonth", `None of your plans bill in ${refundCurrency}`);
  }

  return problems;
}
