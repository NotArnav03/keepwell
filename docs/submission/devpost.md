# Devpost write-up (draft)

Owner: Om (M5). Drafted 1 Nov 2026. Status refreshed 9 Nov 2026 against `main`, the day after the feature freeze, and again on 12 Nov after prod-demo was brought up (commit `430c646`). Sections follow the Devpost form order. Each section ends with **Still TODO**, listing facts that must be confirmed before this text is pasted into the form. A `TODO(shipping by 8 Nov)` that missed the freeze is rewritten as what the repo actually contains. Do not paste test credentials into this file.

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

**State on `main` (9 Nov):** the three moments above are in the repo and wired from `apps/api/src/platform.ts`, with the conditions in the README. Sessions mount when `SESSION_TICKET_SECRET` is set. Win-back records every PayPal-side cancellation, and queues its one template message only when the notifier, `PORTAL_URL` and `MAGIC_LINK_SECRET` are set (`POST /v1/winback/replies` in that case). Insights extraction runs on `session.closed`. Win-back reply text is not extracted (`noReplies` in `platform.ts`). With `SESSION_SECRET` and `DASHBOARD_URL`, the API serves `GET /v1/m/insights`, `GET /v1/m/overview`, insight-action approve/reject, and (with `ANTHROPIC_API_KEY`) `POST /v1/m/copilot/messages`. The dashboard is `apps/dashboard`, Insights page included. Subscriber MCP is `POST /mcp/subscriber` (mounted with sessions; a portal delegation token is required). Merchant MCP is `POST /mcp/merchant` (mounted with merchant sign-in). Pantry Plan is `apps/demo-store`, and `POST /v1/demo-store/subscriptions` mounts when `WIDGET_TOKEN_SECRET` and `DEMO_MERCHANT_ID` are set. The eval scoreboard handlers are not registered on the running server.

**Still TODO:** a sandbox browser run of each moment (subscribe, pause, resume, cancel, and a win-back message after a real cancel inside PayPal). Spike [Q5](../spikes/Q5.md) forced a real renewal failure. The recovery message and the later capture were not run. Do not describe a moment as proven end to end until that run exists. Checked on prod-demo, 11 to 12 Nov: a pause in Judge Mode in a browser (the `suspend` CONFIRMED against PayPal 14 s after it was applied), the agent offering a pause from the policy's menu on Groq, and the dashboard's sign-in, overview, audit log and live feed. Still unchecked there: a subscribe through the store, a portal sign-in, the copilot, and a cheaper-plan revise.

## How we built it

