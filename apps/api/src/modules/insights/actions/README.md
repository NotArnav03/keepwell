# modules/insights/actions (owner: Om, M5)

Insight-to-action (ARCHITECTURE.md §6.12). The copilot proposes; a merchant approves. Nothing runs before that click. PayPal is only touched through the ActionEngine.

`executed` on a `create_plan` row means an engine Action was created. That Action is still `PENDING` when approval returns, and PayPal can reject it later (`FAILED`) while the insight action stays `executed`. There is no extra insight-action state for this.

## `execution` (read-only)

Getting or listing an insight action adds `execution` to the response. It is derived, not stored. A list is one left join of `actions` on `insight_actions.action_id`, so every row is the same snapshot and the list does not query once per row.

```ts
{ status: "pending" | "confirmed" | "failed" | "not_applicable", error?: { code, message } }
```

| Engine Action | `execution` |
|---|---|
| `PENDING`, `EXECUTING`, `RETRY_WAIT`, `AWAITING_BUYER`, `APPLIED` | `{ status: "pending" }` |
| `CONFIRMED` | `{ status: "confirmed" }` |
| `FAILED`, `ABANDONED`, `SUPERSEDED` | `{ status: "failed", error? }` using the Action's error when it has one |
| no `actionId`, or the Action row is not visible to this merchant | `{ status: "not_applicable" }` |

`update_policy` and `send_winback_batch` do not create an engine Action, so they are `not_applicable`. A queue should read `execution.status` before treating a `create_plan` as a success. `APPLIED` is still pending: confirmation is a later read of PayPal.

## Win-back batches

`WinbackBatchSender.send` returns `{ queued, skipped: { subscriptionId, reason }[] }`. Approval writes those counts on the `insight_action.executed` or `insight_action.failed` audit entry (the stored execution result). There is no result column on `insight_actions`.

`queued === 0` is `failed`, not `executed`. The row's `error` is `no subscription could be messaged: <id> (<reason>); ...`, and the audit payload also has `queued` and `skipped`.

`WinbackStartBatchSender` (adapters.ts) is the real sender. It calls the win-back module's `startBatch(merchantId, subscriptionIds)` through the small `WinbackBatchStarter` interface (so this module does not import win-back internals; `WinbackService` satisfies it). `startBatch` opens a due-now case for each CANCELLED subscription and queues the normal start, skips everything else with a reason (`not_cancelled`, `already_sent`, ...), is idempotent and capped at 500, so its `{ queued, skipped }` are the true numbers recorded on approval. The platform wiring passes the `WinbackService` that `registerWinback` returns.
