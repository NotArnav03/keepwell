# apps/judge: Judge Mode

The page a judge lands on (ARCHITECTURE.md §6.17, #39). It offers three one-click scenarios (pause, cheaper plan, honest cancel), each on a pooled, already-approved sandbox subscription leased for 30 minutes. It also has a time machine for pauses (Resume now, labelled TIME SHIFT), the test login, links to the store, dashboard and eval scoreboard, and the live status. If the pool is empty or the API is down, it shows the fully real path through Pantry Plan, never a blank page.

## Run it locally

```bash
pnpm dev:fake-sessions   # the API on fakes, with a fake pool of three subscriptions
pnpm dev:judge           # http://localhost:5180, /v1 proxied to the API
```

On the fake, each pooled subscription has its own scenario's script, so the offer you see depends on which one the lease returned. The real agent decides from what you type.

## Build settings (all public)

| Variable | What |
|---|---|
| `API_PUBLIC_URL` | The API's origin (for the post-approval message check, and the dev proxy). |
| `JUDGE_API_BASE` | Empty (default): call this origin's `/v1`, rewritten to the API, like the dashboard. |
| `JUDGE_STORE_URL` | Pantry Plan, for the fully real path and the fallback. |
| `JUDGE_DASHBOARD_URL`, `JUDGE_EVALS_URL` | Links; left out when empty. |
| `JUDGE_BUYER_EMAIL`, `JUDGE_BUYER_PASSWORD` | The PayPal **sandbox** buyer judges log in with (test money only). When unset, the page points to the submission's testing instructions. |

The API side is `apps/api/src/modules/demo/judge.ts`. It needs the prod-demo merchant id, `JUDGE_LEASE_SECRET` (its own) and `WIDGET_TOKEN_SECRET`, plus a deploy with the `/v1/*` rewrite.
