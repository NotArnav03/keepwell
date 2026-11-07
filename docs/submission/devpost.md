# Devpost write-up (draft)

Owner: Om (M5). Drafted 1 Nov 2026, status refreshed 7 Nov against `main`, and refreshed again after the freeze. Sections follow the Devpost form order. Each section ends with **Still TODO**, listing facts that must be confirmed before this text is pasted into the form. Anything marked `TODO(shipping by 8 Nov)` must be reworded or deleted if it misses the feature freeze. Do not paste test credentials into this file.

---

## Project name and tagline

**Keepwell**: an honest AI retention agent for PayPal Subscriptions.

Tagline: "Saves the subscriptions worth saving, and never makes cancelling harder."

**Still TODO:** confirm "Keepwell" is the final name (ARCHITECTURE.md calls it a working name).

## Inspiration (the problem)

Businesses that bill through PayPal Subscriptions lose revenue in three places. A subscriber clicks cancel and nobody asks why. A renewal fails and the subscriber never hears about it in time. Someone cancels inside their PayPal account and the merchant never learns the reason. The usual tools for the first problem are dark patterns: hidden cancel buttons, guilt copy, fake discounts. We wanted to see whether an AI agent could do the opposite: one short, honest conversation, one fair offer the merchant has already approved, and a cancel button that always works.

**Still TODO:** add one sentence of motivation from the team if wanted. Do not add statistics about churn unless we cite a source.

## What it does

Keepwell runs three moments on the real PayPal subscription:

1. **Honest cancel save.** When Maya (a fictional subscriber to the fictional Pantry Plan) clicks cancel, a widget offers a short chat. The merchant's policy decides what may be offered: pause, cheaper plan, time-limited discount or partial refund. The agent offers at most one, and Maya accepts by clicking a button. Keepwell then applies it to the real PayPal subscription. "Cancel now" is always one click and does not involve the AI.
2. **Failed-payment recovery.** When Raj's renewal fails, Keepwell reads PayPal's failure reason and next retry time, sends a message matched to the reason about a day before the retry, and captures the outstanding balance once he has fixed his payment method.
3. **Win-back.** When a subscriber cancels inside PayPal, Keepwell sends one message asking what happened. It never sends a drip campaign.

On top of these: an insights pipeline turns every exit conversation into structured reasons; a merchant copilot answers questions using read-only tools, with every number coming from SQL; and insight-to-action lets the merchant approve a proposal (for example, creating a new PayPal plan). Other AI agents can use the same rules through MCP: a subscriber's assistant can read options and cancel; a merchant's assistant can propose actions but never execute them.

Every action is idempotent, reconciled against PayPal, and written to a hash-chained audit log.

**State on `main` (7 Nov):** policy engine, agent runtime, claims checker, action engine, webhook pipeline, reconciler, audit log, widget, LLM budget guard, eval harness and scoreboard, notifications outbox, failed-payment recovery, sessions module (not yet mounted in the running API), Judge Mode API and page, portal. **Not yet on `main`:** win-back, insights, copilot, insight-to-action, MCP servers, dashboard, Pantry Plan store.

**Still TODO:** rewrite each paragraph above in past/present tense according to what actually ships by 8 Nov. Remove any moment that does not run end to end.

## How we built it

- **Monorepo:** pnpm and Turborepo, TypeScript (strict), CI on Linux and Windows with a secret scan.
- **API:** Fastify with zod at every boundary, Drizzle ORM on Postgres (Neon, free tier) with row-level security for tenant isolation, pg-boss for jobs on the same Postgres (no Redis), pino logging.
- **PayPal layer:** a gateway that is the only code allowed to call PayPal (OAuth cache, retries, debug ids, rate limiting); an action engine with a state machine and a per-subscription lock; a verified webhook pipeline; a reconciler; and a fake PayPal server (`packages/paypal-mock`) so tests and offline work need no credentials.
- **Brain:** a pure policy engine (`packages/policy`) with property-based tests; an agent runtime using Claude Haiku 5.5 to converse, classify and tag, with structured outputs validated by zod; a deterministic claims checker.
- **Surfaces:** a Preact widget in Shadow DOM, server-sent events for streaming. `TODO(shipping by 8 Nov)`: React and Vite dashboard with Bryntum Scheduler; MCP servers with `@modelcontextprotocol/sdk`.
- **Hosting:** Render and Neon free tiers, Resend for email `TODO(shipping by 8 Nov)`.
- **Process:** five people, each with a vertical workstream, meeting only through typed contracts; every teammate works with Claude Code under shared repo rules.

