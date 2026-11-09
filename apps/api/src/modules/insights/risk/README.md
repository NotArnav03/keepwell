# modules/insights/risk (owner: Om, M5)

The churn-risk score (ARCHITECTURE.md §6.12, X5). It is a **transparent heuristic, not a trained model**: a hand-set weighted sum over signals PayPal and our own database already hold. No LLM, no randomness; the same inputs always give the same number, and every point is shown with its reason.

- `scoreChurnRisk(signals)` (`score.ts`) is a pure function returning `{ score, band, factors }`. Score is an integer 0 to 100 (the points are summed and clamped); bands are low (under 25), medium (25 to 49) and high (50 and up).
- `listAtRisk(db, merchantId, { limit, minScore })` (`query.ts`) loads the signals for ACTIVE and SUSPENDED subscriptions with one fixed query inside `db.forMerchant`, scores them, and returns `AtRiskItem[]` sorted by score. The subscriber is a subscription id and a first name only. Defaults: limit 50 (max 200), minScore 25. This is what the dashboard list and the merchant MCP tool `list_at_risk` call.
- `AtRiskItem` is **a proposed contract**: CONTRACTS.md names `list_at_risk` but not its shape, so it lives here until adopted.

| Factor                                  | Points                                       | Why                                                                                            |
| --------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Failed payments                         | 12 each, up to 3                             | The strongest PayPal-visible warning; capped so a long dunning tail doesn't hide other signals |
| Recent failure                          | +8 if within 7 days, +4 within 30            | A fresh failure is unresolved                                                                  |
| Unpaid balance                          | +8                                           | PayPal could not collect money                                                                 |
| Payment overdue                         | +6 at 1.25 cycles, +12 at 2 cycles           | Judged against the billing interval, so a yearly plan isn't penalised                          |
| New subscriber                          | +12 under 30 days, +8 under 90, +4 under 180 | Early-life cancellation                                                                        |
| Paused / downgraded / discounted before | 6 / 7 / 5 each, up to 2                      | They already used a retention offer, so they weigh the cost                                    |
| Plan just changed                       | +8 within 30 days                            | The subscription is in flux                                                                    |
| Suspended                               | +15                                          | Billing already stopped                                                                        |
| Renewal imminent                        | +4 within 3 days                             | A charge is when people cancel; weak on its own                                                |

"Prior saves" count APPLIED or CONFIRMED pause, revise and discount actions that came from a session or insight, not dunning's own suspends. The weights are judgement calls in `RISK_WEIGHTS`, not fitted to data; expect to tune them against real outcomes.
