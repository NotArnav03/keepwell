# @keepwell/paypal-mock (owner: Arnav, M1)

A fake PayPal REST API, so nobody needs sandbox credentials to build or test. Same paths, status codes, error bodies (`name`, `details[].issue`, `debug_id`) and `PayPal-Debug-Id` headers as PayPal. State lives in memory and starts from the Pantry Plan fixtures (CONTRACTS.md §6).

```bash
pnpm dev:paypal-mock        # http://localhost:4010, webhooks delayed 2 s
```

Point the API at it with `PAYPAL_API_BASE=http://localhost:4010`, `PAYPAL_CLIENT_ID=pantry-plan-mock-client` and `PAYPAL_CLIENT_SECRET=mock-secret` (mock credentials, not secrets).

In tests, run it in-process on a free port:

```ts
import { createPayPalMock, fixtureSubscriptionId } from "@keepwell/paypal-mock";

const mock = createPayPalMock({ clock: () => now });
const baseUrl = await mock.listen();               // http://127.0.0.1:<port>
mock.failures.add({ path: /\/suspend$/, status: 500, apply: true });
mock.state.renew(fixtureSubscriptionId("raj"), "PAYER_CANNOT_PAY");
await mock.webhooks.flush();
await mock.close();
```

## What it serves

| Area | Endpoints |
|---|---|
| OAuth | `POST /v1/oauth2/token` (client credentials, Basic auth) |
| Subscriptions | `GET /v1/billing/subscriptions[/:id]` (`fields=plan` shows a price override), `POST …/suspend`, `…/activate`, `…/cancel`, `…/revise`, `…/capture`, `PATCH …/:id`, `GET …/:id/transactions` |
| Plans | `GET /v1/billing/plans[/:id]`, `POST /v1/billing/plans` |
| Refunds | `POST /v2/payments/captures/:id/refund` is the one Keepwell uses (spike Q1, docs/spikes/Q1.md); `POST /v1/payments/sale/:id/refund` also works, as in real sandbox |
| Webhooks | `POST/GET/DELETE /v1/notifications/webhooks`, `POST /v1/notifications/verify-webhook-signature`, `GET /v1/notifications/webhooks-events/:id`, `POST …/:id/resend` |
| Buyer approval | `GET/POST /webapps/billing/subscriptions/update?ba_token=…`: the page a revise's `approve` link opens |

Rules it follows: suspend only from ACTIVE, activate only from SUSPENDED, cancel from ACTIVE or SUSPENDED (otherwise 422 `SUBSCRIPTION_STATUS_INVALID`); a revise changes nothing until the buyer approves; `PayPal-Request-Id` makes create plan, capture and refunds idempotent; the plan's `payment_failure_threshold` suspends after that many failed renewals.

## Acting as PayPal: `/__mock`

`GET /__mock` lists them. Over HTTP or on the `PayPalMock` object:

| Need | HTTP | In-process |
|---|---|---|
| A renewal, or a failed one | `POST /__mock/subscriptions/:id/renew {"failReason":"PAYER_CANNOT_PAY"}` | `mock.state.renew(id, reason?)` |
| Subscriber cancels in their PayPal account | `POST /__mock/subscriptions/:id/cancel-in-paypal` | `mock.state.cancelInPayPal(id)` |
| Buyer answers a revise | `POST /__mock/approvals/:ba_token {"decision":"approve"}` | `mock.state.decideRevision(token, true)` |
| Failures | `POST /__mock/failures {"path":"/\\/suspend$/","status":500,"apply":true}` | `mock.failures.add({...})` |
| Expire OAuth tokens | `POST /__mock/tokens/expire` | `mock.state.expireTokens()` |
| See webhook deliveries | `GET /__mock/webhooks/deliveries` | `mock.webhooks.deliveries` |
| Start over | `POST /__mock/reset` | `mock.reset()` |

A failure rule matches on `method` and `path` (a substring, or a regex) for `times` requests (default 1):
- `status` (+ `issue`) answers with that error instead.
- `apply: true` makes the change and *then* answers with `status`: the lost-response case read-before-retry exists for.
- `delayMs` waits first, e.g. past the gateway's 10 s timeout.

## Webhooks

Events go to every registered URL whose `event_types` match (`*` = all), signed with the five `PAYPAL-*` headers. The mock signs `transmissionId|time|webhookId|crc32(body)` with an HMAC instead of PayPal's RSA certificate, so only the mock's verify endpoint accepts them. Like PayPal, verification fails unless `webhook_event` is the delivered body byte for byte. A receiver that is down is recorded in `deliveries`, not retried; use resend.

## Fixtures

Pantry Plan (merchant id and plan ids from `@keepwell/contracts/fakes`): Lite $6/mo, Standard $12/mo, Standard Annual $120/yr and a $1 daily test plan. Twelve subscribers, ids from `fixtureSubscriptionId(name)`:

| Name | State |
|---|---|
| maya | ACTIVE on Standard 8 months, renews in 20 days (the pause demo) |
| raj | ACTIVE, 2 failed renewals (`PAYER_CANNOT_PAY`), $24 outstanding |
| ana | SUSPENDED 12 days ago (paused) |
| tom | CANCELLED inside PayPal yesterday (win-back) |
| lena | ACTIVE on Lite |
| noor | ACTIVE on Standard Annual |
| priya | ACTIVE 2 weeks: too new for a discount |
| diego | ACTIVE with a $9 override (a running discount) |
| kenji | ACTIVE on the daily plan |
| sara | APPROVAL_PENDING: never approved |
| ben | SUSPENDED by PayPal after 3 failed renewals |
| chloe | ACTIVE, renews in 5 days: inside the 10-day price rule |

## Not confirmed against sandbox yet

These follow the docs or our best guess, and get corrected as the spikes report (docs/spikes/):
- **List subscriptions** (`GET /v1/billing/subscriptions` with `statuses`, `plan_ids`, `status_updated_after`): the shape ARCHITECTURE.md §6.3 assumes.
- **Activate after suspend** keeps the billing anchor and charges nothing at activation (Q2).
- **Failed renewals** retry after 5 days; `next_billing_time` moves on a cycle anyway (Q5).
- **Refund** endpoint and error codes (Q1); revise approval timing and webhooks (Q3); webhook latency (Q6).
- PATCH supports only the paths Keepwell sends: the `fixed_price` override, `outstanding_balance` and `custom_id`.

Still to come (#6): a recorder that saves real sandbox responses, scrubbed, as fixtures. It lands with the spikes.
