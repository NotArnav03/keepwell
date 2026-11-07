# 0001: A pause ends on a billing date

## Context
Spike Q2 (docs/spikes/Q2.md) measured what PayPal bills when a suspended subscription is activated:
- If no billing time passed while it was suspended, nothing is billed and the schedule is unchanged.
- If one or more passed, PayPal sets `next_billing_time` to **the latest billing time that has passed** and bills **that one cycle**, minutes to hours after activation. The earlier missed cycles are never billed.

So whether a pause "skips" payments depends entirely on *when* it ends, relative to the billing times. A resume just before a billing time is billed for the previous cycle, and then again for the new one a few hours later. A resume just after a billing time is billed once, as that day's normal payment.

## Decision
- **A pause offer ends on a billing time.** `resumesOn` is `nextBilling + c × interval`, which `packages/policy` (`menu.ts`, the `pause` rule) already computes, so a pause of `c` cycles skips exactly `c` payments. The offer card's "pause for c billing cycles, resuming <date>" says exactly that.
- **The resume runs at or after `resumesOn`, never before it.** The engine's `scheduled_resumes.due_at` is `resumesOn` as a full timestamp, time of day included, and the due-work sweep only takes rows whose `due_at <= now`. No code may move a resume earlier than its billing time, except Judge Mode's TIME SHIFT, which is labelled and `simulated`.
- **No offer copy says "free month" or "skip a month"** for a pause. It says how many payments are skipped and when billing restarts.

## Consequences
- **Retries:** a resume that fails and is retried later still bills one cycle at most. It's still after the billing time, so the latest passed one is the same or later.
- **"Next charge" for an activated subscription:** right after a late activation, PayPal's `next_billing_time` is in the past until the catch-up payment lands. The dashboard and portal show it as "due now".
- **paypal-mock** models this (`state.ts`, `activate`). `renew()` stands for the later catch-up charge.
- **Pool restores and Judge Mode's TIME SHIFT** may bill the pool buyer one cycle of sandbox money when a billing time passed during the pause. That's acceptable.

## Status
Accepted, 2026-11-06. Evidence: `packages/paypal-mock/fixtures/spikes/q2/*.json`.
