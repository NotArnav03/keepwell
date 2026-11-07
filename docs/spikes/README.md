# Spikes

One file per day-1 question (`Q1.md` … `Q10.md`; the list is in ARCHITECTURE.md §13).

Template:

```
# Qn: <question>
Owner: <name> · Date: <yyyy-mm-dd>

## Answer (one paragraph)
## Evidence (requests and responses with secrets removed; PayPal-Debug-Id values)
## Impact on the design (link the ADR if one was needed)
## Fixture saved to packages/paypal-mock? yes/no
```

## Running the sandbox spike (Q2, and the gateway's assumptions)

`pnpm spike <step>` runs the gateway against the PayPal sandbox and saves every response, scrubbed, under `packages/paypal-mock/fixtures/spikes/`. It needs `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in `.env` for a sandbox REST app on a **US** business account. Add `--mock` to try any step against `pnpm dev:paypal-mock` instead.

| Step | What it does |
|---|---|
| `setup` | Makes a $1.00/day plan once, creates a subscription and prints its approval link. Approve it in a browser as the US **personal** sandbox account; the script waits until it is ACTIVE. |
| `status` | The subscription's billing fields and its transactions. |
| `quick` | Suspend, activate 10 s later, watch billing for a minute: a pause that crosses no billing date. |
| `pause`, then `resume` | Suspend now, activate after the next billing time has passed: what PayPal does with the missed cycle. |
| `price [0.50]` | Spike Q4: PATCHes the subscription's `fixed_price` while the next billing is inside PayPal's 10-day window (always the case on this daily plan). Then `status` after the next billing time, and again a day or two later: the transactions show which charge first used the new price, or that none did. |
| `list` | Whether `GET /v1/billing/subscriptions` (the reconciler's sweep) works, by plan and by `status_updated_after`. |
| `cancel` | Cancels the spike subscription so the daily $1.00 sandbox charge stops. Irreversible; `setup` makes a new one. |

The subscription id lives in `.spike/sandbox.json` (gitignored). Read the saved fixtures before committing them; the scrubber replaces emails, payer and merchant ids, addresses, buyer names and approval tokens.
