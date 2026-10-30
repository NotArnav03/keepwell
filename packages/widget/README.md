# @keepwell/widget (owner: Aditya, M3)

The cancel-moment widget: Preact in a Shadow DOM, one script tag, about 12 KB gzipped (budget 50 KB, checked by `pnpm test`).

```html
<a href="/account/cancel" data-keepwell-cancel>Cancel subscription</a>
<script src="https://widget.keepwell…/v1.js" data-api="https://api.keepwell…"
        data-token-endpoint="/keepwell-token" data-support="help@yourshop.example" async></script>
```

| Attribute | |
|---|---|
| `data-api` | Keepwell API origin (required) |
| `data-token-endpoint` | The merchant's own route; `POST` returns `{ token }` (the signed subscriber token) |
| `data-token` | A fixed token. Local development against the fake server only |
| `data-support` | Shown when our API is unreachable |
| `data-autopay-url` | PayPal's autopay page (default: sandbox) |
| `data-locale` | Defaults to `navigator.language` |

Every `[data-keepwell-cancel]` opens the widget; `window.Keepwell.open()` does too. Until the script has loaded, or if it never does, the merchant's own link still works.

**Honest by design:** "Cancel now" is on every screen and never goes through the AI. If our API is down (L2), it becomes a link to PayPal's autopay page.

## Develop

```bash
pnpm dev:fake-sessions   # the sessions API on fakes, :3000
pnpm dev:widget          # dev page on :5177 (its own origin): http://localhost:5177/?scenario=downgrade
```

Scenarios: `pause`, `downgrade` (opens a fake PayPal approval popup), `annual`, `discount`, `refund`, `none`, `l1` (AI down, reason chips), plus an "API down" link for L2.

## Layout

- `state.ts`: a pure reducer from stream events to what's on screen (one offer, replay dedupe, cancel state)
- `transport.ts`: fetch and EventSource client. Imports **types only** from `@keepwell/contracts`: its zod schemas alone are ~100 KB gzipped, so the widget checks shape lightly and relies on the API validating with zod before sending
- `widget.tsx`, `mount.tsx`, `styles.ts`: the UI, the Shadow DOM, scoped CSS
- `index.ts`: the script-tag bootstrap
