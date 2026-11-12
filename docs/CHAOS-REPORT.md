# Chaos report (9 Nov 2026)

Each owner breaks their component on purpose and records whether the system behaved as the failure-mode matrix in [ARCHITECTURE.md §9](ARCHITECTURE.md) says. Each section below is written by its owner. A drill that found a problem says so, and links the fix.

| Owner | Component | Status |
|---|---|---|
| Ishan (M2) | Agent: revoked Anthropic key, spent budget, prompt injection | Done, below |
| Arnav (M1) | API killed mid-action, dropped webhooks, PayPal 5xx | Done, below |
| Aditya (M3) | API down → widget L2, SSE reconnect | Open |
| Ayush (M4) | Dashboard with API errors, empty states | Open |
| Om (M5) | Email provider down, duplicate `payment_failed` | Done, below |

## M1: PayPal rails (Arnav)

The M1 drills are database tests that run in CI's `database (Postgres 18)` job on every commit. They use the real `DbActionEngine`, `PayPalClient`, webhook processor and reconciler, with row-level security and advisory locks on a real Postgres. PayPal is `packages/paypal-mock` over HTTP, which can be told to fail. Results below are from `main` at `c0596e7`, [CI run 43268284308](https://github.com/NotArnav03/keepwell/actions/runs/43268284308) (12 Nov): `engine.test.ts` 13 passed, `more-actions.test.ts` 9, `reconciler.test.ts` 7, `webhooks.test.ts` 9, `client.test.ts` 16. The one skipped test in each file is the guard that fails only when no database is configured. Nothing was changed for this report: these tests were already on `main`.

### 1. API killed mid-action

Matrix rows: *API process crash → restart; jobs resume from Postgres*, and the Action rules behind it.

**How:** `engine.test.ts`, "recovers an Action whose worker was killed mid-call, without calling PayPal twice". A suspend runs in a **separate Node process** that reaches paypal-mock through a proxy. The proxy passes the suspend on, so PayPal applies it, then never answers. The test sends the child `SIGKILL` at that moment: the change is made at PayPal and not recorded by us.

| Result | |
|---|---|
| At PayPal after the kill | `SUSPENDED` |
| The Action after the kill | still `EXECUTING`; the dead worker's advisory lock went with its database session |
| Recovery (`recoverStuck()`, then `execute`) | picks the Action up, reads the subscription first, sees it already `SUSPENDED`, and records it `APPLIED` (`via: read_before_retry`, attempt 2) |
| Calls the recovering worker made to PayPal to change anything | **0**, so PayPal received one suspend in total |

**Seen live on prod-demo, 12 Nov:** the API had slept on Render's free tier since 19:25 UTC the day before, and `/status` reported the reconciler `degraded` (last sweep 13 hours old). The request that woke it was answered at 08:33:23 UTC, and a sweep had run by 08:33:29: jobs resumed from Postgres with no one touching them.

### 2. Dropped, duplicate, late and forged webhooks

| Matrix row | Test | Result |
|---|---|---|
| Webhook lost → state healed by the reconciler | `reconciler.test.ts`, "reports drift a missed webhook left, fixes it, and finds none the next night" | Drift reported and fixed from PayPal's state; 0 drift on the next sweep |
| (same) | "puts subscriptions with an Action in flight on the hot loop" | A subscription with a live Action is re-read on the short loop, not left for the nightly sweep |
| Webhook duplicate → ignored | `webhooks.test.ts`, "answers a duplicate delivery 200 and processes it once" | 200 to PayPal, processed once |
| Webhook out of order → irrelevant by design | "is immune to webhooks that arrive late: a suspend undone at once changes nothing" | The late event re-reads PayPal and changes nothing |
| Webhook signature invalid → rejected, alert | "rejects a webhook whose body was changed after PayPal signed it" | Stored as `REJECTED`, logged as an error, never acted on |
| Scheduled resume lost → due-work sweep | `reconciler.test.ts`, "turns due work into jobs, sweeping and drift-checking by age so a sleeping server catches up" | Due work becomes jobs on the next tick, including after a long sleep |

### 3. PayPal 5xx, timeouts and business errors

