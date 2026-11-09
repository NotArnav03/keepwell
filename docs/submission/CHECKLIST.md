# Submission checklist (living file)

Source: [TEAM-PLAN.md section 7](../TEAM-PLAN.md). Owner of this file: Om (M5); items verified by Arnav (M1). Last updated 9 Nov 2026 against `main`, the day after the feature freeze.
Status values: `done` (verified from the repo or a link), `in progress`, `TODO`, `blocked`.
Deadline: submit by **12 Nov 2026, 20:00 IST** (real deadline 13 Nov 01:30 IST). After submission, no code changes.

## Checklist

| # | Item | Owner | Status | Evidence or next step |
|---|---|---|---|---|
| 1 | Public GitHub repo | Arnav | done | Repo visibility is PUBLIC (checked with `gh repo view`, 1 Nov) |
| 2 | MIT licence file in repo | Arnav | done | `LICENSE` is MIT |
| 3 | MIT licence shown in the GitHub About section | Arnav | done | GitHub reports licence "MIT License" for the repo. Re-check the About panel in a logged-out browser on 12 Nov |
| 4 | README: what it is, problem | Om | done | README "What Keepwell does" matches `apps/api/src/platform.ts` as of 9 Nov. Hosted proof is a different row |
| 5 | README: architecture diagram | Om | done | Mermaid diagram in README (adapted from ARCHITECTURE.md section 3). The "Today on main" paragraph under it was refreshed 9 Nov |
| 6 | README: how to run locally, mock and sandbox | Om | in progress | Commands match root `package.json` (`dev:api`, `dev:paypal-mock`, `dev:fake-sessions`, `dev:widget`, `dev:store`, `dev:portal`, `dev:judge`, `seed`, `pool:refill`) and `pnpm --filter @keepwell/dashboard dev`. A second person has not followed them on a clean clone |
| 7 | README: hosted demo URL | Arnav | TODO | `TODO(url)`. `render.yaml` names `keepwell-*-demo`. This repo does not show those hosts answer |
| 8 | README: Judge Mode link | Aditya | TODO | Page and API are on `main` (`apps/judge`, `POST /v1/demo/leases` when `JUDGE_LEASE_SECRET`, `WIDGET_TOKEN_SECRET` and `DEMO_MERCHANT_ID` are set). The hosted link is still `TODO(url)` |
| 9 | README: eval results | Ishan | in progress | Harness and `packages/evals/results/adversarial.json` are on `main` (scripted model). README cites that file. No real-model run is committed. `platform.ts` does not register `GET /evals` |
| 10 | README: chaos report | Arnav | in progress | [CHAOS-REPORT.md](../CHAOS-REPORT.md) exists (9 Nov). Agent drills are written. API, widget, dashboard and email rows are Open |
| 11 | README: honest note on anything simulated | Om | done | "What is simulated" matches Q4, Q5, the Judge Mode time machine (`POST /v1/demo/time-machine/resume/:subscriptionId`), and the Demo Inbox rule that simulated mail is not sent |
| 12 | Hosted demo on `prod-demo` working from a clean browser | Arnav | TODO | Test in a fresh profile, also with the API asleep (cold start) |
| 13 | Judge Mode tested by someone outside the team | Aditya | TODO | Planned 10 Nov |
| 14 | Test credentials (sandbox merchant dashboard login and sandbox buyer account) in the submission form | Arnav | TODO | Dedicated sandbox accounts, never committed. Only in the form |
| 15 | Public YouTube video under 3 minutes | Ayush | TODO | Record 11 Nov; check it is public and under 3:00 |
| 16 | Devpost text: problem, solution, how PayPal is central, how AI is used, what is new since 1 October, built with | Om | in progress | Draft in [devpost.md](devpost.md), refreshed 9 Nov. Still TODO before paste: sandbox browser run, real-model eval, hosted URLs, `git log --reverse` for the 1 October claim |
| 17 | All five members registered on Devpost | Everyone | TODO | Each person confirms; not verifiable from the repo |
| 18 | All five members added to the Devpost submission | Arnav | TODO | Representative adds them in the form |
| 19 | Sponsor opt-in: Bryntum | Ayush | TODO | Dashboard timeline is an HTML event list (`apps/dashboard/src/views.ts`). Bryntum is not a dependency. [Q8](../spikes/Q8.md) says to wait for a written licence. Opt in only if a licensed Scheduler is visible in the video |
| 20 | Other sponsor opt-ins we qualify for | Om | TODO | Read the prize list on the Devpost page |
| 21 | Secret scan clean | Arnav | in progress | `.github/workflows/ci.yml` has a `gitleaks` job. This file does not record that the job is green on the submitted commit |
| 22 | No secrets or real personal data in repo, docs, video | Everyone | TODO | Final grep and video review on 11 Nov |
| 23 | Feature freeze respected | Everyone | TODO | The freeze instant (8 Nov 23:59 IST) is in the past as of 9 Nov. This file does not prove later commits were fixes only |
| 24 | Submitted by 12 Nov 20:00 IST | Arnav | TODO | Representative submits |

