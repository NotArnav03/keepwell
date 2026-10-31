# modules/actions (owner: Arnav, M1)

The action engine (ARCHITECTURE.md §6.4). Every change to PayPal is an Action that moves through `ACTION_TRANSITIONS` (from `@keepwell/contracts`). Each move is checked, audited and emitted as `action.state_changed`, in one transaction.

```ts
// Inside the caller's transaction, e.g. the sessions module's accept:
await db.forMerchant(merchantId, async (tx) => {
  const pause = await engine.create({ merchantId, subscriptionId, type: "suspend", origin: "session",
    params: { reason: "Paused at the subscriber's request" }, idempotencyKey: `${sessionId}:${offerId}` }, tx);
  await engine.scheduleResume({ merchantId, subscriptionId, dueAt: offer.resumesOn, afterActionId: pause.id }, tx);
});
```

| Rule | How |
|---|---|
| One Action at a time per subscription | A session advisory lock on the subscription id, held across the PayPal call. If the process dies, Postgres releases it. A second worker gets `"busy"`. |
| Read-before-retry | A retry first GETs the subscription. If PayPal already shows the target status, the Action is APPLIED with no second call. A 422 is checked the same way, e.g. cancelling something already cancelled. |
| Retry budget | 8 attempts: waits of 30 s, 1, 2, 4, 8, 15 and 15 min (±20% jitter), then FAILED with `RETRIES_EXHAUSTED`. |
| Cancel pre-empts | Creating a cancel supersedes the subscription's PENDING, RETRY_WAIT and AWAITING_BUYER Actions and cancels its pending resumes. An EXECUTING one holds the lock and finishes first. |
| Pause saga | Suspend + `scheduleResume({ afterActionId })` in one transaction. The resume is `waiting` until the suspend is APPLIED, `scheduled` after, and `cancelled` if the suspend fails or is superseded. So a pause never loses its resume, and a failed pause never leaves one. |
| A worker that dies mid-call | `recoverStuck()` moves EXECUTING Actions with no lock holder back to RETRY_WAIT. The next `execute()` reads PayPal before deciding (tested by killing a real worker process mid-call). |
| Confirmation | `confirm()`: APPLIED → CONFIRMED once PayPal shows the target status. If it still doesn't after 15 minutes, FAILED with an error log for the alert. |
| A failed cancel | Logged as an error. The subscriber is shown PayPal's autopay page (§6.4). |

Worker methods, which the jobs call (pg-boss wiring comes with the jobs module):

| Method | Job |
|---|---|
| `execute(merchantId, actionId)` | `action.execute` |
| `due()` | due-work sweep: PENDING, and RETRY_WAIT whose wait is over |
| `recoverStuck()` | due-work sweep |
| `confirm(merchantId, actionId)` | `action.confirm` |
| `confirmFromSync(merchantId, snapshot)` | the `subscription.synced` handler: confirms from a webhook or sweep with no extra PayPal call |
| `completeRevise(merchantId, actionId, cancelled)` | `GET /v1/revise/return` (`revise-return.ts`), where PayPal sends the buyer back |
| `abandonStaleApprovals()` | due-work sweep: revises nobody approved within 3 h become ABANDONED |
| `runDueResumes()` | `resume.due`: resumes whose time has come become activate Actions (idempotency key `resume:<id>`) |

## The types (`plans.ts`)

How each type runs, and how its effect is read back from PayPal (ARCHITECTURE.md §6.1):

| Type | Call | Already done when… | Retry safety |
|---|---|---|---|
| `suspend` / `activate` / `cancel` | `POST …/suspend` etc. | status is SUSPENDED / ACTIVE / CANCELLED | read-before-retry |
| `revise` | `POST …/revise` → **AWAITING_BUYER** with `approveUrl` | `plan_id` is the target plan | read-before-retry; a re-run only makes a fresh link |
| `patch_price` | `PATCH` the `fixed_price` (`null` = back to the plan price) | the next cycle's price (seen with `fields=plan`) is the target | read-before-retry, and the PATCH is idempotent anyway |
| `refund` | `POST /v2/payments/captures/{id}/refund` | — | `PayPal-Request-Id` = Action id (spike Q1: a replay answers 200 with the first refund) |
| `capture_outstanding` | `POST …/capture` | — | `PayPal-Request-Id` = Action id |
| `create_plan` | `POST /v1/billing/plans` (no subscription) | — | `PayPal-Request-Id` = Action id |

A revise is decided by PayPal's truth, never by the redirect. The buyer's return reads the subscription: the new plan means APPLIED then CONFIRMED, and a cancel with no change means ABANDONED. A buyer who approves and closes the tab is caught by the next sync (`confirmFromSync`). Refund, capture and create plan have no subscription state to wait for, so a 2xx under our request id goes straight to CONFIRMED.

The tests run against a real Postgres (row-level security, advisory locks) and paypal-mock over HTTP: `KEEPWELL_TEST_DATABASE_URL`, or CI's database job.
