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

## Hosted

`render.yaml` deploys it as `keepwell-store-staging` and `keepwell-store-demo` (free static sites). The build also bundles the widget and serves `v1.js` from the store's own origin, so there is no separate widget host. The API serves `/v1/demo-store/*` when `WIDGET_TOKEN_SECRET` and `DEMO_MERCHANT_ID` are set, to `DEMO_STORE_URL`'s origin only. If Render assigns the store a different hostname, change `DEMO_STORE_URL` (API), `WIDGET_CDN_URL` (store) and `JUDGE_STORE_URL` (judge page). A person sets `PAYPAL_CLIENT_ID` and the three plan ids in Render; until then the store runs in FAKE PAYPAL mode.
