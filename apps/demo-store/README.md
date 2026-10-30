# Pantry Plan (apps/demo-store) · owner: Aditya, M3

The fictional merchant site judges subscribe on: three plans with PayPal's subscribe button (JS SDK **v5**; spike Q7 decides whether v6 replaces it), an account page with the Keepwell widget installed by one script tag, served as a static site on its own origin.

**Access is never granted from `onApprove` alone.** The browser hands the new subscription id to Pantry Plan's backend (`POST /v1/demo-store/subscriptions`, in `apps/api/src/modules/demo`). The backend GETs it from PayPal, and only an ACTIVE or APPROVED subscription on a Pantry Plan plan gets a shopper token. The account page swaps that token for a 10-minute HS256 widget token (`POST /v1/demo-store/token`), the same thing a real merchant's server does.

## Run it locally

```bash
pnpm dev:fake-sessions   # API on :3000: sessions + demo-store routes, fake PayPal
pnpm dev:widget          # widget on :5177
pnpm dev:store           # Pantry Plan on :5176
```

With no `PAYPAL_CLIENT_ID`, the store runs in **FAKE PAYPAL** mode (badged on the page). Each button "subscribes" to the fake server's `I-FAKE-<SCENARIO>` subscription; `?scenario=downgrade` picks which.

## Sandbox mode

Set these in the root `.env` (all public values; never put a secret here):

| Variable | |
|---|---|
| `PAYPAL_CLIENT_ID` | The sandbox app's client id |
| `PAYPAL_PLAN_LITE`, `PAYPAL_PLAN_STANDARD`, `PAYPAL_PLAN_ANNUAL` | Plan ids from the seed script (#15) |
| `API_PUBLIC_URL`, `WIDGET_CDN_URL` | Where the API and the widget are served |

`pnpm --filter @keepwell/demo-store build` writes `dist/` for the Render static site.
