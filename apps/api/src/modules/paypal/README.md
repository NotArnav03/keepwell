# modules/paypal (owner: Arnav, M1)

The only code that calls PayPal (ARCHITECTURE.md §6.1). Other modules get the read-only `PayPalGateway` view from `@keepwell/contracts`. The mutation methods (`suspend`, `activate`, `cancel`, and later `revise`, `patchPrice`, `refund`, `capture`, `createPlan` in #13) are for the action engine only, because every PayPal mutation is an Action.

```ts
const paypal = new PayPalClient({
  baseUrl: env.PAYPAL_API_BASE,          // sandbox, or paypal-mock's URL; live PayPal throws
  credentials: singleAppCredentials({ clientId, clientSecret }),
  log: app.log,
});
const subscription = await paypal.getSubscription(merchantId, "I-…"); // fields=plan included
```

| Concern | Behaviour |
|---|---|
| OAuth | Client-credentials token per merchant, cached and refreshed 5 minutes before expiry. Concurrent callers share one token request. On a 401: one refresh, one retry. |
| Timeouts and retries | 10 s per attempt. Network errors, timeouts, 429 and 5xx retry after 0.5 s, 1 s and 2 s (±25% jitter), 4 attempts in all. Longer waits are the action engine's RETRY_WAIT. |
| Errors | Always `PayPalGatewayError` with `kind`, `retryable`, `status`, PayPal's `issue` code and the `debugId`. 422s keep their issue (e.g. `SUBSCRIPTION_STATUS_INVALID`) and are not retried. |
| Debug ids | Every response's `PayPal-Debug-Id` is logged, returned by mutations and carried by errors. They go on the Action. |
| Rate limit | Token bucket per merchant (10/s, burst 20), so sweeps can't starve live Actions. |
| Money | `toMoney()` normalises PayPal amounts to two decimals: sandbox sends `"1.0"` for `last_payment` (spike Q1). |
| Sandbox only | The constructor refuses `api.paypal.com` and `api-m.paypal.com` (CLAUDE.md §1). |

Credentials come from `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` for now. Onboarding (#54) will store them per merchant, encrypted.

Tests run against `@keepwell/paypal-mock` over HTTP, with failures injected the way PayPal fails.
