# Keepwell: Contracts v1

These are the seams between the five workstreams. They become `packages/contracts` (zod) on day 1. **Build against these and you never wait for another team member.**

Change rule: a PR labelled `contract-change`, with the consumers' owners tagged and one of them approving. Additive changes (new optional field, new event) are cheap. Renames and removals need everyone's OK.

Conventions:
- IDs: UUIDv7 strings for our rows. PayPal IDs are kept as PayPal gives them (`I-…` subscriptions, `P-…` plans).
- Times: ISO-8601 UTC strings.
- Money: `{ value: string, currency: string }`, where `value` is a decimal string like `"12.00"`. Never floats.
- Every API error uses one envelope: `{ error: { code: string, message: string, requestId: string, details?: unknown } }`.

---

## 1. Domain types

**As implemented in `packages/contracts/src/platform/` (v1, owner M1).** The zod there is the source of truth; differences from the sketch below:
- Times are `IsoDateTime` (UTC, `Z` suffix). Raw PayPal shapes (`PayPalSubscription`, loose, only the fields we read) also accept offsets.
- `SubscriptionSnapshot` adds `priceOverride: Money | null` (a discount's `fixed_price`).
- `ActionCreateInput` is a union on `type` with **strict params per type** (`ActionParams`: `suspend`/`activate`/`cancel {reason ≤128}`, `revise {planId}`, `patch_price {fixedPrice | null}`, `refund {transactionId, amount}`, `capture_outstanding {amount}`, `create_plan {productId, name, price, interval}`). Only `create_plan` has `subscriptionId: null`. Optional `idempotencyKey`: the same key for the same merchant returns the existing Action.
- `Action` adds `idempotencyKey` and `simulated`. `ACTION_TRANSITIONS` / `canTransition` hold the state machine (§6.4), shared by the engine and the fake.
- `AuditEntry.kind` is dotted lower-case (`offer.presented`); `seq` starts at 1 per merchant with `prevHash = GENESIS_HASH`. `AuditAppendInput` defaults `simulated` to false. `AuditVerifyResult` is the `/m/audit/verify` body.
- `canonicalJson()` is the one serialiser for anything hashed (audit chain, consent `offerHash`).
- `ErrorEnvelope` is the API error body. `PayPalGatewayError` (`kind`: not_found, unauthorized, rate_limited, unavailable, invalid_request, unprocessable; `.retryable`) is the only error the gateway throws.
- Events and jobs: `platformEventPayloads` (§2) feed the `domainEventPayloads` registry, which each workstream extends; `platformJobs` (§3) give each queue a payload schema and an `idempotencyKey(payload, now)` for pg-boss `singletonKey`.
- Fakes in `@keepwell/contracts/fakes`: `FakeActionEngine`, `FakeAudit`, `FakeDomainEvents`, `FakePayPalGateway`, `uuidv7`.

**As implemented in `packages/contracts/src/brain/` (v1, owner M2).** Differences from the sketch below:
- `Offer` has the five kinds; `OfferKind` keeps `"none"` only for rankings and exclusions. Pause `cycles` is 1–12, discount `percent` is 1–100, all dates are `IsoDateTime`.
- `OfferMenu.defaultByReason` must have an entry for **every** reason (null = no offer), so L1 never has a gap. `PolicyDocument.reasonPreferences` may leave reasons out (the engine has a default ranking).
- `PolicyDocument` limits are bounded (`version ≥ 1`, `maxCycles ≥ 1`, percents 1–100, counts ≥ 0).
- New `PolicyContext` (input to `computeMenu`/`evaluate`): `now`, `channel`, `reason`, `cancelIntent`, `offersPresentedThisSession`, `subscription: SubscriptionSnapshot`, `history: SubscriberHistory` (saves and pauses in 365 days, last pause end, refunds in 30 days) and `plans: PlanInfo[]`. Time is passed in so the engine stays pure.
- `Channel` now lives in `shared.ts` (moved by M3 in #22).
- New `SessionContext` (input to every `Agent` call, loaded fresh by M3 so the agent is stateless): ids, channel, policy, subscription, history, plans, `menu | null`, `transcript`, `presentedOfferId`, `fallbackLevel`, and an optional `locale` (from `CreateSessionRequest.locale`; template text and L1 replies use it until the classifier detects the subscriber's language).
- `AgentStreamEvent` is the part of `SessionStreamEvent` the agent emits (`agent.delta`, `agent.done`, `offer.presented`, `reason.chips`, `fallback.changed`); `shownTextHash` is sha256 hex. M3's `SessionStreamEvent` = this union + `action.update`, `session.closed`, `error`.
- `brainEventPayloads` (`session.offer_presented`, `policy.published`) are registered in `domainEventPayloads`; `brainJobs` has `llm.budget_reset` keyed by UTC day.
- `reasonPreferences[reason]` is an allowlist as well as a ranking: unlisted kinds are not offered for that reason, and `"none"` ends the list. Unranked reasons use `DEFAULT_REASON_PREFERENCES` from `packages/policy`.
- `FakeAgent` in `@keepwell/contracts/fakes`: one 1-cycle pause menu, scripted streamed reply, no-means-no on "cancel", one offer per session, card text from the offer.
- Policy versions (`brain/policy-api.ts`, #27): `PolicyDraft` is a `PolicyDocument` without `version` (strict: sending one is a 400); publishing assigns it. `StoredPolicy` is one immutable version (`document.version === version`). `PolicyStore` (`current`, `get`, `list` newest first, `publish`) is append-only, and `publish` throws `PolicyError("version_conflict")` when `baseVersion` isn't the latest, so two editors can't overwrite each other. `FakePolicyStore` is in the fakes. `PolicyError` codes: `unauthorized` 401, `not_found` 404, `invalid_request` 400, `invalid_policy` 422 (with `details: { path, message }[]`), `version_conflict` 409, `internal` 500.
- Dry-run returns, per sample, the fresh `PolicyContext` (reason `"unknown"`), the draft's `OfferMenu` and `offerIdsByReason`, so the editor can re-run `computeMenu` in the browser for any reason or edit. Up to 20 samples; ids that aren't the merchant's come back in `missingSubscriptionIds`. `problems` lists what publishing the draft would reject (`PolicyProblem { path, message }`), so the editor can flag it before Publish.

**As implemented in `packages/contracts/src/surfaces/` (v1, owner M3).** Differences from the sketch below and §4:
- `Channel` is in `shared.ts`. `Consent` hashes are `Sha256Hex`, with `offerHash = sha256(canonicalJson(offer))`; `ipPrefix` is the IP cut to /24 (IPv4) or /48 (IPv6).
- New `Session`: the `sessions` row as the merchant API lists it. `reason` is `"unknown"` until known; `outcome` and `closedAt` are null until closed. A cancel after a save reopens the session, so the last outcome wins.
- `SAVED_OUTCOME` maps each offer kind to its `saved_*` outcome. `summarizeSubscription(snapshot)` gives `SubscriptionSummary`, what the widget shows; its `price` is the discount override when one is active.
- HTTP bodies: `CreateSessionRequest` takes only `widget | portal` (agents use MCP) plus an optional `locale`. `CreateSessionResponse` adds `merchant: { name, supportContact }`, and `streamUrl` is absolute (it may carry a read-only ticket, so never log it). `PostMessageRequest` is trimmed, 1–1000 chars. `PostReasonRequest` has no `"unknown"`. `AcceptOfferResponse.approveUrl` is null rather than absent; it usually arrives later as `action.update`. `CancelRequest.reason` is a `ReasonCategory`.
- `SessionStreamEvent` = `AgentStreamEvent` + `action.update` (adds `actionType` and `error`) + `session.closed` + `error`. Each SSE frame is `id: <seq>` + `data: <JSON>`, with `seq` from 1 per session. `Last-Event-ID` (or `?after=<seq>`) replays what came after it. The stream ends after `session.closed`; reconnecting to a closed session with nothing new returns 204, which stops `EventSource` retrying.
- New `POST /sessions/:id/keep` → 204: "Keep my subscription", closes as `kept_without_offer`.
- Errors: `SessionErrorCode` and `SessionError` (which carries its HTTP status) fill the `ErrorEnvelope`.
- `SessionsApi` is the sessions API without HTTP; the routes, the subscriber MCP server and `FakeSessionsApi` share it. `SubscriberPrincipal` is what a credential resolves to.
- `surfacesEventPayloads`: `session.started`, `session.offer_accepted` (the whole `offer` instead of `offerId`, plus `actionIds`), `session.offer_declined`, `session.closed` (`reason` is a `ReasonCategory`).
- `FakeSessionsApi`, `PANTRY_PLAN` and `pantryPlanSubscription` are in `@keepwell/contracts/fakes`. `pnpm dev:fake-sessions` serves the fake over HTTP for building the widget.
- `surfaces/identity.ts`: `WidgetTokenClaims` (`{ mid, sid: PayPal subscription id, iat, exp, nonce }`, HS256, at most `WIDGET_TOKEN_TTL_SECONDS` = 600) and the demo store bodies (`DemoStoreVerifyRequest/Response`, `DemoStoreTokenRequest/Response`). Also `MagicLinkRequest`, `PortalClaims` (the PORTAL cookie: `{ kind: "portal", mid, eh: sha256 of the email, iat, exp }`, 24 h), `DelegationScope` (`read`, `cancel`, `accept_offer`) `CreateDelegationRequest/Response`, and what the portal page needs: `PortalSubscription`, `DelegationSummary`, `PortalMe`, `PortalTokenRequest/Response` and `PortalSessionTokenClaims` (`{ kind: "portal_session", mid, sub: our subscription id, iat, exp, nonce }`, HS256, at most 600 s; the sessions API accepts it as the `portal` channel for exactly that subscription), with `MAGIC_LINK_TTL_SECONDS` (15 min) and `DELEGATION_TTL_SECONDS` (7 days).

```ts
// ---------- shared ----------
export const Money = z.object({ value: z.string().regex(/^\d+\.\d{2}$/), currency: z.string().length(3) });

export const ReasonCategory = z.enum([
  "price", "low_usage", "missing_feature", "quality_issue",
  "temporary", "switching_competitor", "payment_problem", "other", "unknown",
]);

export const Channel = z.enum(["widget", "portal", "subscriber_agent"]);

export const Actor = z.enum(["subscriber", "agent", "policy", "merchant", "system", "subscriber_agent", "demo"]);

// ---------- subscriptions (owner M1) ----------
export const SubscriptionStatus = z.enum(["APPROVAL_PENDING", "APPROVED", "ACTIVE", "SUSPENDED", "CANCELLED", "EXPIRED"]);

export const SubscriptionSnapshot = z.object({
  id: z.string().uuid(),
  merchantId: z.string().uuid(),
  paypalSubscriptionId: z.string(),
  paypalPlanId: z.string(),
  planName: z.string(),
  price: Money,
  interval: z.object({ unit: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]), count: z.number().int() }),
  status: SubscriptionStatus,
  startedAt: z.string(),
  nextBillingTime: z.string().nullable(),
  lastPayment: z.object({ amount: Money, time: z.string() }).nullable(),
  outstandingBalance: Money.nullable(),
  failedPaymentsCount: z.number().int(),
  lastFailure: z.object({ reasonCode: z.string(), time: z.string(), nextRetryTime: z.string().nullable() }).nullable(),
  subscriberFirstName: z.string().nullable(),
  syncedAt: z.string(),
});

// ---------- offers & policy (owner M2) ----------
export const OfferKind = z.enum(["pause", "downgrade", "switch_annual", "discount", "refund_partial", "none"]);

export const Offer = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("pause"), cycles: z.number().int().min(1), resumesOn: z.string() }),
  z.object({ id: z.string(), kind: z.literal("downgrade"), toPlanId: z.string(), toPlanName: z.string(), newPrice: Money }),
  z.object({ id: z.string(), kind: z.literal("switch_annual"), toPlanId: z.string(), newPrice: Money, effectiveMonthly: Money }),
  z.object({ id: z.string(), kind: z.literal("discount"), percent: z.number().int(), cycles: z.number().int(), newPrice: Money, firstAffectedBilling: z.string() }),
  z.object({ id: z.string(), kind: z.literal("refund_partial"), amount: Money, ofPaymentOn: z.string() }),
]);

export const OfferMenu = z.object({
  policyVersion: z.number().int(),
  computedAt: z.string(),
  offers: z.array(Offer),                // may be empty
  defaultByReason: z.record(ReasonCategory, z.string().nullable()), // offer id for L1 fallback
  excluded: z.array(z.object({ kind: OfferKind, because: z.string() })), // for "explain"
});

export const PolicyDecision = z.object({
  allowed: z.boolean(),
  policyVersion: z.number().int(),
  offer: Offer.nullable(),
  violations: z.array(z.object({ rule: z.string(), message: z.string() })),
  explanation: z.array(z.string()),
});

export const PolicyDocument = z.object({
  version: z.number().int(),
  offers: z.object({
    pause:          z.object({ enabled: z.boolean(), maxCycles: z.number().int().max(12), cooldownDays: z.number().int() }),
    downgrade:      z.object({ enabled: z.boolean(), targets: z.record(z.string(), z.array(z.string())) }), // fromPlanId → [toPlanId]
    switch_annual:  z.object({ enabled: z.boolean(), targets: z.record(z.string(), z.string()) }),
    discount:       z.object({ enabled: z.boolean(), maxPercent: z.number().int().max(100), maxCycles: z.number().int() }),
    refund_partial: z.object({ enabled: z.boolean(), maxPercentOfLastPayment: z.number().int().max(100), maxPerMonth: Money }),
  }),
  eligibility: z.object({
    minTenureDaysForDiscount: z.number().int(),
    maxSavesPerSubscriberPer365d: z.number().int(),
  }),
  reasonPreferences: z.record(ReasonCategory, z.array(OfferKind)), // ranked offer kinds per reason
  tone: z.enum(["warm", "neutral", "brief"]),
  supportContact: z.string(),
});
// Engine-enforced and NOT configurable: max 1 offer per session; cancel intent → empty menu;
// discount only if next billing ≥ 10 days away; amounts never exceed the plan price.

// ---------- sessions (owner M3, agent behaviour M2) ----------
export const FallbackLevel = z.enum(["L0", "L1", "L2"]);

export const SessionState = z.enum(["open", "offer_presented", "awaiting_paypal", "closed"]);

export const SessionOutcome = z.enum([
  "saved_pause", "saved_downgrade", "saved_annual", "saved_discount", "saved_refund",
  "cancelled", "abandoned", "kept_without_offer",
]);

export const Consent = z.object({
  offerHash: z.string(),          // sha256 of canonical Offer JSON
  shownTextHash: z.string(),      // sha256 of the exact card + message text rendered
  at: z.string(),
  channel: Channel,
  ipPrefix: z.string().nullable(),
  userAgent: z.string().nullable(),
});

// ---------- actions (owner M1) ----------
export const ActionType = z.enum([
  "suspend", "activate", "cancel", "revise", "patch_price", "refund", "capture_outstanding", "create_plan",
]);

export const ActionState = z.enum([
  "PENDING", "EXECUTING", "RETRY_WAIT", "AWAITING_BUYER", "APPLIED", "CONFIRMED", "FAILED", "ABANDONED", "SUPERSEDED",
]);

export const ActionOrigin = z.enum(["session", "insight", "recovery", "schedule", "demo", "subscriber_agent"]);

export const Action = z.object({
  id: z.string().uuid(),
  merchantId: z.string().uuid(),
  subscriptionId: z.string().uuid().nullable(),     // null for create_plan
  type: ActionType,
  params: z.record(z.unknown()),
  state: ActionState,
  origin: ActionOrigin,
  attempts: z.number().int(),
  approveUrl: z.string().url().nullable(),           // revise only
  paypalDebugIds: z.array(z.string()),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------- audit (owner M1) ----------
export const AuditEntry = z.object({
  seq: z.number().int(),
  merchantId: z.string().uuid(),
  at: z.string(),
  actor: Actor,
  kind: z.string(),                     // e.g. "offer.presented", "action.confirmed", "policy.published"
  subjectIds: z.record(z.string()),     // { subscriptionId, sessionId, actionId, paypalSubscriptionId, ... }
  payload: z.record(z.unknown()),
  simulated: z.boolean(),
  prevHash: z.string(),
  hash: z.string(),
});

// ---------- insights (owner M5) ----------
export const InsightRecord = z.object({
  sessionId: z.string().uuid().nullable(),
  source: z.enum(["session", "winback_reply"]),
  reason: ReasonCategory,
  subReason: z.string().nullable(),
  featureRequests: z.array(z.string()),
  competitor: z.string().nullable(),
  sentiment: z.enum(["negative", "neutral", "positive"]),
  quote: z.string().max(160).nullable(),
});

export const InsightActionKind = z.enum(["create_plan", "update_policy", "send_winback_batch"]);

export const InsightAction = z.object({
  id: z.string().uuid(),
  kind: InsightActionKind,
  params: z.record(z.unknown()),
  rationale: z.string(),
  estimate: z.object({ monthlyRevenueImpact: Money, basis: z.string() }).nullable(), // computed deterministically
  state: z.enum(["proposed", "approved", "rejected", "executed", "failed"]),
  proposedBy: z.enum(["copilot", "merchant_mcp"]),
  actionId: z.string().uuid().nullable(),
});
```

### M5 growth types, as implemented
Code: `packages/contracts/src/growth/` (`InsightRecord`, `InsightAction`, `InsightActionProposal`, notifications, `DunningCase`, `growthJobs`, `growthEventPayloads`); `FakeNotifier` in `@keepwell/contracts/fakes`. Differences from the sketch above:

- `InsightRecord` gains `replyId`; exactly the id matching `source` is set. `quote` is at most 20 words (and 160 characters).
- `InsightAction` gains `merchantId`, `createdAt`, `decidedAt`. `InsightActionProposal` is a union on `kind` with typed `params` (checked before a row is written); the stored `params` stay a generic record.
- Notifications: `Notification` (outbox row, status `queued|sending|sent|failed|suppressed`, `suppressedBecause` `frequency_cap|unsubscribed|superseded`) and `OutboxResponse` (Demo Inbox) are new.
- `DunningCase`, `DunningPlaybook` and `DunningState` are new; `reasonCode` stays a free string.
- Job `dunning.evaluate` payload is `{ subscriptionId, failedCount }` (the idempotency key needs the count). `insights.extract` takes exactly one of `sessionId` or `replyId`.
- `notification.sent` payload is `{ notificationId, template, channel }`; `insight_action.proposed` is `{ insightActionId }`. Both are in `domainEventPayloads`.

---

## 2. Internal domain events

Emitted to the `domain_events` table and to Postgres `NOTIFY` (for the live feed). **Producers own the payload shape. Consumers must ignore fields they don't know.**

| Event | Producer | Consumers | Payload (beyond ids) |
|---|---|---|---|
| `subscription.synced` | M1 | M4 | snapshot |
| `subscription.status_changed` | M1 | M4, M5 | from, to |
| `subscription.plan_changed` | M1 | M1 (confirm revise), M4 | fromPlanId, toPlanId |
| `subscription.payment_failed` | M1 | **M5 recovery** | reasonCode, failedCount, nextRetryTime |
| `subscription.payment_completed` | M1 | M5 (close dunning), M4 | amount |
| `subscription.cancelled_externally` | M1 | **M5 win-back** | — |
| `session.started` | M3 | M4 | channel, fallbackLevel |
| `session.offer_presented` | M2 | M4 | offer, policyVersion |
| `session.offer_accepted` | M3 | M1, M4 | offerId, consent |
| `session.offer_declined` | M3 | M4 | offerId |
| `session.closed` | M3 | **M5 insights**, M4 | outcome, reason |
| `action.state_changed` | M1 | M3 (widget SSE), M4, M5 | from, to, error? |
| `notification.sent` | M5 | M4 | template, channel |
| `insight_action.proposed` | M5 | M4 | — |
| `policy.published` | M2 / M4 | M4 | version |

---

## 3. Jobs (pg-boss queue names)

| Queue | Owner | Payload | Idempotency key |
|---|---|---|---|
| `webhook.process` | M1 | `{ webhookEventId }` | webhookEventId |
| `action.execute` | M1 | `{ actionId }` | actionId |
| `action.confirm` | M1 | `{ actionId }` | actionId |
| `reconcile.subscription` | M1 | `{ subscriptionId }` | subscriptionId + minute |
| `reconcile.sweep` | M1 | `{ merchantId }` | merchantId + window |
| `reconcile.drift` | M1 | `{ merchantId }` | merchantId + UTC day (nightly drift report, #14) |
| `due.sweep` | M1 | `{}` | minute |
| `resume.due` | M1 | `{ scheduledResumeId }` | scheduledResumeId |
| `domain.dispatch` | M1 | `{ domainEventId, handler }` | domainEventId + handler |
| `dunning.evaluate` | M5 | `{ subscriptionId }` | subscriptionId + failedCount |
| `notify.dispatch` | M5 | `{ notificationId }` | notificationId |
| `winback.start` | M5 | `{ subscriptionId }` | subscriptionId |
| `insights.extract` | M5 | `{ sessionId }` or `{ replyId }` | source id |
| `insights.refresh_views` | M5 | `{}` | hour |
| `pool.health` | M1 | `{}` | 5-minute window |
| `llm.budget_reset` | M2 | `{}` | day |
| `sessions.abandon_sweep` | M3 | `{}` | 5-minute window |

---

## 4. HTTP API (`apps/api`, prefix `/v1` unless noted)

Auth types: **SUB** = subscriber token, **PORTAL** = portal session cookie, **DEL** = delegation token, **MER** = merchant cookie, **KEY** = merchant API key, **SIG** = PayPal signature, **DEMO** = Judge Mode lease, **–** = public.

### Subscriber surfaces (owner M3, agent internals M2)

| Method + path | Auth | Request → Response |
|---|---|---|
| `POST /sessions` | SUB / PORTAL | `{ channel }` → `{ sessionId, subscription: SubscriptionSummary, fallbackLevel, streamUrl }` |
| `GET /sessions/:id/stream` | SUB / PORTAL | SSE stream of `SessionStreamEvent` (below) |
| `POST /sessions/:id/messages` | SUB / PORTAL | `{ text (≤ 1000 chars) }` → `202` (reply arrives on the stream) |
| `POST /sessions/:id/reason` | SUB / PORTAL | `{ reason: ReasonCategory }` → `202` (L1 reason chips) |
| `POST /sessions/:id/offers/:offerId/accept` | SUB / PORTAL | `{ shownTextHash }` → `{ actionIds[], approveUrl? }` |
| `POST /sessions/:id/offers/:offerId/decline` | SUB / PORTAL | → `204` |
| `POST /sessions/:id/keep` | SUB / PORTAL | → `204` ("Keep my subscription": closes as `kept_without_offer`) |
| `POST /sessions/:id/cancel` | SUB / PORTAL | `{ reason? }` → `{ actionId }`. **Never touches the LLM.** Works in every state, including after a save. |
| `GET /revise/return` | – (signed `state` param) | PayPal return URL → HTML page that notifies the widget and closes |
| `POST /portal/magic-link` | – (rate limited) | `{ merchantSlug, email }` → `202` always (no account enumeration), answered before the lookup and send so timing says nothing either. Limited per IP (20/h) and per email hash (5/h); over the limit is `429` with `Retry-After`, the same whether or not the email matches |
| `GET /portal/verify` | – | `?token=` → sets the PORTAL cookie (`HttpOnly; Secure; SameSite=Lax`, 24 h) and redirects to the portal; a used, expired or unknown link redirects with `?error=link_expired`. 30 per 10 min per IP |
| `POST /delegations` | PORTAL | `{ subscriptionId, scopes[] }` → `201 { id, token (shown once, `kwd_` prefix), scopes, expiresAt }`. Only for a subscription the signed-in email owns (`403` otherwise); 10 per hour per subscriber. Cookie-authenticated writes must carry the portal's `Origin` |
| `GET /portal/me` | PORTAL | `PortalMe` (a same-origin GET needs no `Origin`; writes always do): the subscriptions on the signed-in email and the live (unrevoked, unexpired) delegations, never a token. `401` when signed out. `no-store` |
| `POST /portal/token` | PORTAL | `{ subscriptionId }` → `{ token, expiresAt }`, 10 minutes, for the portal's widget (`channel: "portal"`). `403` for a subscription the email doesn't own. Its own limit, 60 an hour per subscriber, so opening the widget can't lock out cancel |
| `POST /portal/logout` | PORTAL origin | `204`, clears the cookie |
| `DELETE /delegations/:id` | PORTAL | → `204`; an unknown or someone else's id is `404` |

```ts
export const SessionStreamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent.delta"), text: z.string() }),             // streamed reply text
  z.object({ type: z.literal("agent.done"), messageId: z.string() }),
  z.object({ type: z.literal("offer.presented"), offer: Offer, cardText: z.string(), shownTextHash: z.string() }),
  z.object({ type: z.literal("reason.chips"), reasons: z.array(ReasonCategory) }), // L1 mode
  z.object({ type: z.literal("fallback.changed"), level: FallbackLevel }),
  z.object({ type: z.literal("action.update"), actionId: z.string(), state: ActionState, approveUrl: z.string().nullable() }),
  z.object({ type: z.literal("session.closed"), outcome: SessionOutcome, summary: z.string() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
```

### Merchant (owner M4 unless noted)

The shared request/response schemas for merchant dashboard routes live in
`packages/contracts/src/platform/merchant.ts` and are exported from `@keepwell/contracts`.
They are the boundary types for the dashboard and merchant API; they do not implement
authentication, persistence, or route behavior. The audit verify result reuses `AuditVerifyResult`,
and the policy routes reuse the policy API schemas below the brain contracts. Merchant schemas cover
overview aggregates, subscriber filters/risk summaries/details, domain-event feed envelopes, audit
and timeline results, onboarding credential/webhook/backfill responses, and one-time API-key output.
The PayPal client secret is request-only and is explicitly rejected if echoed in a successful
credential response. Merchant login sets an HttpOnly session cookie and returns a CSRF token in the
JSON identity response; unsafe authenticated requests echo it in `X-Keepwell-CSRF`. The token is
never placed in a cookie accessible to JavaScript.

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /m/auth/login`, `POST /m/auth/logout`, `GET /m/me` | – / MER | Session |
| `GET /m/overview?from&to` | MER | KPIs (owner of the SQL: M5) |
| `POST /m/feed/ticket` | MER (+CSRF) | `MerchantFeedTicketResponse`: the feed's stream URL on the API's own host, with a read-only ticket for 1 h. The dashboard opens the feed there, because Render's static-site rewrite buffers streams |
| `GET /m/feed` | MER, or `?ticket=` | SSE live feed of domain events. `?after=<event id>` (or `Last-Event-ID`) resumes after that event |
| `GET /m/subscriptions?query&status&cursor` | MER | List |
| `GET /m/subscriptions/:id` | MER | Snapshot + sessions + actions |
| `GET /m/subscriptions/:id/timeline` | MER | Bryntum-ready `{ resources[], events[] }` |
| `GET /m/timeline?from&to` | MER | All subscribers for the scheduler view |
| `GET /m/audit?cursor&kind&subject` | MER | Audit entries |
| `GET /m/audit/verify` | MER | `{ ok, checked, brokenAtSeq? }` (owner M1) |
| `GET /m/policies`, `GET /m/policies/:version` | MER | Policy history (owner M2): `ListPoliciesResponse`, `PolicyVersionResponse` |
| `POST /m/policies` | MER | `PublishPolicyRequest { baseVersion, document: PolicyDraft, changeNote? }` → `PolicyVersionResponse`. Validated by `packages/policy`; 409 `version_conflict` on a stale base (owner M2) |
| `POST /m/policies/dry-run` | MER | `PolicyDryRunRequest { document: PolicyDraft, sampleSubscriptionIds[1..20] }` → `PolicyDryRunResponse` (owner M2) |
| `GET /m/insights?from&to` | MER | Aggregates + top quotes (owner M5) |
| `POST /m/copilot/messages` | MER | SSE chat (owner M5) |
| `GET /m/insight-actions`, `POST /m/insight-actions/:id/approve`, `POST …/reject` | MER | (owner M5) |
| `GET /m/outbox` | MER | Demo Inbox (owner M5) |
| `POST /m/onboarding/credentials` | MER | Verify + store PayPal app credentials |
| `POST /m/onboarding/webhook` | MER | Register the webhook with PayPal |
| `POST /m/onboarding/backfill` | MER | Import plans + subscriptions → job ids |
| `POST /m/api-keys`, `DELETE /m/api-keys/:id` | MER | Keys for merchant MCP |

### Platform (owner M1)

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /webhooks/paypal/:merchantId` (no `/v1`) | SIG | Ingest; returns 200 fast |
| `GET /healthz`, `GET /readyz`, `GET /status` (no `/v1`) | – | Health |
| `GET /ops` | MER (admin) | Internal metrics page data |

### Demo / Judge Mode (owner M3, pool M1)

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /demo/leases` | – (10 issued leases an hour per IP; a `pool_empty` answer doesn't count) | Lease a pooled subscription for 30 minutes → `201 { leaseId, leaseToken, expiresAt, subscriptionId }`. `leaseToken` is the DEMO bearer (`JudgeLeaseClaims`, its own secret). Every DEMO route checks `JudgePool.holds` too, so a returned lease's token is `401` at once, even when the next judge holds the same entry. Empty pool → `503 pool_empty`: show the fallback |
| `POST /demo/leases/:id/token` | DEMO | `{ token, expiresAt }`: a 10-minute widget token for the leased subscription, for the widget's token callback |
| `DELETE /demo/leases/:id` | DEMO | Return to pool → `{ result: "available" \| "restoring" \| "consumed" }`, decided from PayPal's state. Settles only this exact lease (`release(…, leasedUntil)`) |
| `POST /demo/time-machine/resume/:subscriptionId` | DEMO (that lease's subscription only) | Run the pause's scheduled resume now (a real `activate`) → `{ resumed, actionId, label: "TIME SHIFT", simulated: true, note }`; audited as `demo.time_shift` with `simulated: true`. A second press reports the resume that already ran |
| `POST /demo/time-machine/dunning/:subscriptionId` | DEMO | Send scheduled dunning now |
| `POST /demo/simulate/payment-failed/:subscriptionId` | DEMO | Inject a **SIMULATED** failure (only if spike Q5 fails) |
| `POST /demo-store/subscriptions` | – | Pantry Plan's "backend": `{ paypalSubscriptionId }` → GETs it from PayPal; only ACTIVE/APPROVED on a Pantry Plan plan → `{ status, planName, shopperToken }` |
| `POST /demo-store/token` | – | Pantry Plan's "backend": `{ shopperToken }` → `{ token, expiresAt }`, a 10-minute widget token for that shopper's subscription |

### Agent surfaces (owner M3)

| Endpoint | Auth | Tools |
|---|---|---|
| `/mcp/subscriber` (streamable HTTP) | DEL | `get_my_subscription`, `get_retention_options`, `accept_offer`, `cancel_subscription` |
| `/mcp/merchant` (streamable HTTP) | KEY | `query_metric`, `search_quotes`, `compare_cohorts`, `list_plans`, `list_at_risk`, `propose_action` |
| `/.well-known/keepwell-agent.json` | – | Discovery: MCP URL, auth method, a plain-language honesty policy |

---

## 5. Module interfaces inside the API

These are TypeScript interfaces, so modules can be mocked before they exist.

```ts
// M1 → everyone
// As implemented in packages/contracts/src/platform/interfaces.ts
interface PayPalGateway {
  getSubscription(merchantId: string, paypalSubscriptionId: string): Promise<PayPalSubscription>;
  listSubscriptions(merchantId: string, q: { statusUpdatedAfter?: string; planIds?: string[]; page?: number }): Promise<Page<PayPalSubscriptionSummary>>;
  // Summaries ({ id, status, create_time? }) and null totals: the sandbox's list has nothing more
  // (fixtures/spikes/gateway). getSubscription for the rest; page on until a page comes back empty.
  // mutations are NOT exposed here; use ActionEngine. Errors: PayPalGatewayError.
}
interface ActionEngine {
  create(input: ActionCreateInput, tx?: Tx): Promise<Action>;          // typed params per type, optional idempotencyKey
  get(merchantId: string, actionId: string): Promise<Action | null>;   // merchant-scoped
  scheduleResume(input: { merchantId; subscriptionId; dueAt; afterActionId? }, tx?: Tx): Promise<string>; // scheduled resume id
  // afterActionId (#11): a pause's suspend, written in the same tx. The resume waits until that suspend
  // is APPLIED and is cancelled if it fails or is superseded.
}
interface Audit {
  append(entry: AuditAppendInput, tx?: Tx): Promise<AuditEntry>;      // log sets seq, at, prevHash, hash
}
interface DomainEvents {
  // merchantId lives on the envelope, so payloads don't repeat it
  emit<T extends DomainEventType>(event: { type: T; merchantId: string; payload: DomainEventPayload<T>; simulated?: boolean }, tx?: Tx): Promise<void>;
  on<T extends DomainEventType>(type: T, handlerName: string, fn: (e: DomainEvent<T>) => Promise<void>): void;
}

// M1 → M3 (Judge Mode, §6.17). As implemented in packages/contracts/src/platform/interfaces.ts; FakeJudgePool in fakes.
interface JudgePool {
  lease(merchantId: string, input?: { minutes?: number }): Promise<PoolLease | null>;  // 30 min default; longest-unused first; null = none available, show the fallback
  holds(merchantId: string, poolEntryId: string, leasedUntil: string): Promise<boolean>; // this exact lease is still live: check on every lease-token request
  release(merchantId: string, poolEntryId: string, leasedUntil?: string): Promise<PoolReturn | null>; // "available" | "restoring" | "consumed", from PayPal's state; null = that lease isn't live
  counts(merchantId: string): Promise<Record<PoolState, number>>;                     // available, leased, restoring, consumed
}
// PoolLease = { poolEntryId, subscriptionId, paypalSubscriptionId, leasedUntil }. Entries are lent again and again,
// so a lease is the pair (poolEntryId, leasedUntil), whole seconds; a returned entry rests one widget-token lifetime
// (10 min) before it is lent again. Leases end on their own at
// leasedUntil (pool.health, every 5 min). On return: cancelled or another plan → consumed; paused → activate;
// discounted → plan price back (both as Actions, "restoring" until PayPal shows it whole); the judge's pending resumes are cancelled.

// M2 → M3, M4, evals
// As implemented in packages/contracts/src/brain/agent.ts (stream: AgentStreamEvent)
interface Agent {
  start(session: SessionContext): Promise<{ menu: OfferMenu; fallbackLevel: FallbackLevel }>;
  respond(session: SessionContext, text: string, stream: (e: SessionStreamEvent) => void): Promise<void>;
  respondToReason(session: SessionContext, reason: ReasonCategory, stream: (e: SessionStreamEvent) => void): Promise<void>;
}
// packages/policy (pure)
declare function computeMenu(policy: PolicyDocument, ctx: PolicyContext): OfferMenu;
declare function evaluate(policy: PolicyDocument, ctx: PolicyContext, offerId: string, menu: OfferMenu): PolicyDecision;
declare function evaluateAcceptance(policy: PolicyDocument, freshCtx: PolicyContext, presented: { offer: Offer; policyVersion: number }): PolicyDecision;

// M2 → M3 (current policy for sessions), M4 (editor). As implemented in packages/contracts/src/brain/policy-api.ts
interface PolicyStore {
  current(merchantId: string): Promise<StoredPolicy | null>;
  get(merchantId: string, version: number): Promise<StoredPolicy | null>;
  list(merchantId: string): Promise<PolicyVersionSummary[]>;          // newest first
  publish(input: PublishPolicyInput, tx?: Tx): Promise<StoredPolicy>;  // append-only; PolicyError("version_conflict") on a stale base
}

// M5 → everyone (M1 job handlers, M4 cockpit)
// As implemented in packages/contracts/src/growth/notifier.ts
interface Notifier {
  // Inserts an outbox row in the caller's transaction; notify.dispatch sends it later. Returns the notification id.
  // Rejects (never throws synchronously) if the request breaks the contract.
  enqueue(n: NotificationRequest, tx?: Tx): Promise<string>;
  // Withdraws a still-queued message (suppressed because "superseded"); false if already sent/sending/suppressed.
  supersede(merchantId: string, notificationId: string, tx?: Tx): Promise<boolean>;
}
// NotificationRequest = { merchantId, subscriptionId | null, to, content: NotificationContent, dueAt?, simulated (default false) }
// NotificationContent = discriminated union on `template`; each payload holds facts only (amounts, dates, links).
// Templates: dunning.* (5), winback.ask, portal.sign_in { signInUrl, expiresInMinutes }. portal.sign_in is sent past the
// frequency cap and the unsubscribe list (the subscriber just asked for it) and doesn't count toward the cap.
```

---

## 6. Fixtures every member can use from day 1

`packages/paypal-mock` starts with hand-written fixtures from PayPal's OpenAPI examples, then gets real recordings from the spikes:
- Demo merchant **Pantry Plan** with plans Lite $6/mo, Standard $12/mo, Standard Annual $120/yr, and a DAY-interval test plan.
- 12 named subscribers in different states (Maya: ACTIVE 8 months; Raj: 2 failed payments with `PAYER_CANNOT_PAY`; Ana: SUSPENDED; Tom: cancelled inside PayPal; …).
- Webhook payloads for each event type, with valid-looking (mock-verified) headers.
