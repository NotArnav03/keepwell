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