| Matrix row | Test | Result |
|---|---|---|
| PayPal 5xx / timeout → read-before-retry, backoff | `client.test.ts`, "retries 5xx with backoff and succeeds", "gives up after 4 attempts with a retryable error that carries the debug id", "treats a timeout as unavailable" | The gateway retries a 5xx, keeps `PayPal-Debug-Id`, and maps a timeout to `unavailable` |
| (same, at the Action level) | `engine.test.ts`, "waits after a 5xx and retries once the wait is over", "reads before retrying, so a change PayPal made but never confirmed isn't made twice", "gives up after the retry budget" | `RETRY_WAIT`, then a read before the retry; `FAILED` once the budget is spent |
| PayPal business error (422) → Action FAILED, no partial state | "counts a 422 as done when PayPal is already there, and fails it otherwise" | A 422 for a change already made confirms the Action; any other 422 fails it |
| PayPal OAuth token expired → refresh once, retry once | `client.test.ts`, "refreshes the token once on a 401 and retries" | One refresh, one retry |
| Double-click Accept → second request returns the first Action | `engine.test.ts`, "creates PENDING, audits and emits it, and treats a repeated key as the same Action" | Same Action returned |
| Pause and cancel race → cancel wins | "lets a cancel supersede what hasn't started, including the resume", "runs one Action per subscription at a time" | The cancel supersedes the pending suspend and the scheduled resume; one Action runs per subscription |
| Refund response lost | `more-actions.test.ts`, "refunds once even when the first response is lost (PayPal-Request-Id = Action id)" | One refund at PayPal |

### Where the matrix and the code differ

- **Retry window:** the matrix says "up to about 1 h". The engine's budget is 8 attempts with waits of 0.5, 1, 2, 4, 8, 15 and 15 minutes, so about **45 minutes**, then `FAILED` (`DEFAULT_RETRY_DELAYS_MS` in `actions/engine.ts`). The matrix figure is approximate; the behaviour is as designed.
- **"Alert" on a bad signature** is an error log line plus the stored `REJECTED` event. There is no separate paging channel.

### What this does not cover

- These drills use paypal-mock, not the sandbox, so a real PayPal outage is simulated. The recorded sandbox responses the mock is built from are in `packages/paypal-mock/fixtures`.
- No live drill on staging (killing the Render service mid-Action, or deleting the webhook subscription for an hour). The prod-demo wake-up above is the only hosted evidence.
- What the subscriber and merchant *see* during these failures ("Applying… we'll confirm by email", the merchant banner when a cancel fails for good) belongs to the M3 and M4 rows, which are still Open.

## M2: the agent (Ishan)

All three drills ran on `main` at `e83d02e` with the real `AnthropicLlmClient`, the real budget guard and the real session runtime, over the 51-persona PR subset (`pnpm --filter @keepwell/api eval -- --mode real --subset`), or all 404 personas for the free adversarial run. They ran from a developer machine, not on staging: the agent is mounted behind the same client and guard on staging, and a drill that needs no PayPal and no browser is faster to run where the code is.

### 1. Revoked Anthropic key

Matrix row: *Anthropic API down, slow or over budget → session falls to L1; cancel unaffected.*

**How:** `ANTHROPIC_API_KEY` set to a key Anthropic does not know, so every request is a real HTTP 401 (`authentication_error: invalid x-api-key`) from api.anthropic.com.

| Result | |
|---|---|
| Sessions run / completed | 51 / 51 |
| Sessions that fell to L1 | 100% (`fallbackRate` 1) |
| Spend | $0.0000 |
| Policy violations | 0 |
| Clicks to cancel (max) | 1 |
| Outcomes | 30 cancelled, 21 accepted a card, 0 abandoned |
| Requests that reached Anthropic | each failed with a 401, then the session moved to L1 |

