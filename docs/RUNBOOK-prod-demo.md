# Runbook: prod-demo (owner: Arnav, M1)

prod-demo is the environment judges use (ARCHITECTURE.md §4, issue #16). It runs the same code as staging, but it's deployed only by hand from a tagged commit, it has its own database and PayPal sandbox app, and nobody experiments on it.

| Piece | prod-demo | staging (for comparison) |
|---|---|---|
| API | Render `keepwell-api-demo`, auto-deploy **off** | `keepwell-api-staging`, deploys on every merge |
| Dashboard | Render static site `keepwell-dashboard-demo`, `/v1/*` rewritten to the API | `keepwell-dashboard-staging` |
| Database | Neon **project** `keepwell-prod-demo` (AWS us-west-2) | `staging` branch of the team project |
| PayPal | sandbox app **Keepwell-Demo** | sandbox app Keepwell-Staging |
| Local env file | `.env.prod-demo` (gitignored by `.env.*`) | `.env.staging` |

**Cost: ₹0.** Every piece is a free tier: two Render free services (the API on `plan: free`, the dashboard as a static site), one more Neon free project, and GitHub Actions, which is unlimited on a public repo. If Render or Neon ask you to pick a plan or add a card at any step, stop: choose Free, or skip it.

## Why it's set up this way

- **A separate Neon project, not a branch.** Neon's free plan gives 100 compute-hours a month **per project**, shared by all its branches, and suspends the whole project when they run out. In its own project, prod-demo can't be starved by dev branches or a runaway test. Staging used 1.84 compute-hours from 1 to 4 Nov, so a branch would probably fit, but the margin costs nothing.
- **Keep-awake only during judging.** Render's free 750 instance-hours a month are shared by every free service in the workspace, and running out suspends all of them until the next month. Awake all December is 744 hours; 1–21 Dec is 504, which leaves staging room.
- **Deployed by hand.** A merge to `main` can't change what judges see. After submission (12 Nov 20:00 IST), prod-demo only gets restarts and pool refills (CLAUDE.md §1).

## One-time setup

Never paste connection strings, client secrets or generated secrets into chat, issues or PRs.

1. **Neon:** create the project `keepwell-prod-demo` in AWS us-west-2 (next to Render's Oregon region). Set its compute to a fixed 0.25 CU (min and max), with scale-to-zero left on. Copy the **direct** connection string (host without `-pooler`).
2. **PayPal developer dashboard (sandbox):** create the app **Keepwell-Demo** under a US business sandbox account. Note its client ID and secret.
3. **`.env.prod-demo`** in the repo root, for the seed and pool refill from your machine:
   ```
   APP_ENV=prod-demo
   DATABASE_URL_UNPOOLED=<direct string from step 1>
   PAYPAL_CLIENT_ID=<Keepwell-Demo>
   PAYPAL_CLIENT_SECRET=<Keepwell-Demo>
   API_PUBLIC_URL=https://keepwell-api-demo.onrender.com
   ```
4. **Render:** Blueprints → the Keepwell blueprint → **Manual sync**. It offers to create `keepwell-api-demo` and `keepwell-dashboard-demo` and asks for each `sync: false` value. Generate every secret fresh, in your own terminal, never reusing staging's:
   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```
   That's `OPS_TOKEN` and `UNSUBSCRIBE_TOKEN_SECRET` now, plus the merchant-auth secrets once #124 lands (`SESSION_SECRET`, `PAYPAL_CREDENTIALS_ENCRYPTION_KEY`, `DASHBOARD_URL=https://keepwell-dashboard-demo.onrender.com`). Leave `RESEND_API_KEY` blank: sandbox buyers can't receive mail, and the Demo Inbox shows every message.
5. **Hostnames:** if Render gave either service a different hostname (the name was taken), update `API_PUBLIC_URL` and the dashboard rewrites in `render.yaml` and `.env.prod-demo` in a follow-up PR, then sync again.
6. **First boot:** the API applies migrations at start (`RUN_MIGRATIONS` defaults to true). Check `https://keepwell-api-demo.onrender.com/healthz`.
7. **Seed** (registers the webhook to prod-demo's URL and creates Pantry Plan):
   ```bash
   pnpm turbo run build --filter=@keepwell/api^...
   cd apps/api
   node --env-file=../../.env.prod-demo --import tsx src/cli/seed.ts
   ```
   Run it with `node --env-file` as shown, not `pnpm seed`: the pnpm script loads `.env`, which points at your own branch.
8. **Proxy check:** `curl -H "Authorization: Bearer <prod-demo OPS_TOKEN>" https://keepwell-api-demo.onrender.com/ops/whoami` should show your own address as `ip`, as on staging.

## Filling the judge pool

The pool belongs to the prod-demo merchant; staging's 50 stay on staging for testing. Target: **150 by 1 Dec**, in runs of at most 50:

```bash
cd apps/api
node --env-file=../../.env.prod-demo --import tsx src/cli/pool-refill.ts 50
```

Split `.pool-refill/links.txt` across the team; each link needs a **US** sandbox personal account. Re-run with no count to enrol the approved ones.

## Promoting a release

1. Pick the commit on `main` (after the freeze, the submission commit) and tag it: `git tag v1.0.0 <sha> && git push origin v1.0.0`.
2. In Render, on **both** prod-demo services: **Manual Deploy → Deploy a specific commit** → that sha.
3. Check `/healthz` shows that sha, then smoke-test from a clean (private) browser window: the dashboard signs in, the widget opens a session, cancel works, Judge Mode runs end to end.
4. Note the tag and date in #16.

## Judging (1–21 Dec)

- **Keep-awake:** set the repo variables `KEEPWELL_PING_URLS=https://keepwell-api-demo.onrender.com/healthz`, `KEEPWELL_PING_FROM=2026-12-01` and `KEEPWELL_PING_UNTIL=2026-12-21`. The workflow pings only inside that window, so nothing needs switching off.
- **LLM budget:** staging and prod-demo share the $5 credit. On 1 Dec set staging's `LLM_DAILY_BUDGET_USD` to `0.02`.
- **Watch:** Neon usage on the `keepwell-prod-demo` project (expect at most about 4 compute-hours a day, so check on 3 Dec that it fits), the Render workspace's instance-hours, the pool count, and Sentry.
- **If prod-demo is down:** check Render logs and `/healthz`, then **Manual Deploy → Restart**. Never deploy a new commit during judging unless the whole team agrees it fixes a judge-facing break.
