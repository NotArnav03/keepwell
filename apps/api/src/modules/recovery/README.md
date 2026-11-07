# modules/recovery (owner: Om, M5)

Failed-payment recovery engine (ARCHITECTURE.md §6.9, issue #57).

## How it runs

`mountRecovery()` (called from `platform.ts`, before the workers start) wires it in:

- Handlers `recovery.payment_failed`, `recovery.payment_completed`, `recovery.status_changed` on `DbDomainEvents`.
- A worker for the `dunning.evaluate` job (queued in the same transaction as the case change).
- `sweepDueWork()` registered as the reconciler's due work (`recovery.dunning`): a case whose message time has passed with no message queued (a lost job) is evaluated again.
- Every query runs in `db.forMerchant`; every side effect writes an audit entry in the same transaction. The capture is a `capture_outstanding` Action (origin `recovery`) through the ActionEngine.

Other entry points: `sendDunningNow(merchantId, subscriptionId)` for Judge Mode's time machine (message due now, `simulated: true` on the audit entry, replaces a message still waiting), and `recoveredRevenue(tx, merchantId, range)` for the dashboard KPI (SQL sum of `numeric`, decimal-string Money per currency).

## Decisions worth knowing

- **Email:** we store only a hash of the subscriber's email (§10), so `PgSubscriptionSource.email()` asks PayPal when a message is actually needed, outside any transaction.
- **Replanned messages:** a newer failure, recovery, cancellation or the time machine calls `Notifier.supersede` on the message still waiting.
- **No LLM** is called. `PersonaliseCopy` is the seam for a later Haiku rewrite (default: identity); facts always come from the snapshot.
- **A voluntary pause is not a dunning suspension.** `subscription.status_changed` only says the status moved to `SUSPENDED`. `dunning.reactivate` is sent when both of these are true: there is no `suspend` Action on that subscription in `APPLIED` or `CONFIRMED` with an origin other than `recovery` and `updated_at` inside `VOLUNTARY_SUSPEND_WINDOW_MS` (15 minutes), and the snapshot shows `failedPaymentsCount > 0` or an outstanding balance above zero. `updated_at` is when the engine last moved the Action, which for those two states is when the suspend took effect. Fifteen minutes covers a delayed webhook and one slow sweep; an older pause cannot hide a later threshold suspension. A suspend whose origin is `recovery` stays on the dunning path, so recovery cannot hide a threshold event behind its own Action.

When the Action matches, the open case is **left open**. It is not moved to `suspended` and it is not closed. PayPal's `failed_payments_count` counts consecutive failures, and a merchant suspend does not clear it (the mock's `suspend()` leaves the counter; the next failed charge increments it). `onPaymentFailed` updates a case only while its state is `open` and the new count is strictly higher, so the failure after they resume replans this same case. Moving it to `suspended` would drop that event: the update requires `open`. Closing it would also drop recovered revenue when the charge after resume succeeds, because a payment with no open case is an ordinary renewal. The queued reminder stays; a higher failure withdraws and replans it, and a successful payment withdraws it on recovery. The audit kind is `dunning.voluntary_suspend`. A replay of the same status event does not append that note again.

A `SUSPENDED` change whose snapshot shows neither a failed payment nor a balance above zero is left open as well, with no reactivation email. A snapshot that has not caught up can still be advanced by a later `payment_failed`.

## Not done yet

- `platform.ts` passes the real `Notifier` from `modules/notify` (`core.notify.notifier`), including `supersede`, which withdraws a still-queued message in the caller's transaction.
