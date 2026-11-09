# Merchant dashboard

The dashboard is a React/Vite static site. `pnpm dev` proxies `/v1` to the local API on port 3000;
set `VITE_API_BASE_URL` at build time when the deployed API is on a different origin.

## Local merchant login

1. Configure a local database and sandbox/mock PayPal settings in the root `.env`.
2. Set `SESSION_SECRET` to at least 32 random bytes and `DASHBOARD_URL=http://localhost:5173`.
3. Start the API with `pnpm dev:api`, then seed Pantry Plan with `pnpm seed`.
4. In `.env`, set `MERCHANT_BOOTSTRAP_EMAIL` and `MERCHANT_BOOTSTRAP_PASSWORD` (12+ bytes), then
   run `pnpm --filter @keepwell/api merchant:user`. The command stores an Argon2id hash and does not
   print the password.
5. Start the dashboard with `pnpm --filter @keepwell/dashboard dev` and sign in with that account.

To exercise PayPal onboarding, use sandbox mode (not the PayPal mock) and set
`PAYPAL_CREDENTIALS_ENCRYPTION_KEY` to a base64-encoded random 32-byte key. The API verifies
credentials through the PayPal gateway, encrypts the client secret with AES-256-GCM, registers the
webhook, imports plan details, and queues a subscription reconciliation sweep. Back up the key
securely; losing it makes stored merchant secrets undecryptable.

Never commit `.env`, share credentials in chat, or use live PayPal credentials.

## Integration status

The shell and screens use the shared merchant contracts and typed API client. Everything the
dashboard calls is served: merchant sign-in and owner provisioning, `GET /v1/m/overview` (the
figures on the Overview), subscribers list and detail, audit list and verify, the timeline, the
live feed (SSE over PostgreSQL LISTEN/NOTIFY), policy list, publish and dry-run, API keys
(`/v1/m/api-keys`, which unlock the merchant MCP server), and the onboarding routes (credentials,
webhook, backfill; these mount only in sandbox mode with `PAYPAL_CREDENTIALS_ENCRYPTION_KEY`, so
they have not been run here against a real sandbox app).

## The look

A ledger, in PayPal's colours: warm paper, ink, a navy cloth menu with gold-foil lettering, ruled
tables, stamped status words and a sealed record. Each page has its own layout: Overview is a day
book, Subscribers a register with a folio beside it, Policies a rulebook of sentences with a live
try-out, Audit the hash chain drawn with a seal that Verify re-checks, Timeline a swimlane (one lane
per subscriber, shape and colour per kind, a list view for accessibility), Onboarding three numbered
entries. Colours, spacing and fonts come from `packages/ui` (`--kw-*`); its tests check text
contrast, and the chart colours were validated on both papers with the data-viz palette validator.
The timeline is our own SVG, not Bryntum Scheduler: no Bryntum dependency is added until the licence
is confirmed in writing (see `docs/spikes/Q8.md`).

## Insights

`#insights` is the merchant insights page: overview for a date range (7, 30 or 90 days, or a custom
range), at-risk subscribers, the copilot chat, the insight-action queue and the Demo Inbox. Every
figure is taken from the API response. An endpoint that answers 404 is shown as not available yet.
