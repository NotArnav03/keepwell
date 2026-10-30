# @keepwell/policy

The pure policy engine (ARCHITECTURE.md §6.6). The AI can only offer what `computeMenu` returns, and `evaluate` re-checks its pick before anything reaches PayPal. No I/O, no clock reads, no randomness, so the API, the dashboard's dry-run, the evals and the MCP servers all get the same answer.

```ts
import { computeMenu, evaluate, evaluateAcceptance, explain } from "@keepwell/policy";

const menu = computeMenu(policy, ctx);                 // OfferMenu: concrete offers + why others are excluded
const decision = evaluate(policy, ctx, offerId, menu); // PolicyDecision: allowed? which rule said no?
explain(decision);                                     // lines for the audit log

// At Accept: re-check what the card showed against fresh truth, never the stored decision.
evaluateAcceptance(policy, freshCtx, { offer, policyVersion });
```

**Accept re-checks.** A card can sit open for hours. `evaluateAcceptance` recomputes the menu from a freshly loaded context (with the reason the offer was shown for) and allows the offer only if the policy still offers it with the same terms under the same policy version. It treats the accepted offer as the session's one offer and the click as consent, so callers don't have to adjust `offersPresentedThisSession` or `cancelIntent`.

## What the menu contains

| Kind | Offered as | Needs |
|---|---|---|
| `pause` | 1, 2 and 3 cycles, plus the policy's `maxCycles` (ids `pause-N`) | a next billing date; outside `cooldownDays` of the last pause |
| `downgrade` | one offer per target plan (`downgrade-<planId>`) | target in the catalogue, same currency and interval, cheaper than what the subscriber pays now |
| `switch_annual` | `switch_annual-<planId>` | monthly subscription, 1-year target in the same currency, cheaper per month (rounded down) |
| `discount` | `maxPercent` for `maxCycles` (`discount-N`), price rounded down | tenure ≥ `minTenureDaysForDiscount`; no discount already active; next billing ≥ 10 days away; price above 0.00 |
| `refund_partial` | `refund_partial` | a last payment ≤ 180 days old; amount = min(`maxPercentOfLastPayment`, what's left of `maxPerMonth` over 30 days, plan price); all in one currency |

## Rules that empty the whole menu

Checked first, in this order: the subscriber said cancel → an offer was already shown this session → the subscription isn't `ACTIVE` (these three are built in; no merchant can turn them off) → the merchant's `maxSavesPerSubscriberPer365d` is reached. The 10-day price rule and "never above the plan price" are built in too. A violation names its rule id (`RULE` in `src/rules.ts`), e.g. `builtin.price_change_min_days`.

## Reason rankings are allowlists

`reasonPreferences[reason]` (or `DEFAULT_REASON_PREFERENCES` when the merchant doesn't set one) ranks the kinds offered for that reason. Kinds not listed are not offered, and `"none"` ends the list. By default a missing feature gets no offer, and an unknown reason allows every kind, which is what a session starts with. `defaultByReason` (the L1 fallback) only points at offers on the menu.

## Tests

`pnpm --filter @keepwell/policy test` runs unit tests for every rule plus fast-check properties over random policies and subscribers (1,000 runs each), with **100% coverage enforced**. Never weaken a property to make a change pass.

Assumptions to confirm: the 10-day rule in sandbox (spike Q4, #19) and the 180-day refund window (spike Q1).