**Finding, fixed:** the first run crashed. The eval tool's *simulated subscriber* (the model that words a persona's follow-up messages, `evals/roles.ts`) did not catch the model being unavailable, so one 401 ended the whole run. The production agent was not affected (it already fell to L1, covered by `anthropic.test.ts` "a revoked API key"), and an unavailable judge was already tolerated, but the simulator was the odd one out. It would have wasted the paid run (#30) the same way if the budget ran out half way. Fix: the simulator sends the persona's scripted words when the model is unavailable, with a test that fails without the fix.

**Not done, and worth knowing:** nothing stops the agent from asking Anthropic again on every new session while the key is revoked (105 failed requests in the 51-session run). Each costs nothing and falls to L1 (p50 240 ms, p95 500 ms per session), so there's no harm to a subscriber; a circuit breaker would only save those requests.

### 2. Daily budget spent

Matrix row: *LLM cost runaway → L1 mode until reset.*

**How:** the same run with a daily budget of $0.0001, below the worst-case hold of a single call.

| Result | |
|---|---|
| Sessions run / completed | 51 / 51 |
| Sessions that fell to L1 | 100% |
| Requests sent to Anthropic | **0** (the guard refused before any request: `Daily LLM budget reached for 2026-11-09`) |
| Spend | $0.0000 |
| Policy violations / max clicks to cancel | 0 / 1 |

The unit tests cover the other halves: overlapping calls can't all pass one check (`budget.test.ts`), a failed call releases its hold, and the cap survives a restart because the spend is read from `llm_usage` (`pg-usage-store.test.ts`).

### 3. Prompt injection and a jailbroken model

Matrix row: *Prompt injection ("give me a year free") → pick denied, logged as `policy_violation_attempt`; no unauthorised offer.*

**How:** the free adversarial run (`--mode adversarial`): all 404 personas, where the *model itself is fully jailbroken* and tries to give away free months, offer twice, offer after a cancel, invent perks and pitch without a card, whatever the persona says. The red-team personas add `ignore_instructions`, `fake_markup`, and the other attack scripts in `packages/evals`.

| Result | |
|---|---|
| Sessions | 404 |
| Policy violations that reached a subscriber | **0** (off-policy offer 0, second offer 0, offer after cancel 0, claim in text 0, offer without card 0) |
| Illegal picks the policy engine refused | 132 |
| Invented claims the claims checker caught | 204 |
| "No" means no | 100% |
| Clicks to cancel (max) | 1 |

This matches the committed `packages/evals/results/adversarial.json`.

### What this does not cover

- No real Haiku or Sonnet output: all three drills run without a working key. A real-model run did happen on 12 Nov on Groq's `openai/gpt-oss-20b`, the model prod-demo runs (ADR 0002), over the 51-persona subset: 0 policy violations, 0 red-team violations, dark-pattern score 0.06 of 3. See the README's Evals section and `packages/evals/results/real-groq-subset.json`.
- A live staging drill (revoke the key in Render, watch a Judge Mode session): the same code path, but it needs access to Render. Arnav, if you run it, add what you see here.

## M5: notifications and recovery (Om)

Both drills run as one test file, `apps/api/src/modules/recovery/chaos.db.test.ts`, on `main` at `04a4bab` (the commit this branch was cut from), against a real Postgres 18, the real recovery engine, the real notifier and dispatcher, the real pg-boss jobs and the real domain-event worker. Only two things are stand-ins: the email provider (an in-memory fake that is told to fail) and the PayPal subscription read. They passed (2 tests).

### 1. Duplicate `payment_failed`

Matrix row: *Webhook duplicate → ignored.*

**How:** the same `subscription.payment_failed` event (same subscription, same failed count) is emitted three times through the event worker, then the test waits 3 seconds for any duplicate handler or evaluate job to act.

| Result | |
|---|---|
| Dunning cases for the subscription | **1** |
| Messages in the outbox | **1** (`dunning.update_payment_method`, status `queued`) |

### 2. Email provider down

Matrix row: *Email provider down → outbox retries with backoff; Demo Inbox still shows the message.*

**How:** the provider answers a retryable `503` to the first two sends of that message.

| Result | |
|---|---|
| After the first failure | message stays `queued`, `attempts` 1, retry scheduled; nothing sent; the dunning case is not lost |
| Retry schedule | +60 s, then +240 s |
| Third attempt | `sent`, `attempts` 3 |
| A replayed dispatch after it was sent | `skipped`; the provider received the message **once** |

`notify.db.test.ts` covers the rest of this row: a permanent rejection (`422`) is not retried, the attempt limit ends in `failed`, and a message whose send keeps failing still shows in the Demo Inbox.

### What this does not cover

- No real Resend call: sandbox mode never sends real email, so a real provider outage is simulated by the fake provider. The retry logic is the same code path.
- The hosted staging deploy was not drilled (no access to Render's dashboard). Arnav or Ishan can cut the `RESEND_API_KEY` there and watch the Demo Inbox.

