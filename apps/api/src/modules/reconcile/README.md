# modules/reconcile (owner: Arnav, M1)

PayPal is the source of truth, and this module keeps our copy of it right (ARCHITECTURE.md §6.3, §11).

- **`sync.ts`, `SubscriptionSync`:** GET a subscription, store our snapshot, and emit domain events from the diff. Both the webhook pipeline and the reconciler use it. See `modules/webhooks/README.md` for which events come from which differences.
- **`reconciler.ts`, `Reconciler`:** the safety net for missed webhooks and lost jobs.
- **`ops.ts`:** `GET /status` and `GET /ops`.

## The schedule: one cron job, `due.sweep`, every minute

| When | What | Job it enqueues |
|---|---|---|
| every minute | Actions to run or retry (`engine.due()`), lost workers' Actions (`recoverStuck`), resumes that came due, revise links nobody used, and APPLIED Actions more than 2 min old to confirm | `action.execute`, `action.confirm` |
| every minute | due work other modules register (`registerDueWork`), e.g. dunning and win-back sends. A failing module is logged and the others still run. | (theirs) |
| every 2 minutes | **hot loop:** subscriptions with an Action in flight, or one that moved this hour | `reconcile.subscription` |
| every 30 minutes | **sweep:** per merchant, `GET /v1/billing/subscriptions?status_updated_after=<last sweep − 5 min>`, then sync each one | `reconcile.sweep` |
| 03:00 UTC | **drift report:** per merchant, every live subscription compared with PayPal *before* it is re-synced. Stored in `drift_reports`. **Target: zero.** | `reconcile.drift` |

Every job has an idempotency key (a minute, a 30-minute window, a UTC day), so a slow run or a second instance never doubles the work.

## Status and ops

- **`GET /status`** (public, Judge Mode shows it), cached 30 s: `operational | degraded | down`, with components:
  - `database`, `paypal` (an OAuth or call check, when wired);
  - `webhooks` (average lag in the last hour, rejected signatures);
  - `reconciler` (last sweep, current drift).

  It's degraded when drift isn't zero, the sweep is more than 90 min old, or webhook lag is over 5 min. It never names a merchant.
- **`GET /ops`** (`Authorization: Bearer $OPS_TOKEN`, and 404 when no token is configured): webhooks by status and Actions by type and state for the last 24 h, the Action success rate, and the latest drift report per merchant.
