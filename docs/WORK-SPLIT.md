# Work split

Generated from the GitHub Issues on 28 Oct 2026. **The issues are the source of truth.** This page is the at-a-glance view.
Estimates are ideal days with heavy Claude Code use. Tiers: **core** (never cut), **diff** (differentiator), **moon** (moonshot, first to cut, see TEAM-PLAN.md §5).

| Member | Workstream | Issues | Estimate |
|---|---|---|---|
| Arnav | M1 Rails: PayPal platform and reliability | 14 | 11.5 days |
| Ishan | M2 Brain: policy, agent, AI safety | 12 | 11.5 days |
| Aditya | M3 Surfaces: widget, portal, demo store, Judge Mode, MCP | 13 | 11.0 days |
| Ayush | M4 Cockpit: dashboard, Bryntum, onboarding, video | 10 | 11.5 days |
| Om | M5 Growth: recovery, win-back, insights, write-up | 11 | 12.0 days |

**Whole team:** [#2 Kickoff: everyone set up and on Devpost](https://github.com/NotArnav03/keepwell/issues/2), [#63 Chaos day (9 Nov): break everything on staging](https://github.com/NotArnav03/keepwell/issues/63)

## Arnav: M1 Rails: PayPal platform and reliability

| # | Work | Milestone | Days | Tier |
|---|---|---|---|---|
| [#3](https://github.com/NotArnav03/keepwell/issues/3) | Scaffold monorepo, CI and environments | 1 · Contracts (29 Oct) | 1.0 | core |
| [#4](https://github.com/NotArnav03/keepwell/issues/4) | Contracts: platform types + fakes | 1 · Contracts (29 Oct) | 0.5 | core |
| [#5](https://github.com/NotArnav03/keepwell/issues/5) | Spikes Q2, Q6, Q10: resume billing, webhook latency, pool automation | 1 · Contracts (29 Oct) | 0.5 | spike |
| [#6](https://github.com/NotArnav03/keepwell/issues/6) | packages/paypal-mock: fake PayPal server + fixtures | 1 · Contracts (29 Oct) | 1.0 | core |
| [#7](https://github.com/NotArnav03/keepwell/issues/7) | packages/db: Drizzle schema + migrations | 2 · Skeleton (2 Nov) | 0.5 | core |
| [#8](https://github.com/NotArnav03/keepwell/issues/8) | PayPal gateway: OAuth, typed client, retries | 2 · Skeleton (2 Nov) | 1.0 | core |
| [#9](https://github.com/NotArnav03/keepwell/issues/9) | Hash-chained audit log + verify endpoint | 2 · Skeleton (2 Nov) | 0.5 | core |
| [#10](https://github.com/NotArnav03/keepwell/issues/10) | Webhook pipeline: ingest, verify, diff-of-truth, domain events | 2 · Skeleton (2 Nov) | 1.5 | core |
| [#11](https://github.com/NotArnav03/keepwell/issues/11) | Action engine core + suspend/activate/cancel | 2 · Skeleton (2 Nov) | 1.0 | core |
| [#13](https://github.com/NotArnav03/keepwell/issues/13) | Action engine: revise, price patch, refund, capture, create_plan | 3 · Three moments (5 Nov) | 1.0 | core |
| [#14](https://github.com/NotArnav03/keepwell/issues/14) | Reconciler, due-work sweep, health and status | 3 · Three moments (5 Nov) | 1.0 | core |
| [#15](https://github.com/NotArnav03/keepwell/issues/15) | Seed script + judge subscription pool + refill tool | 4 · Freeze (8 Nov) | 1.0 | core |
| [#16](https://github.com/NotArnav03/keepwell/issues/16) | Release: promote to prod-demo, go public, protect main | 5 · Submit (12 Nov) | 0 | core |
| [#17](https://github.com/NotArnav03/keepwell/issues/17) | Upstream PR to paypal/agent-toolkit: suspend/activate/revise/capture | 5 · Submit (12 Nov) | 1.0 | moon |

## Ishan: M2 Brain: policy, agent, AI safety

| # | Work | Milestone | Days | Tier |
|---|---|---|---|---|
| [#18](https://github.com/NotArnav03/keepwell/issues/18) | Contracts: policy and offer types + FakeAgent | 1 · Contracts (29 Oct) | 0.5 | core |
| [#19](https://github.com/NotArnav03/keepwell/issues/19) | Spike Q4: the 10-day rule for price overrides in sandbox | 1 · Contracts (29 Oct) | 0.5 | spike |
| [#20](https://github.com/NotArnav03/keepwell/issues/20) | packages/policy: computeMenu, evaluate, explain | 2 · Skeleton (2 Nov) | 1.5 | core |
| [#23](https://github.com/NotArnav03/keepwell/issues/23) | Agent runtime v0: classifier + conversation + pause offer | 2 · Skeleton (2 Nov) | 1.0 | core |
| [#21](https://github.com/NotArnav03/keepwell/issues/21) | Policy property tests + 100% branch coverage | 3 · Three moments (5 Nov) | 1.0 | core |
| [#24](https://github.com/NotArnav03/keepwell/issues/24) | Agent runtime v1: all reasons, no-means-no, multilingual | 3 · Three moments (5 Nov) | 1.0 | core |
| [#25](https://github.com/NotArnav03/keepwell/issues/25) | Claims checker + offer card templates (en, hi, es) | 3 · Three moments (5 Nov) | 1.0 | core |
| [#26](https://github.com/NotArnav03/keepwell/issues/26) | Fallbacks L0/L1, budget guard, rate limits, prompt caching | 3 · Three moments (5 Nov) | 1.0 | core |
| [#27](https://github.com/NotArnav03/keepwell/issues/27) | Policy publish + dry-run API | 3 · Three moments (5 Nov) | 0.5 | diff |
| [#28](https://github.com/NotArnav03/keepwell/issues/28) | packages/evals: personas, red team, LLM judge | 4 · Freeze (8 Nov) | 2.0 | diff |
| [#29](https://github.com/NotArnav03/keepwell/issues/29) | Public /evals scoreboard | 4 · Freeze (8 Nov) | 0.5 | diff |
| [#30](https://github.com/NotArnav03/keepwell/issues/30) | Prompt and eval iteration + full eval run | 5 · Submit (12 Nov) | 1.0 | core |

## Aditya: M3 Surfaces: widget, portal, demo store, Judge Mode, MCP

| # | Work | Milestone | Days | Tier |
|---|---|---|---|---|
| [#22](https://github.com/NotArnav03/keepwell/issues/22) | Contracts: sessions API, stream events, consent + fake API | 1 · Contracts (29 Oct) | 0.5 | core |
| [#31](https://github.com/NotArnav03/keepwell/issues/31) | Spikes Q3, Q7: revise approval flow, JS SDK v6 subscribe | 1 · Contracts (29 Oct) | 0.5 | spike |
| [#32](https://github.com/NotArnav03/keepwell/issues/32) | Sessions API + SSE + consent records | 2 · Skeleton (2 Nov) | 1.0 | core |
| [#33](https://github.com/NotArnav03/keepwell/issues/33) | Widget v0: Shadow DOM, streaming chat, offer card, Cancel now | 2 · Skeleton (2 Nov) | 1.5 | core |
| [#34](https://github.com/NotArnav03/keepwell/issues/34) | Pantry Plan demo store with JS SDK subscribe button | 2 · Skeleton (2 Nov) | 1.0 | core |
| [#35](https://github.com/NotArnav03/keepwell/issues/35) | Widget v1: L1 chips, L2 static shell, bundle budget | 3 · Three moments (5 Nov) | 1.0 | core |
| [#36](https://github.com/NotArnav03/keepwell/issues/36) | Subscriber identity: widget tokens, magic links, delegations | 3 · Three moments (5 Nov) | 1.0 | core |
| [#37](https://github.com/NotArnav03/keepwell/issues/37) | Revise approval UX + /revise/return | 3 · Three moments (5 Nov) | 0.5 | core |
| [#38](https://github.com/NotArnav03/keepwell/issues/38) | Hosted cancel portal + delegation management | 4 · Freeze (8 Nov) | 0.5 | diff |
| [#39](https://github.com/NotArnav03/keepwell/issues/39) | Judge Mode page, leases, time machine | 4 · Freeze (8 Nov) | 1.0 | core |
| [#40](https://github.com/NotArnav03/keepwell/issues/40) | Accessibility (WCAG 2.2 AA) + voice input | 4 · Freeze (8 Nov) | 1.0 | core |
| [#41](https://github.com/NotArnav03/keepwell/issues/41) | Subscriber-agent MCP server + discovery doc | 4 · Freeze (8 Nov) | 1.0 | moon |
| [#45](https://github.com/NotArnav03/keepwell/issues/45) | Merchant MCP server | 4 · Freeze (8 Nov) | 0.5 | moon |

## Ayush: M4 Cockpit: dashboard, Bryntum, onboarding, video

| # | Work | Milestone | Days | Tier |
|---|---|---|---|---|
| [#46](https://github.com/NotArnav03/keepwell/issues/46) | Contracts: merchant API types | 1 · Contracts (29 Oct) | 0.5 | core |
| [#47](https://github.com/NotArnav03/keepwell/issues/47) | Spikes Q8, Q9: Bryntum licence, free-tier limits | 1 · Contracts (29 Oct) | 0.5 | spike |
| [#48](https://github.com/NotArnav03/keepwell/issues/48) | packages/ui + dashboard shell + merchant auth | 2 · Skeleton (2 Nov) | 1.0 | core |
| [#49](https://github.com/NotArnav03/keepwell/issues/49) | Overview KPIs + live feed (SSE) | 3 · Three moments (5 Nov) | 1.5 | core |
| [#50](https://github.com/NotArnav03/keepwell/issues/50) | Subscribers list + detail page | 3 · Three moments (5 Nov) | 1.0 | core |
| [#51](https://github.com/NotArnav03/keepwell/issues/51) | Audit explorer + Verify chain + explanations | 3 · Three moments (5 Nov) | 1.0 | diff |
| [#52](https://github.com/NotArnav03/keepwell/issues/52) | Bryntum Scheduler subscriber timeline (sponsor prize) | 4 · Freeze (8 Nov) | 2.0 | diff |
| [#53](https://github.com/NotArnav03/keepwell/issues/53) | Policy editor + in-browser dry-run | 4 · Freeze (8 Nov) | 1.5 | diff |
| [#54](https://github.com/NotArnav03/keepwell/issues/54) | Zero-config onboarding wizard (full stack) | 4 · Freeze (8 Nov) | 1.5 | diff |
| [#55](https://github.com/NotArnav03/keepwell/issues/55) | Demo video (< 3 min) on YouTube | 5 · Submit (12 Nov) | 1.0 | core |

## Om: M5 Growth: recovery, win-back, insights, write-up

| # | Work | Milestone | Days | Tier |
|---|---|---|---|---|
| [#12](https://github.com/NotArnav03/keepwell/issues/12) | Spikes Q1, Q5: refund endpoint, forcing a real renewal failure | 1 · Contracts (29 Oct) | 0.5 | spike |
| [#42](https://github.com/NotArnav03/keepwell/issues/42) | Contracts: insights, notifications, dunning + FakeNotifier | 1 · Contracts (29 Oct) | 0.5 | core |
| [#56](https://github.com/NotArnav03/keepwell/issues/56) | Notifications outbox, Resend, caps, Demo Inbox API | 2 · Skeleton (2 Nov) | 1.0 | core |
| [#43](https://github.com/NotArnav03/keepwell/issues/43) | Insights extraction + aggregates + overview KPI SQL | 3 · Three moments (5 Nov) | 1.5 | diff |
| [#57](https://github.com/NotArnav03/keepwell/issues/57) | Failed-payment recovery engine | 3 · Three moments (5 Nov) | 2.0 | core |
| [#58](https://github.com/NotArnav03/keepwell/issues/58) | Win-back for cancellations made inside PayPal | 3 · Three moments (5 Nov) | 1.0 | diff |
| [#44](https://github.com/NotArnav03/keepwell/issues/44) | Insights copilot with read-only tools | 4 · Freeze (8 Nov) | 1.5 | diff |
| [#59](https://github.com/NotArnav03/keepwell/issues/59) | Insight-to-action: proposals, revenue estimate, create plan | 4 · Freeze (8 Nov) | 1.5 | diff |
| [#60](https://github.com/NotArnav03/keepwell/issues/60) | Insights panels + copilot chat + action queue (in dashboard) | 4 · Freeze (8 Nov) | 1.0 | diff |
| [#61](https://github.com/NotArnav03/keepwell/issues/61) | Churn-risk score from PayPal-only signals | 4 · Freeze (8 Nov) | 0.5 | moon |
| [#62](https://github.com/NotArnav03/keepwell/issues/62) | Judge-facing README + Devpost write-up + submission checklist | 5 · Submit (12 Nov) | 1.0 | core |