Spike status (`docs/spikes`), 9 Nov: Q1, Q2, Q4, Q5, Q6, Q8, Q9 and Q10 have files. Q3 and Q7 do not. Q4 is answered for a PATCH inside 10 days (204, price unchanged, 8 Nov renewal charged $1.00). The outside-window control was not run. Q5 is answered: a real renewal failure can be forced. The recovery half was not. Q6's resend half is still open. Q8 says not to add Bryntum without a written licence. Q10 records 50 pool subscriptions enrolled on staging on 3 Nov, and manual approval.

## Facts we must not claim until verified

Do not put any of these in the README, the Devpost text, the video or Judge Mode until the "verify by" step has been done and the evidence is linked.

| Claim | Why it is risky | Verify by |
|---|---|---|
| Any eval score ("0 policy violations", "1 click to cancel for every persona", dark-pattern score, latency, cost per session) as a result of Claude | The harness is on `main`. `packages/evals/results/adversarial.json` records gates passed (`policyViolations` 0, `maxClicksToCancel` 1, `claimsCaught` 204, `deniedPicks` 132, 404 sessions) for a scripted jailbroken model. `darkPatternScore` is null. [CHAOS-REPORT.md](../CHAOS-REPORT.md) says the paid Haiku run is still to do. `GET /evals` is not registered in `platform.ts` | Quote the adversarial file only as a scripted run, with the path. A Claude score needs a real-model run on the submitted commit, and a served scoreboard |
| Policy engine coverage ("100% branch coverage") | `packages/policy/vitest.config.ts` sets that threshold. No coverage output is committed | Run coverage on the submitted commit and record the number |
| Uptime, availability or "always on" | `render.yaml` uses the free plan, which sleeps after 15 idle minutes and wakes on the next request in under a minute | Say "free tier; may take up to a minute to wake" unless a monitor shows otherwise |
| Zero reconciler drift | Target in the architecture, not measured | Nightly drift report from a real run |
| The whole failed-payment recovery loop on the real sandbox | [Q5](../spikes/Q5.md) did force a real failure: 3 failed payments, $3.00 outstanding, PayPal suspended the subscription. The same file says restoring funding, the message, and capture of the outstanding balance were not run. The mock can do that loop. Judge Mode does not inject a failed payment | Say the failure itself was real, and cite Q5. Say "recovered" only with debug ids for the message and the capture. Otherwise badge the demo path `SIMULATED` |
| A price discount inside 10 days changes what PayPal charges | [Q4](../spikes/Q4.md): PATCH returned 204, `fixed_price` stayed 1.0, and the 8 Nov renewal charged $1.00. The policy withholds the offer (`PRICE_CHANGE_MIN_DAYS`). The outside-window control was not run | Do not say a discount inside 10 days applied. A PATCH more than 10 days out is PayPal's documentation until someone runs it |
| Recovered revenue figures | The dashboard reads `recoveredRevenue` from `GET /v1/m/overview` (`apps/api/src/modules/insights/queries.ts`). No sandbox total is written down in this repo | Quote only a number the running dashboard shows from sandbox data, and label it sandbox |
| Win-back reached a real subscriber who cancelled inside PayPal | `registerWinback` is on `main`. Sending needs the notifier, `PORTAL_URL` and `MAGIC_LINK_SECRET`. No sandbox cancel-to-message run is recorded | Run it once on staging and keep the audit entries |
| Hosted demo "works end to end on PayPal sandbox" | Unit tests use the mock. Spikes Q1, Q2, Q4, Q5 and Q6 exercised sandbox APIs. That is not a browser subscribe, pause, resume and cancel | Sandbox end-to-end run with timestamps and debug ids |
| Chaos results ("survives killing the API mid-action", dropped webhooks, PayPal 5xx, widget fallback, dashboard errors, email provider down) | [CHAOS-REPORT.md](../CHAOS-REPORT.md) records the agent drills only. The other rows are Open | Cite only the section that is filled in. Leave the Open rows unclaimed |
| Bryntum timeline | The dashboard is on `main`. The timeline is `renderTimelineFallback` in `apps/dashboard/src/views.ts`. Bryntum is not installed. [Q8](../spikes/Q8.md) withholds it until a written licence | Visible Bryntum in the video and on `prod-demo`, after the licence is confirmed. Until then describe the HTML event list |
| MCP (a subscriber's assistant paused or cancelled from Claude Desktop, or a merchant assistant proposed an action there) | The servers are on `main`: `POST /mcp/subscriber` (with sessions; 401 without a portal delegation) and `POST /mcp/merchant` (with merchant sign-in). No recording of a real client call is in the repo | Screen recording of a real call. Until then say the routes exist and name the env vars |
| Multilingual (Hindi, Spanish) as something a judge can see | Fixed templates for `en`, `hi` and `es` are in `apps/api/src/modules/agent/i18n.ts`. A check of the shipped widget in each language is not recorded | Check the widget in each language and note what you saw |
| Accessibility ("WCAG 2.2 AA") for the product | [docs/accessibility.md](../accessibility.md) (4 Nov) records 0 axe violations for the widget screens it lists, and says the screen-reader pass was not done. It also still says the portal and Judge Mode are not built. Those apps now have axe tests in `apps/portal/src/app.test.tsx` and `apps/judge/src/app.test.tsx`. No manual pass for them is written down | Record the screen-reader pass. Until then quote the widget axe note, and do not say the product is WCAG 2.2 AA |
| Email delivery to real inboxes | Resend is wired when `RESEND_API_KEY` is set. Simulated rows never call it (`apps/api/src/modules/notify/dispatcher.ts`). `render.yaml` leaves the key blank on staging. Judges read `GET /v1/m/outbox` and the dashboard Demo Inbox | Say "Demo Inbox" unless a real send is tested and the provider id is kept |
| Number of subscriptions in the judge pool ("150+") | `pnpm pool:refill` and `apps/api/src/modules/pool` are on `main`. [Q10](../spikes/Q10.md) records 50 enrolled on staging on 3 Nov, and a target of 150+ by 1 Dec. That is not a count for 9 Nov or 12 Nov | Query the pool on the day you submit and quote that count |
| "Nothing predates 1 October" | Needs a repo check. This 9 Nov refresh did not run `git log` | `git log --reverse` for the first commit date. Note any reused code |
| Any claim about churn rates or revenue lift for merchants | We have no merchant data | Do not make it |

## Before pressing submit

- [ ] Open the repo, README and video in a logged-out browser
- [ ] Every `TODO(...)` in README.md and devpost.md is resolved or the sentence is deleted: search with `grep -rn "TODO(" README.md docs/submission`
- [ ] Test credentials are in the form and nowhere in the repo
- [ ] Representative has the submission draft saved and all five members listed
