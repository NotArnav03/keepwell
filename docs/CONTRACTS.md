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
- `Channel` lives here until it moves to `shared.ts`.
- New `SessionContext` (input to every `Agent` call, loaded fresh by M3 so the agent is stateless): ids, channel, policy, subscription, history, plans, `menu | null`, `transcript`, `presentedOfferId`, `fallbackLevel`.
- `AgentStreamEvent` is the part of `SessionStreamEvent` the agent emits (`agent.delta`, `agent.done`, `offer.presented`, `reason.chips`, `fallback.changed`); `shownTextHash` is sha256 hex. M3's `SessionStreamEvent` = this union + `action.update`, `session.closed`, `error`.
- `brainEventPayloads` (`session.offer_presented`, `policy.published`) are registered in `domainEventPayloads`; `brainJobs` has `llm.budget_reset` keyed by UTC day.
- `reasonPreferences[reason]` is an allowlist as well as a ranking: unlisted kinds are not offered for that reason, and `"none"` ends the list. Unranked reasons use `DEFAULT_REASON_PREFERENCES` from `packages/policy`.
- `FakeAgent` in `@keepwell/contracts/fakes`: one 1-cycle pause menu, scripted streamed reply, no-means-no on "cancel", one offer per session, card text from the offer.

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
| `POST /sessions/:id/cancel` | SUB / PORTAL | `{ reason? }` → `{ actionId }`. **Never touches the LLM.** |
| `GET /revise/return` | – (signed `state` param) | PayPal return URL → HTML page that notifies the widget and closes |
| `POST /portal/magic-link` | – (rate limited) | `{ merchantSlug, email }` → `202` always (no account enumeration) |
| `GET /portal/verify` | – | `?token=` → sets PORTAL cookie, redirects |
| `POST /delegations` | PORTAL | `{ subscriptionId, scopes[] }` → `{ token (shown once), expiresAt }` |
| `DELETE /delegations/:id` | PORTAL | → `204` |

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

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /m/auth/login`, `POST /m/auth/logout`, `GET /m/me` | – / MER | Session |
| `GET /m/overview?from&to` | MER | KPIs (owner of the SQL: M5) |
| `GET /m/feed` | MER | SSE live feed of domain events |
| `GET /m/subscriptions?query&status&cursor` | MER | List |
| `GET /m/subscriptions/:id` | MER | Snapshot + sessions + actions |
| `GET /m/subscriptions/:id/timeline` | MER | Bryntum-ready `{ resources[], events[] }` |
| `GET /m/timeline?from&to` | MER | All subscribers for the scheduler view |
| `GET /m/audit?cursor&kind&subject` | MER | Audit entries |
| `GET /m/audit/verify` | MER | `{ ok, checked, brokenAtSeq? }` (owner M1) |
| `GET /m/policies`, `GET /m/policies/:version` | MER | Policy history (owner M2) |
| `POST /m/policies` | MER | Publish a new version (validated by `packages/policy`) |
| `POST /m/policies/dry-run` | MER | `{ document, sampleSubscriptionIds[] }` → menus per sample |
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
| `POST /demo/leases` | – (rate limited) | Lease a pooled subscription → `{ leaseId, subscriberToken, expiresAt }` |
| `DELETE /demo/leases/:id` | DEMO | Return to pool (or mark consumed) |
| `POST /demo/time-machine/resume/:subscriptionId` | DEMO | Run the scheduled resume now (real `activate`) |
| `POST /demo/time-machine/dunning/:subscriptionId` | DEMO | Send scheduled dunning now |
| `POST /demo/simulate/payment-failed/:subscriptionId` | DEMO | Inject a **SIMULATED** failure (only if spike Q5 fails) |
| `POST /demo-store/token` | – | Pantry Plan's "backend": signs a widget token for a logged-in demo shopper |

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
  listSubscriptions(merchantId: string, q: { statusUpdatedAfter?: string; planIds?: string[]; page?: number }): Promise<Page<PayPalSubscription>>;
  // mutations are NOT exposed here; use ActionEngine. Errors: PayPalGatewayError.
}
interface ActionEngine {
  create(input: ActionCreateInput, tx?: Tx): Promise<Action>;          // typed params per type, optional idempotencyKey
  get(merchantId: string, actionId: string): Promise<Action | null>;   // merchant-scoped
  scheduleResume(input: { merchantId; subscriptionId; dueAt }, tx?: Tx): Promise<string>; // scheduled resume id
}
interface Audit {
  append(entry: AuditAppendInput, tx?: Tx): Promise<AuditEntry>;      // log sets seq, at, prevHash, hash
}
interface DomainEvents {
  // merchantId lives on the envelope, so payloads don't repeat it
  emit<T extends DomainEventType>(event: { type: T; merchantId: string; payload: DomainEventPayload<T>; simulated?: boolean }, tx?: Tx): Promise<void>;
  on<T extends DomainEventType>(type: T, handlerName: string, fn: (e: DomainEvent<T>) => Promise<void>): void;
}

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

// M5 → M4
interface Notifier {
  enqueue(n: { merchantId: string; to: string; template: TemplateId; payload: object; dueAt?: string }, tx?: Tx): Promise<string>;
}
```

---

## 6. Fixtures every member can use from day 1

`packages/paypal-mock` starts with hand-written fixtures from PayPal's OpenAPI examples, then gets real recordings from the spikes:
- Demo merchant **Pantry Plan** with plans Lite $6/mo, Standard $12/mo, Standard Annual $120/yr, and a DAY-interval test plan.
- 12 named subscribers in different states (Maya: ACTIVE 8 months; Raj: 2 failed payments with `PAYER_CANNOT_PAY`; Ana: SUSPENDED; Tom: cancelled inside PayPal; …).
- Webhook payloads for each event type, with valid-looking (mock-verified) headers.