- **Monorepo:** pnpm and Turborepo, TypeScript (strict), CI on Linux and Windows with a secret scan.
- **API:** Fastify with zod at every boundary, Drizzle ORM on Postgres (Neon, free tier) with row-level security for tenant isolation, pg-boss for jobs on the same Postgres (no Redis), pino logging.
- **PayPal layer:** a gateway that is the only code allowed to call PayPal (OAuth cache, retries, debug ids, rate limiting); an action engine with a state machine and a per-subscription lock; a verified webhook pipeline; a reconciler; and a fake PayPal server (`packages/paypal-mock`) so tests and offline work need no credentials.
- **Brain:** a pure policy engine (`packages/policy`) with property-based tests; an agent runtime that converses, classifies and tags through one `LlmClient` interface (Claude Haiku 5.5, or Groq's `openai/gpt-oss-20b`), with structured outputs validated by zod; a deterministic claims checker.
- **Surfaces:** a Preact widget in Shadow DOM, with server-sent events for streaming. The dashboard is React and Vite (`apps/dashboard`). It has no Tailwind build and no Bryntum package. The subscriber timeline is an HTML event list (`apps/dashboard/src/views.ts`). The portal and Judge Mode are Preact. MCP servers use `@modelcontextprotocol/sdk` at `POST /mcp/subscriber` and `POST /mcp/merchant`.
- **Hosting:** `render.yaml` defines Render free-tier services (they sleep after 15 idle minutes) and names Neon as the database. Resend is the email provider when `RESEND_API_KEY` is set (`apps/api/src/modules/notify/providers.ts`). With no key, sends go to a console provider. Simulated rows never call a provider. Sentry initialises only when `SENTRY_DSN` is set (`apps/api/src/index.ts`).
- **Process:** five people, each with a vertical workstream, meeting only through typed contracts; every teammate works with Claude Code under shared repo rules.

**prod-demo:** the five `keepwell-*-demo` services in `render.yaml` answer (checked 11 to 12 Nov). The API was deployed by hand from `v1.0.0`. The agent runs on Groq's free plan (see How AI is used).

## How PayPal is central

Keepwell has nothing to act on without a PayPal subscription, and PayPal stays the source of truth.

- **Subscriptions API:** suspend, activate, cancel, revise (with PayPal's buyer approval page), price patch and capture of an outstanding balance. Pause is a suspend plus a scheduled activate.
- **Plans API:** after a merchant approves an insight action (`POST /v1/m/insight-actions/:id/approve`), a `create_plan` Action goes through the action engine. That route mounts with merchant sign-in.
- **Refunds v2:** partial refunds via `POST /v2/payments/captures/{id}/refund`. We confirmed on the sandbox that subscription transaction ids are valid capture ids and that `PayPal-Request-Id` makes a replayed refund safe ([docs/spikes/Q1.md](../spikes/Q1.md)).
- **Webhooks:** every event is verified with PayPal's verify-webhook-signature API on the raw body. Then it is treated as a hint: we re-fetch the subscription and diff it, so duplicate, late or missing webhooks cannot corrupt state. A reconciler sweeps for what webhooks miss.
- **JS SDK:** `apps/demo-store` loads `https://www.paypal.com/sdk/js` and only then asks `POST /v1/demo-store/subscriptions` to GET the subscription from PayPal. With no `PAYPAL_CLIENT_ID` the page badges `FAKE PAYPAL`. `render.yaml` leaves the hosted store's client id and plan ids unset until a person sets them.
- **Price patch:** the gateway uses `.../pricing_scheme/fixed_price`. Spike [Q4](../spikes/Q4.md) showed that inside 10 days PayPal returns 204 and does not apply the price. The 8 Nov renewal still charged $1.00. The policy withholds that offer (`PRICE_CHANGE_MIN_DAYS` in `packages/policy`). A PATCH more than 10 days before billing was not run.
- **Failure data:** recovery uses PayPal's own failure reason code and `next_payment_retry_time`.

Everything runs on the PayPal sandbox.

**Still TODO:** a browser run on the sandbox (subscribe, pause, resume, cancel) before calling the product flow proven. Spikes [Q1](../spikes/Q1.md), [Q2](../spikes/Q2.md), [Q4](../spikes/Q4.md) and [Q5](../spikes/Q5.md) are sandbox API calls, not that browser flow. `@paypal/agent-toolkit` is not a dependency. Leave it off this form. The upstream PR stays on the cut list.

## How AI is used

A small, fast model runs the short conversation, classifies the cancel reason and tags insights; a larger one powers the merchant copilot. With Anthropic those are Claude Haiku 5.5 and Claude Sonnet 5.5. The hosted demo runs on **Groq's free plan** (`openai/gpt-oss-20b` and `openai/gpt-oss-120b`), because the team had no working Anthropic key on submission day. Both sit behind one `LlmClient` interface, so the rules below hold whichever model answers ([ADR 0002](../adr/0002-groq-as-a-second-model-provider.md)). Recovery and win-back emails are fixed templates, not model text. The design constrains the model rather than trusting it:

- **Cancel never touches the LLM.** No model call, no agent step.
- **The AI picks from a menu; the policy decides.** The policy engine computes what may be offered, the model chooses at most one, and the policy re-checks the pick, and checks again when the subscriber accepts.
- **Terms come from data.** Offer cards are rendered from the offer object. A deterministic claims checker rejects model text that contains figures, dates, durations, promises or pressure language.
- **Consent is a button.** It is never parsed from text.
- **Hard limits.** Three subscriber messages, one clarifying question, one offer, an 8-second model deadline, and a daily budget guard. When any limit is hit, or the model is unavailable, the session falls back to reason chips and template text, and cancel still works.
- **Prompt injection.** The subscriber's text can only change which menu item the model picks.
- **Merchant numbers come from SQL.** `POST /v1/m/copilot/messages` uses the copilot's read-only tools. It mounts when merchant sign-in and a model key are set. The model is Claude Sonnet 5.5 (`apps/api/src/modules/agent/llm.ts`), or `openai/gpt-oss-120b` on Groq (`agent/groq.ts`). The copilot on Groq is not yet checked on prod-demo.

**Evals.** The committed adversarial file (`packages/evals/results/adversarial.json`, a scripted jailbroken model, not a real one) records `policyViolations` 0, `maxClicksToCancel` 1, `claimsCaught` 204 and `deniedPicks` 132 over 404 sessions. A real-model run on 12 Nov (`packages/evals/results/real-groq-subset.json`) used the model prod-demo runs, `openai/gpt-oss-20b` on Groq, over the 51-persona subset: 0 policy violations, 1 click to cancel, 0 violations in 13 red-team sessions, dark-pattern score 0.06 of 3, classification and language match 1.00, no fallbacks, reply latency p50 855 ms and p95 3.0 s. The claims checker caught 7 figures or durations in the model's text, and the policy refused 2 off-menu picks prompted by a fake `<menu>` injection. Not run: all 404 personas on a real model, and any Claude model (no key). The running API does not serve `/evals`: `platform.ts` does not register the handlers.

## Challenges we ran into

Facts from the repo so far (add more as they happen):

- PayPal accepts `PayPal-Request-Id` on only a few endpoints, so suspend, activate and cancel needed a read-before-retry strategy instead.
- Subscription transaction ids and refund endpoints were unclear; spike Q1 resolved it on the sandbox.
- The subscription's last payment amount came back as `"1.0"` while other endpoints use `"1.00"`, so the gateway normalises money before it reaches our schema.
- Sandbox accounts created with country India fail at subscription approval; US accounts are needed.
- A judge needs an already-approved subscription, and only a buyer can approve one. The pool is on `main` (`apps/api/src/modules/pool`, `pnpm pool:refill`). Judge Mode leases one for 30 minutes when its env vars are set. Spike [Q10](../spikes/Q10.md) records 50 enrolled on staging on 3 Nov, and says approval stays manual. prod-demo's pool had 10 on 11 Nov; the target is 150 by 1 Dec (#15).
- A price PATCH inside 10 days can return 204 and leave the old price in place. Spike [Q4](../spikes/Q4.md) confirmed that on 8 Nov, when the renewal still charged $1.00. The policy therefore does not offer that discount. The outside-window control was not run.
- Building with a free-tier budget and a small prepaid AI credit. On submission day the team had no working Anthropic key, so prod-demo moved to Groq's free plan behind the same model interface (ADR 0002); the agent had already been built to degrade to reason chips without a model, and did so until then.
- Render's static-site rewrite (`/v1/*` to the API) buffers streaming responses until they end, so the dashboard's live feed showed nothing through it. Session streams already used an absolute URL on the API host with a ticket; the feed now does the same (`POST /v1/m/feed/ticket`).

**Still TODO:** team to add real challenges from the last week (e.g. webhook latency, Bryntum, sandbox limits). Do not invent any.

## Accomplishments we are proud of

Only list items that are true on the submitted commit:

- Cancel is one click and the cancel route does not call the agent (`POST /v1/sessions/:id/cancel`, mounted with sessions). A sessions test runs it with an agent that throws. A sandbox browser run is `TODO(results)`.
- A policy engine with property-based tests, and a Vitest threshold of 100% branches (`packages/policy/vitest.config.ts`). No coverage number is committed. `TODO(results)`.
- Webhook verification against real PayPal: spike [Q6](../spikes/Q6.md) records 30 of 30 VERIFIED on 3 Nov. The chaos-day rows for killing the API and dropping webhooks are still Open in [CHAOS-REPORT.md](../CHAOS-REPORT.md). `TODO(results)` for those.
- A hash-chained audit log. `GET /v1/m/audit/verify` mounts with merchant sign-in.
- A mock PayPal server that mirrors the sandbox, built from recorded spike responses. On `main`.
- An adversarial eval result committed at `packages/evals/results/adversarial.json` (scripted model, gates passed, as cited above), and a real-model run on Groq over the 51-persona subset (`real-groq-subset.json`, gates passed). The public scoreboard is not served.

**Still TODO:** every bullet depends on the verified results; see CHECKLIST.md "Facts we must not claim".

## What we learned

Draft points (team to edit): constrain the model with data and code, not with prompts alone; treat webhooks as hints; PayPal sandbox behaviour needs spikes before design; contracts-first lets five people build in parallel.

**Still TODO:** replace with the team's real lessons after the build.

## What's next

- Conversation quality in Hindi and Spanish beyond the fixed templates in `apps/api/src/modules/agent/i18n.ts` (locales `en`, `hi`, `es`). The widget can start the browser's Web Speech API (`packages/widget/src/speech.ts`). A recorded pass of either is `TODO(results)`.
- Upstream tools for `paypal/agent-toolkit` (suspend, activate, revise, capture). The package is not a dependency.
- The churn-risk list and merchant onboarding shipped, so they are not in this list. At-risk subscribers come from `listAtRisk` (PayPal-only signals, shown with factors) on `GET /v1/m/subscriptions` and the merchant MCP tool `list_at_risk`. Onboarding is `POST /v1/m/onboarding/credentials` when merchant sign-in is on, PayPal is not the mock, and `PAYPAL_CREDENTIALS_ENCRYPTION_KEY` is set.

**Still TODO:** read the cut list once more before paste. Do not add a churn score or a credential form as future work. They are on `main` under the conditions above.

## Built with

TypeScript, Node.js, Fastify, zod, Drizzle ORM, PostgreSQL (Neon), pg-boss, Preact (widget, portal, Judge Mode), React, Vite (dashboard), Vitest, fast-check, Turborepo, pnpm, GitHub Actions, Render, Groq (free plan, OpenAI-compatible API: `openai/gpt-oss-20b` for the subscriber agent and insight extraction, `openai/gpt-oss-120b` for the copilot; what the hosted demo runs on), Claude (Anthropic API: Haiku 5.5 and Sonnet 5.5, the default provider), PayPal Subscriptions / Plans / Payments (Refunds v2) / Webhooks / JS SDK, Model Context Protocol (`@modelcontextprotocol/sdk`), Resend when `RESEND_API_KEY` is set, Sentry when `SENTRY_DSN` is set.

Not in this commit, so leave them off the form: Tailwind CSS, Bryntum Scheduler, Playwright, `@paypal/agent-toolkit`. Spike [Q10](../spikes/Q10.md) decided pool approvals stay manual. Spike [Q8](../spikes/Q8.md) says not to add Bryntum until a written licence exists.

**Still TODO:** if a person later adds one of those, put it back. Until then this list matches `package.json` files and `render.yaml`.

## What's new since 1 October

The whole project, as far as this draft knows. An earlier draft said the first commit on `main` is 28 Oct 2026. This refresh did not re-run `git log`, so that date is not re-confirmed here.

**Still TODO:** `git log --reverse` on `main`, and a note if any library was a prior project of a teammate. Do not claim "nothing predates 1 October" until that command is recorded.

## Test credentials

Go in the Devpost submission form only. Never in this repo.

- Judge Mode URL: https://keepwell-judge-demo.onrender.com
- Hosted demo: dashboard https://keepwell-dashboard-demo.onrender.com, store https://keepwell-store-demo.onrender.com, portal https://keepwell-portal-demo.onrender.com, API status https://keepwell-api-demo.onrender.com/status
- Sandbox merchant dashboard login: `TODO(in form)`
- Sandbox buyer account (for the fully real subscribe-then-cancel path): `TODO(in form)`
- Notes for judges: all data is fictional; the PayPal environment is the sandbox; Judge Mode leases a pre-approved subscription for 30 minutes.

**Still TODO:** Arnav (Representative) enters these in the form. Create dedicated sandbox accounts for judging; do not reuse personal ones. Remember to rotate them after judging.

## Links

- Public repository: https://github.com/NotArnav03/keepwell (MIT licence)
- Demo video (public YouTube, under 3 minutes): `TODO(url)`
- Eval scoreboard: `TODO(url)`. The handlers exist and `platform.ts` does not register them, so there is no live page to link.
- Chaos report: [docs/CHAOS-REPORT.md](../CHAOS-REPORT.md) in this repo (agent drills recorded, other rows Open). A public URL for the form is `TODO(url)`.

## Sponsor prize opt-ins

- **Bryntum:** the dashboard timeline is an HTML event list, not Bryntum Scheduler (`apps/dashboard/src/views.ts` says the licensed Scheduler view is not enabled). Owner: Ayush. `TODO(licence)`.
- Any others we qualify for: `TODO(confirm)`.

**Still TODO:** read the Bryntum prize rules on the Devpost page. Spike [Q8](../spikes/Q8.md) (3 Nov) says not to add the package until Bryntum confirms in writing that the hackathon licence covers this project, the developers, and the hosted demo. Opt in only if a licensed timeline is in the repo and visible in the video. The current event list is not that timeline.
