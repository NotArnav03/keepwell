# modules/pool (owner: Arnav, M1)

The judge pool (ARCHITECTURE.md §6.17): pre-approved sandbox subscriptions that Judge Mode lends to judges, who arrive with no PayPal buyer of their own. Judge Mode (M3) uses it through the `JudgePool` contract; tests use `FakeJudgePool`.

| Call | What happens |
|---|---|
| `lease(merchantId, { minutes? })` | The available ACTIVE subscription that has gone longest without a judge, for 30 minutes by default. One returned in the last 10 minutes (a widget token's lifetime) waits, so a token minted just before the return can't reach the next judge. `SKIP LOCKED`, so judges arriving together never share one. `null` when none is available. |
| `holds(merchantId, poolEntryId, leasedUntil)` | Whether that exact lease is still live. Entries are lent again and again, so a lease is the pair (entry, `leasedUntil`, whole seconds); Judge Mode checks it on every request a lease token makes, so a returned lease's token reaches nothing. |
| `release(merchantId, poolEntryId, leasedUntil?)` | With `leasedUntil`, only while that lease is live (otherwise `null`, and nothing changes). Re-reads the subscription from PayPal, then: cancelled, expired or on another plan → `consumed`; paused → an `activate` Action; discounted → a `patch_price` Action back to the plan price (both → `restoring`); otherwise `available`. Pending resumes from the judge's pause are cancelled, so they can't fire on the next judge. |
| `enroll(merchantId, paypalSubscriptionId)` | Adds an ACTIVE subscription on the pool's plan (Standard). Pool refill calls it. |
| `health()` | The `pool.health` job, every 5 minutes: expired leases come back, restores finish, and fewer than 40 available is an error log (Sentry's alert). |

A restore is tried once per lease (the idempotency key carries the lease). If PayPal refuses it, the entry is consumed rather than lent out broken. Every lease, return and enrolment is in the audit log (`pool.*`).
