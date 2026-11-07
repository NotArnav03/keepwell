# modules/sessions (owner: Aditya, M3)

HTTP + SSE for `/v1/sessions/*` (CONTRACTS.md §4). `routes.ts` only speaks HTTP; the session logic sits behind `SessionsApi` from `@keepwell/contracts`. The real implementation (#32) and `FakeSessionsApi` both plug into the same routes.

## Fake sessions server (build the widget without the API)

```bash
pnpm dev:fake-sessions        # http://localhost:3000, local only, nothing stored
```

The bearer token picks a scenario: `Authorization: Bearer fake:<scenario>` (append `:portal` for a portal session). No header means `pause`.

| Scenario | What the agent offers |
|---|---|
| `pause` | Pause 2 months |
| `downgrade` | Lite at 6.00 USD. The Action waits on a fake PayPal approval page (`approveUrl`) |
| `annual` | Standard Annual at 120.00 USD |
| `discount` | 25% off for 3 cycles |
| `refund` | 6.00 USD back on the last payment |
| `none` | Nothing, only Cancel |
| `l1` | AI down: reason chips; `price`, `temporary` and `low_usage` have default offers |

`streamUrl` carries `?fake=<scenario>`, so `new EventSource(streamUrl)` works without headers. Actions move like PayPal: EXECUTING after 0.3 s, APPLIED after about 1 s, CONFIRMED 5 s later.

```bash
curl -s -X POST localhost:3000/v1/sessions -H 'content-type: application/json' \
  -H 'authorization: Bearer fake:pause' -d '{"channel":"widget"}'
curl -N "localhost:3000/v1/sessions/<id>/stream?fake=pause"     # in a second terminal
curl -X POST localhost:3000/v1/sessions/<id>/messages -H 'content-type: application/json' \
  -H 'authorization: Bearer fake:pause' -d '{"text":"I am travelling for two months"}'
```

## The real module (#32)

`service.ts` is `DbSessionsApi`: the fake's rules, kept in Postgres.

| Table | What it holds |
|---|---|
| `sessions` | state, reason, fallback level, outcome |
| `offers` | one row per session: the menu computed at start, the one offer shown (card text and hash), the answer, the consent |
| `messages` | the transcript, redacted (`redact.ts`: emails, phone and card numbers) |
| `session_events` | every SSE frame, numbered per session, for replay from `Last-Event-ID` |

- Every write locks the session's row, so concurrent clicks and PayPal's answers apply in order.
- `subscribe` watches before it replays, then follows by an in-process wake (`feed.ts`) plus a 1 s poll, so events written by another instance or by the domain-event worker still arrive.
- `accept` re-checks the offer with `evaluateAcceptance` against today's policy and subscription. A pause's resume is tied to its suspend (`afterActionId`).
- The session's Actions are keyed `<sessionId>:<offerId>` and `<sessionId>:cancel:<n>`. Register `onActionStateChanged` for `action.state_changed`: it streams `action.update` and closes the session when its Action applies. A cancel pre-empts an offer still being applied.
- `cancel` never touches the agent (a test runs it with an agent that throws).

`auth.ts` is the `authenticate` for the routes: the merchant's widget token, the portal's session token, or a stream ticket (`?ticket=`, for that one session's stream; `create()` puts it in `streamUrl` via `signStreamTicket`).

Wiring into `platform.ts` (Arnav, with #41, once #124 lands) needs:

- a Postgres `PolicyStore` and `MerchantCatalog` (#124);
- `onActionStateChanged` registered on `action.state_changed`;
- the `sessions.abandon_sweep` job: `jobs.work("sessions.abandon_sweep", () => sessions.abandonIdle())` and `jobs.schedule("sessions.abandon_sweep", "*/5 * * * *", {})`. It closes `open` and `offer_presented` sessions untouched for 30 minutes as `abandoned`, never one waiting on PayPal, and cancel still works on them afterwards;
- the secrets below.

Secrets:

- `WIDGET_TOKEN_SECRET` signs widget tokens for the demo merchant only. `demoMerchantWidgetSecret(demoMerchantId, secret)` returns null for every other merchant, so no other merchant's token is accepted. **After the hackathon**, per-merchant secrets in `merchants.keepwell_signing_secret_enc` replace it (creating them, encrypting them, and showing them to the merchant).
- `SESSION_TICKET_SECRET` signs stream tickets. It is separate from every other secret, so either can be rotated alone.

Streams and the database: `subscribe` polls once a second only while it is needed. It stops when the session closes, and the route ends a stream with no event for 12 minutes (`idleMs`). A reconnect to a session that is quiet and not waiting on PayPal gets 204, so the browser stops retrying. The widget reopens the stream from its last event whenever the subscriber acts. An open tab therefore doesn't keep Neon's compute awake.

Tests: `service.db.test.ts` runs against Postgres (`KEEPWELL_TEST_DATABASE_URL`, as in CI); locally `docker run -d -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:18` is enough.

## Rate limits

`sessionRoutes` takes an optional `rateLimits` (#26). With `defaultSessionRateLimits()`, one IP gets 10 new sessions and 30 messages or reason taps a minute; past that the route answers 429 `limit_reached` with `Retry-After`. Cancel is never limited. The limits are in memory (one Render instance), and the daily LLM budget guard sits behind them. Behind Render's proxy, `request.ip` needs Fastify's `trustProxy`.
