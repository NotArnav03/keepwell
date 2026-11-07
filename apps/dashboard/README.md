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

The shell and screens use the shared merchant contracts and typed API client. Merchant session
authentication, owner provisioning, subscriber list/detail, audit list/verify, timeline fallback,
credential/webhook/backfill routes, and persistent policy list/publish/dry-run routes are mounted.
Domain events are streamed over SSE using PostgreSQL LISTEN/NOTIFY. The overview KPI SQL remains
owned by M5; the dashboard shows an explicit API error until that endpoint is connected rather than
fabricated values. The timeline remains an accessible event-list fallback until the Bryntum licence
is confirmed.
