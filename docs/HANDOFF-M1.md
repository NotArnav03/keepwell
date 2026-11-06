# Handoff: M1 (Rails) review and merge duty → Ishan

**From:** Arnav (M1), 6 Nov 2026. **To:** Ishan and his Claude Code session.

Arnav's Claude usage is running out for the week. Until he's back, **Ishan merges, rebases and reviews for M1** so the pipeline keeps moving to the freeze (**8 Nov 23:59 IST**) and the submission (**12 Nov 20:00 IST**).

Claude: read this whole file, then `CLAUDE.md`, `docs/ARCHITECTURE.md` §2 (the ten laws) and `apps/api/CLAUDE.md`. Everything in `CLAUDE.md` still applies; this file only adds the M1 duties and the current state. Check every fact below against GitHub before acting (`gh pr view <n>`), because PRs move fast.

---

## 1. What Arnav authorises Ishan to do

| Allowed | How |
|---|---|
| Merge any PR whose checks pass and that has an approval (or this file says it's ready) | `gh pr merge <n> --squash --subject "<title> (#<n>)" --body "<clean summary>"` |
| Retarget stacked PRs | `gh pr edit <m> --base main` |
| Review and comment, approve or request changes | `gh pr review <n> --approve/--request-changes --body-file <file>`, `gh pr comment <n> --body-file <file>` |
| Rebase and push **Arnav's own branches** (`arnav/*`, e.g. #125, #145) | `git push --force-with-lease`. Arnav gives this permission explicitly here. |
| Small code changes in M1 modules (`paypal`, `webhooks`, `actions`, `reconcile`, `audit`, `jobs`, `pool`, `packages/db`, `packages/paypal-mock`, `apps/api/src/platform.ts`, `render.yaml`) when §5 asks for them | A `ishan/<topic>` branch and a PR, as usual |

**Not allowed** (wait for Arnav or ask him directly):
- Anything in Render, Neon, the PayPal developer dashboard, or GitHub repo settings, secrets or rulesets. That's infra, and Arnav owns it (CLAUDE.md §1a), even where Ishan's account can reach it.
- Pushing to another teammate's branch, closing their PRs, or deleting their branches.
- `pnpm pool:refill`, `pnpm spike <anything>`, or any loop that creates sandbox subscriptions (CLAUDE.md §6).
- Running the full eval suite or long LLM loops: the Anthropic credit is **$5 total**.
- Spending money. **The whole project is ₹0**: free tiers only, no paid add-ons, no new services.

## 2. The merge checklist (every time)

1. Check CI: `gh pr view <n> --json mergeStateStatus,statusCheckRollup`. All checks must pass, and the state should be `CLEAN`.
2. **Stacked PRs first.** Run `gh pr list --base <head-branch-of-n>`. GitHub deletes a merged branch automatically, and that **closes every PR based on it** (this happened to Om's #66). Retarget each one with `gh pr edit <m> --base main` **before** merging.
3. Squash-merge with a **clean body**: a short summary written by you. **No `Co-Authored-By` lines and no "Generated with Claude Code" footer** (team rule). Several PR bodies and commits contain these, so don't copy them in. Never pass `--delete-branch`.
4. After merging, tell the stacked PR's author to rebase: `git rebase --onto origin/main <old-base-head>`. The squash leaves the parent's original commits on their branch.
5. If the PR adds a migration, see §3 before merging the *next* one.

## 3. Migrations: one at a time

`main` has `0000`–`0005` (`0005_notify_outbox`, from #91). Om's PRs and Arnav's #125 each contain a migration with a stale number, so they conflict in `packages/db/drizzle/meta/_journal.json`.

Rule: **whoever merges next regenerates their migration to the next free number.** No one reserves a number. Before the author pushes, they:
```bash
git fetch origin && git rebase origin/main
# delete this PR's packages/db/drizzle/00NN_*.sql, meta/00NN_snapshot.json, and its entry in meta/_journal.json
pnpm db:generate                         # drizzle-kit: writes the next number
# re-add any hand-written SQL (RLS: ENABLE / FORCE ROW LEVEL SECURITY + the tenant_isolation policy, as in 0001)
pnpm check
```
Afterwards, `pnpm db:generate` again must say "No schema changes". **drizzle-kit asks interactively when a column or table might be a rename**, and Claude Code's shell has no TTY, so there it fails with "Interactive prompts require a TTY". Either run it yourself in a real terminal, or generate in two steps (drop first, then create) and fold them into one migration: see how #125 did it.

Then merge it, and only then does the next author regenerate. Hand-written migrations (#92's `insight_views`) are renamed and get a journal entry; they aren't regenerated.

## 4. Merge order and the state of every open PR (6 Nov)

Order: **#83 → #125 → #89 → #90 → #92 (retarget #109 first) → #111**. Aditya's and the other chains go in whenever they're green and their blockers are met.

| PR | Author | State | What it waits on / what to do |
|---|---|---|---|
| **#83** LLM budget guard | Ishan | approved by Arnav | **Ishan: fix Om's two points first** (Arnav's comment on #83). First, reserve the worst-case cost of in-flight calls before `messages.create`, so overlapping calls can't overshoot the cap. Second, count unrecorded spend when `budget.record` throws, and refuse unknown models. Check the Sonnet cache-read price against the pricing page. Then merge. #125, #92, #109 and #95 all wait on this. |
| **#125** llm_usage + PgLlmUsageStore | Arnav | open | After #83: rebase onto `main`, regenerate the migration (§3), make it use #83's final `LlmUsageStore` interface, run `pnpm check`, then merge. Ishan may push to `arnav/llm-usage-store`. |
| **#89** recovery | Om | approved; Arnav commented | Om must: renumber the migration; pass `core.notify.notifier` (and delete `notifierNotWired`); implement `Notifier.supersede` in `modules/notify/notifier.ts` with a DB test; keep #91's wiring in `platform.ts`. Merge once that's done and CI is green. |
| **#90** win-back | Om | approved; Arnav commented | After #89: renumber, and pass `notifier: core.notify.notifier` to `registerWinback`. |
| **#92** insights | Om | approved; Arnav commented | After #83: `createLlmClient` must take the **same** `LlmBudget` as `createAgent`. Renumber both migrations. **Before merging: `gh pr edit 109 --base main`.** |
| **#109** copilot | Om | approved (base `om/insights-extraction`) | Retarget to `main` before #92 merges, then Om rebases to his one commit. Mounting it needs #83's budget and a per-merchant rate limit (§5). |
| **#111** insight actions | Om | approved; Arnav commented | After #92 and #90: renumber, and swap `JobsWinbackSender`'s stub for #90's `WinbackService.startBatch`. |
| **#139** sessions on Postgres | Aditya | approved twice | Aditya: the stale-event fix (act on an offer Action's change only if its id is in the latest `Accepted.response.actionIds`, with a test), and add the `contract-change` label. Then merge. **#140 is stacked on it: retarget it first.** |
| **#140** subscriber MCP | Aditya | approved (base `aditya/sessions-db`) | Retarget to `main` before #139 merges. Before it's *mounted*: leave `downgrade` and `switch_annual` out of the MCP options (no approval link can reach the subscriber). |
| **#141** Judge Mode API | Aditya | **changes requested** | Aditya: in `leaseOf`, call `pool.holds(mid, pe, new Date(exp*1000).toISOString())` on every route (401 if false), and use `release(…, leasedUntil)`. Add `simulated: true` to the `demo.time_shift` audit entry and to `JudgeResumeResponse`. Add a test: return, lease again, and the old token gets 401. #144 (merged) gave him `holds`. Approve once that's in. |
| **#142** Judge Mode page | Aditya | approved (base `aditya/judge-api`) | Retarget to `main` before #141 merges. |
| **#99** per-IP rate limits | Ishan | approved by Arnav | Touches Aditya's `sessions/routes.ts`, so get Aditya's OK, then merge. It conflicts with #139 (about 20 lines); whichever is second resolves it. |
| **#95 → #96 → #97 → #98** agent v1, evals | Ishan | approved | #95 contains #83, so it merges after #83. Retarget each child before its parent merges. |
| **#124** cockpit dashboard | Ayush | **changes requested**, conflicts | The biggest blocker: the merchant stores, `platform.ts` wiring and #143 wait on it. It also has a flaky test: `merchant/auth.test.ts` "rejects expired or tampered cookies" replaces the cookie's last character with `x`, which sometimes changes nothing. Tamper in the middle of the payload instead. **#143 is stacked on it: retarget it first.** |
| **#143** dashboard insights panels | Om | approved (base `ayush/cockpit-dashboard`) | Retarget to `main` before #124 merges. Its PR body has a "Generated with Claude Code" footer: don't copy it into the squash body. |
| **#131** spike Q5 | Om | approved | Om still needs to remove the duplicate fixture (`41-…` vs `50-…`) and fill in the PR description. Fine to merge after that. |
| **#145** spike Q2 + ADR 0001 | Arnav | open | Ready once CI is green. Ask Ishan to read ADR 0001 (it constrains the pause offer in `packages/policy`). Merge. |
| **#108** submission README / Devpost | Om | open | Docs; review the wording against what's actually live before 12 Nov. |

## 5. M1 code tasks Ishan's Claude may pick up (only after their blockers merge)

**A. Wire the real modules into `apps/api/src/platform.ts`** once #124 **and** #139 are merged. Arnav's design is settled:
- **Sessions (#32):**
  - `DbSessionsApi` with #124's `DbPolicyStore` and catalog, the agent from `createAgent` (with #83's budget), `engine`, `events`, `audit`, `PayPalClient` as `PaymentLookup`.
  - `sessionAuthenticator` with `demoMerchantWidgetSecret` (`WIDGET_TOKEN_SECRET`, the demo merchant only), `portalSecret`, and `SESSION_TICKET_SECRET` (its own secret).
  - Register `onActionStateChanged` on `action.state_changed`, and schedule `sessions.abandon_sweep` every 5 minutes.
- **Portal (#137):**
  - `PgMagicLinkStore`, `PgDelegationStore`, `PgPortalDirectory` (`modules/portal/pg.ts`).
  - The mailer is #91's notifier. **Never** use a mailer that logs links, because sign-in links would end up in the logs.
  - `verifyUrl` on the portal's origin.
- **Subscriber MCP (#140):** `subscriberMcpRoutes` with `DbSessionsApi` and `DelegationService`, plus a per-token rate limit (`RateLimiter` from `portal/rate-limit.ts`).
- **Judge Mode (#141):** `judgeRoutes` with `DbJudgePool`, `DbTimeMachine`, `DEMO_MERCHANT_ID`, `JUDGE_LEASE_SECRET` and `WIDGET_TOKEN_SECRET`.
- **Copilot (#109):** mount it only with #83's budget **and** a per-merchant limit of about 20 messages an hour.
- **New env vars:** `SESSION_TICKET_SECRET`, `JUDGE_LEASE_SECRET`, `WIDGET_TOKEN_SECRET` and `DEMO_MERCHANT_ID` go in `env.ts` (zod) and `.env.example`, and in `render.yaml` as `sync: false`. **Arnav sets the values in Render.** Put a note in the PR body that they're needed; secrets are generated by humans, never by Claude.

**B. Add the portal and judge static sites to `render.yaml`** (staging and demo), copying `keepwell-dashboard-demo`:
- rewrite `/v1/*` to the API;
- for the judge site, **also rewrite `/status`**;
- an SPA fallback to `/index.html`;
- build-time `API_PUBLIC_URL`.

**Leave `JUDGE_BUYER_EMAIL` and `JUDGE_BUYER_PASSWORD` unset on prod-demo**: the sandbox buyer's login goes in the Devpost testing instructions, not on a public page. Demo services keep `autoDeployTrigger: "off"`. Arnav applies the Blueprint himself.

Every PR: `pnpm check` green, the PR template filled in, and a summary of what was tested.

## 6. Only Arnav can do these (leave a note on the PR or message him)

- **Render:** add env vars and secrets, sync the Blueprint, manual deploys of `*-demo`, and confirm `RESEND_API_KEY` is **not** set on staging (Om asked on #91).
- **Neon:** prod-demo project, compute and usage. The free tier is 100 CU-hours a month per project.
- **Sandbox:** `pnpm spike cancel` (ends the $1/day spike subscription, irreversible), `pnpm pool:refill` (judge pool: 150 by 1 Dec), the seed on prod-demo.
- **GitHub settings:** the keep-awake variables `KEEPWELL_PING_FROM` and `KEEPWELL_PING_UNTIL` near 1 Dec, and tick Q2, Q5 and Q10 in #5.

## 7. Reviewing like M1 (what to check in any PR)

- **PayPal:** PayPal calls go only through `modules/paypal`, and every mutation is an Action via `engine.create` with a stable idempotency key.
- **Webhooks** are hints: re-read from PayPal and diff. Never trust the event body.
- **Tenancy:** every query runs in `db.forMerchant`, and `acrossMerchants` only for work that is cross-tenant by nature. New tables get RLS `ENABLE` + `FORCE` + the `tenant_isolation` policy in the migration.
- **Audit:** every side effect writes an audit entry **in the same transaction**.
- **Cancel** never touches the LLM.
- **LLM calls** go through the agent module's client with #83's budget.
- **Simulated** things carry `simulated: true` and show SIMULATED.
- **Privacy:** no emails or phone numbers stored in plain text, and no secrets or tokens in URLs that get logged (`logSafeUrl` redacts query strings).
- **Cost:** anything that polls the database forever keeps Neon's compute awake and burns the free hours. Look for intervals with no stop condition.
- **Tests:** CI's `database (Postgres 18)` job runs the DB tests. Locally they skip without `KEEPWELL_TEST_DATABASE_URL`, so "passes locally" can mean "skipped locally".

## 8. Known traps

- `gh` has a 5,000 calls/hour limit shared by everything. When it's hit, use `git fetch origin pull/<n>/head:pr<n>` and `git diff` instead.
- `git merge-tree --write-tree origin/main pr<n>` tells you whether a PR still merges cleanly, without touching your checkout.
- The squash "Merge already in progress" / 502 errors from GitHub usually clear on a retry a minute later.
- After **8 Nov 23:59 IST**: bug fixes and polish only. After **12 Nov 20:00 IST**: no code changes at all, only ops.