**Still TODO:** confirm the final hosting, email provider and dashboard stack against what is deployed on `prod-demo`.

## How PayPal is central

Keepwell has nothing to act on without a PayPal subscription, and PayPal stays the source of truth.

- **Subscriptions API:** suspend, activate, cancel, revise (with PayPal's buyer approval page), price patch and capture of an outstanding balance. Pause is a suspend plus a scheduled activate.
- **Plans API:** insight-to-action creates a new plan after merchant approval.
- **Refunds v2:** partial refunds via `POST /v2/payments/captures/{id}/refund`. We confirmed on the sandbox that subscription transaction ids are valid capture ids and that `PayPal-Request-Id` makes a replayed refund safe ([docs/spikes/Q1.md](../spikes/Q1.md)).
- **Webhooks:** every event is verified with PayPal's verify-webhook-signature API on the raw body. Then it is treated as a hint: we re-fetch the subscription and diff it, so duplicate, late or missing webhooks cannot corrupt state. A reconciler sweeps for what webhooks miss.
- **JS SDK:** the Pantry Plan demo store uses the subscribe button. `TODO(shipping by 8 Nov)`.
- **Failure data:** recovery uses PayPal's own failure reason code and `next_payment_retry_time`.

Everything runs on the PayPal sandbox.

**Still TODO:** confirm which of these ran end to end on the sandbox (not only on the mock) before listing them as working. Add Agent Toolkit usage only if we really use it (`@paypal/agent-toolkit` is in the plan; the upstream PR X3 is on the cut list).

## How AI is used

Claude Haiku 5.5 runs the short conversation, classifies the cancel reason, tags insights and checks text. Claude Sonnet 5.5 powers the merchant copilot. Recovery and win-back emails are fixed templates, not model text. The design constrains the model rather than trusting it:

- **Cancel never touches the LLM.** No model call, no agent step.
- **The AI picks from a menu; the policy decides.** The policy engine computes what may be offered, the model chooses at most one, and the policy re-checks the pick, and checks again when the subscriber accepts.
- **Terms come from data.** Offer cards are rendered from the offer object. A deterministic claims checker rejects model text that contains figures, dates, durations, promises or pressure language.
- **Consent is a button.** It is never parsed from text.
- **Hard limits.** Three subscriber messages, one clarifying question, one offer, an 8-second model deadline, and a daily budget guard. When any limit is hit, or Claude is unavailable, the session falls back to reason chips and template text, and cancel still works.
- **Prompt injection.** The subscriber's text can only change which menu item the model picks.
- **Merchant numbers come from SQL.** The copilot has read-only, parameterised tools, not free-form SQL. `TODO(shipping by 8 Nov)`.

**Still TODO:** eval results `TODO(results)`: policy violations, clicks-to-cancel, claims-checker catches, dark-pattern score. Do not state any of these until a full run exists.

## Challenges we ran into

Facts from the repo so far (add more as they happen):

- PayPal accepts `PayPal-Request-Id` on only a few endpoints, so suspend, activate and cancel needed a read-before-retry strategy instead.
- Subscription transaction ids and refund endpoints were unclear; spike Q1 resolved it on the sandbox.
- The subscription's last payment amount came back as `"1.0"` while other endpoints use `"1.00"`, so the gateway normalises money before it reaches our schema.
- Sandbox accounts created with country India fail at subscription approval; US accounts are needed.
- A judge needs an already-approved subscription to test a cancel flow, and only a buyer can approve one. `TODO(shipping by 8 Nov)`: the pooled-subscription design for Judge Mode.
- Building with a free-tier budget and a small prepaid AI credit.

**Still TODO:** team to add real challenges from the last week (e.g. webhook latency, Bryntum, sandbox limits). Do not invent any.

## Accomplishments we are proud of

Only list items that are true on the submitted commit:

- Cancel is one click and does not depend on the AI. State on `main`: designed and tested at the policy and agent layers; end-to-end `TODO(results)`.
- A policy engine with property-based tests. Coverage figure `TODO(results)`.
- A webhook design that survives duplicate, late and missing events. Chaos-day result `TODO(results)`.
- A hash-chained audit log with verification. On `main`.
- Mock PayPal server that mirrors the sandbox, built from recorded spike responses. On `main`.
- Eval scoreboard `TODO(results)`.

**Still TODO:** every bullet depends on the verified results; see CHECKLIST.md "Facts we must not claim".

## What we learned

Draft points (team to edit): constrain the model with data and code, not with prompts alone; treat webhooks as hints; PayPal sandbox behaviour needs spikes before design; contracts-first lets five people build in parallel.

**Still TODO:** replace with the team's real lessons after the build.

## What's next

- Multilingual and voice support beyond the English, Hindi and Spanish templates.
- A churn-risk score from PayPal-only signals, shown with its factors.
- Upstream tools for `paypal/agent-toolkit` (suspend, activate, revise, capture).
- Onboarding more merchants by pasting sandbox credentials. `TODO(shipping by 8 Nov)` whether this ships.

**Still TODO:** align with the cut list after feature freeze; remove anything that shipped, and anything we no longer plan.

## Built with

TypeScript, Node.js, Fastify, zod, Drizzle ORM, PostgreSQL (Neon), pg-boss, Preact, Vitest, fast-check, Turborepo, pnpm, GitHub Actions, Render, Claude (Anthropic API: Sonnet 5.5, Haiku 5.5), PayPal Subscriptions / Plans / Payments (Refunds v2) / Webhooks / JS SDK APIs, Model Context Protocol, Resend `TODO(shipping by 8 Nov)`, React, Vite, Tailwind CSS, Bryntum Scheduler `TODO(shipping by 8 Nov)`, Playwright `TODO(shipping by 8 Nov)`, Sentry `TODO(shipping by 8 Nov)`.

**Still TODO:** trim to what is actually in the submitted commit.

## What's new since 1 October

The whole project. The first commit on `main` is dated 28 Oct 2026; no code, design or data predates the hackathon period.

**Still TODO:** confirm the first-commit date is after 1 October 2026 and that no pre-existing code was reused. If any library was a prior project of a teammate, say so.

## Test credentials

Go in the Devpost submission form only. Never in this repo.

- Judge Mode URL: `TODO(url)`
- Hosted demo URL: `TODO(url)`
- Sandbox merchant dashboard login: `TODO(in form)`
- Sandbox buyer account (for the fully real subscribe-then-cancel path): `TODO(in form)`
- Notes for judges: all data is fictional; the PayPal environment is the sandbox; Judge Mode leases a pre-approved subscription for 30 minutes.

**Still TODO:** Arnav (Representative) enters these in the form. Create dedicated sandbox accounts for judging; do not reuse personal ones. Remember to rotate them after judging.

## Links

- Public repository: https://github.com/NotArnav03/keepwell (MIT licence)
- Demo video (public YouTube, under 3 minutes): `TODO(url)`
- Eval scoreboard: `TODO(url)`
- Chaos report: `TODO(url)`

## Sponsor prize opt-ins

- **Bryntum:** the subscriber timeline is built on Bryntum Scheduler (one row per subscriber; bars for billing periods, pauses and discounts; markers for failed payments, refunds and cancellations; click through to the audit entry). Owner: Ayush. `TODO(shipping by 8 Nov)`.
- Any others we qualify for: `TODO(confirm)`.

**Still TODO:** read the Bryntum prize rules on the Devpost page and confirm the licence terms (spike Q8; no `docs/spikes/Q8.md` yet) and what proof the form needs. Opt in only if the timeline ships and is visible in the video.
