# Submission checklist (living file)

Source: [TEAM-PLAN.md section 7](../TEAM-PLAN.md). Owner of this file: Om (M5); items verified by Arnav (M1). Last updated 7 Nov 2026 against `main`; refreshed again after the freeze.
Status values: `done` (verified from the repo or a link), `in progress`, `TODO`, `blocked`.
Deadline: submit by **12 Nov 2026, 20:00 IST** (real deadline 13 Nov 01:30 IST). After submission, no code changes.

## Checklist

| # | Item | Owner | Status | Evidence or next step |
|---|---|---|---|---|
| 1 | Public GitHub repo | Arnav | done | Repo visibility is PUBLIC (checked with `gh repo view`, 1 Nov) |
| 2 | MIT licence file in repo | Arnav | done | `LICENSE` is MIT |
| 3 | MIT licence shown in the GitHub About section | Arnav | done | GitHub reports licence "MIT License" for the repo. Re-check the About panel in a logged-out browser on 12 Nov |
| 4 | README: what it is, problem | Om | in progress | Judge-facing README drafted (this PR) |
| 5 | README: architecture diagram | Om | done | Mermaid diagram in README (adapted from ARCHITECTURE.md section 3) |
| 6 | README: how to run locally, mock and sandbox | Om | in progress | Written from `package.json` and `.env.example`; not yet run end to end by a second person. Ask a teammate to follow it on a clean clone |
| 7 | README: hosted demo URL | Arnav | TODO | `TODO(url)` until `prod-demo` exists |
| 8 | README: Judge Mode link | Aditya | TODO | `TODO(url)`; Judge Mode not on `main` |
| 9 | README: eval results | Ishan | TODO | `packages/evals` is a placeholder; `TODO(results)` |
| 10 | README: chaos report | Arnav | TODO | Chaos day 9 Nov; `docs/CHAOS-REPORT.md` does not exist yet |
| 11 | README: honest note on anything simulated | Om | in progress | "What is simulated" section drafted; final wording depends on spike Q5 and what Judge Mode does |
| 12 | Hosted demo on `prod-demo` working from a clean browser | Arnav | TODO | Test in a fresh profile, also with the API asleep (cold start) |
| 13 | Judge Mode tested by someone outside the team | Aditya | TODO | Planned 10 Nov |
| 14 | Test credentials (sandbox merchant dashboard login and sandbox buyer account) in the submission form | Arnav | TODO | Dedicated sandbox accounts, never committed. Only in the form |
| 15 | Public YouTube video under 3 minutes | Ayush | TODO | Record 11 Nov; check it is public and under 3:00 |
| 16 | Devpost text: problem, solution, how PayPal is central, how AI is used, what is new since 1 October, built with | Om | in progress | Draft in [devpost.md](devpost.md) |
| 17 | All five members registered on Devpost | Everyone | TODO | Each person confirms; not verifiable from the repo |
| 18 | All five members added to the Devpost submission | Arnav | TODO | Representative adds them in the form |
| 19 | Sponsor opt-in: Bryntum | Ayush | TODO | Timeline not on `main`; read prize rules, confirm licence (spike Q8, no `docs/spikes/Q8.md` yet) |
| 20 | Other sponsor opt-ins we qualify for | Om | TODO | Read the prize list on the Devpost page |
| 21 | Secret scan clean | Arnav | in progress | CI has a gitleaks job; confirm it is green on the submitted commit |
| 22 | No secrets or real personal data in repo, docs, video | Everyone | TODO | Final grep and video review on 11 Nov |
| 23 | Feature freeze respected | Everyone | TODO | 8 Nov 23:59 IST |
| 24 | Submitted by 12 Nov 20:00 IST | Arnav | TODO | Representative submits |

Spike status (docs/spikes), 7 Nov: Q1, Q2, Q5 and Q10 have files on `main`; check the folder for the rest.

## Facts we must not claim until verified

Do not put any of these in the README, the Devpost text, the video or Judge Mode until the "verify by" step has been done and the evidence is linked.

| Claim | Why it is risky | Verify by |
|---|---|---|
| Any eval score ("0 policy violations", "1 click to cancel for every persona", dark-pattern score, latency, cost per session) | `packages/evals` is empty; the zero-violation target is a goal, not a result | A full eval run on the submitted commit; link the output. Quote the persona count that actually ran |
| Policy engine coverage ("100% branch coverage") | It is the CI gate target; no figure has been recorded | Run coverage on the submitted commit and record the number |
| Uptime, availability or "always on" | Free-tier Render sleeps; cold starts take up to a minute | Say "free tier; may take up to a minute to wake" unless a monitor shows otherwise |
| Zero reconciler drift | Target in the architecture, not measured | Nightly drift report from a real run |
| Failed-payment recovery on the real sandbox | Spike Q5 (can a real renewal failure be forced?) is not documented. The mock can simulate it, which is not the same | Say "real" only if a sandbox renewal actually failed and the message and capture followed, with debug ids. Otherwise say "simulated" and badge it |
| Recovered revenue figures | Dashboard not built | Only quote numbers shown by the running dashboard from sandbox data, labelled sandbox |
| Win-back from a real cancel inside PayPal | Needs a real sandbox cancel and the handler | Run it once on staging and keep the audit entries |
| Hosted demo "works end to end on PayPal sandbox" | Only the mock is exercised by unit tests | Sandbox end-to-end run (subscribe, pause, resume, cancel) with timestamps and debug ids |
| Chaos results ("survives killing the API mid-action") | The action-engine README says a mid-call kill is tested with a real worker process, but the full chaos day is 9 Nov | Cite only what the chaos report records |
| Bryntum timeline | Dashboard not on `main` | Visible in the video and on `prod-demo` |
| MCP (subscriber agent can pause or cancel from Claude Desktop) | Not on `main`; first on the cut list if time runs out (X1 is the last to cut) | Screen recording of a real call |
| Multilingual (Hindi, Spanish) | Templates exist in the agent module; cut list item 5 | Check the shipped widget in each language |
| Accessibility ("WCAG 2.2 AA") | Needs the axe run and manual screen-reader pass | Record the pass; otherwise say "we designed for it" |
| Email delivery to real inboxes | Resend not wired; demo uses an in-app Demo Inbox | Say "Demo Inbox" unless real send is tested |
| Number of subscriptions in the judge pool ("150+") | Target; pool-refill is not built | Query the pool on 12 Nov and quote the actual count |
| "Nothing predates 1 October" | Needs a repo check | `git log --reverse` first commit date; note any reused code |
| Any claim about churn rates or revenue lift for merchants | We have no merchant data | Do not make it |

## Before pressing submit

- [ ] Open the repo, README and video in a logged-out browser
- [ ] Every `TODO(...)` in README.md and devpost.md is resolved or the sentence is deleted: search with `grep -rn "TODO(" README.md docs/submission`
- [ ] Test credentials are in the form and nowhere in the repo
- [ ] Representative has the submission draft saved and all five members listed
