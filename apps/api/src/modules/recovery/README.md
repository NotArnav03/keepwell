# modules/recovery (owner: Om, M5)

Failed-payment recovery engine (ARCHITECTURE.md §6.9, issue #57).

`RecoveryService.register(events)` subscribes three named handlers: `recovery.payment_failed`, `recovery.payment_completed`, `recovery.status_changed`. `evaluate()` is the `dunning.evaluate` job, `sweepDueWork()` is for the M1 due-work sweep, `sendDunningNow()` is the Judge Mode time machine, `recoveredRevenue()` is the dashboard KPI query.

No LLM is called here. `PersonaliseCopy` is the seam for a later Haiku rewrite (default: identity).

## Not wired yet (needs other modules)

- `DunningStore` Postgres implementation: `dunning_cases` must first match the `DunningCase` contract (state values, outstanding, notification and capture columns). Tests use `InMemoryDunningStore`.
- `SubscriptionSource` (snapshot plus subscriber email; the snapshot has only a hash), `JobQueue` (pg-boss), real `Notifier` (modules/notify), real `ActionEngine`.
- Nothing is registered in `server.ts` until those exist.
