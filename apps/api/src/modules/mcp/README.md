# modules/mcp (owner: Aditya, M3)

`subscriber.ts`: the subscriber-agent MCP server (ARCHITECTURE.md §6.14, #41) at `POST /mcp/subscriber`, streamable HTTP, stateless, plus the discovery document at `GET /.well-known/keepwell-agent.json`.

- **Auth:** `Authorization: Bearer kwd_…`, a delegation token the subscriber creates in the portal. Only the tools its scopes allow are listed, and each call re-checks the token, so a revoked token stops working mid-conversation.
- **Rate limits:** 300 requests a minute per IP, counted before the token is checked so guessing tokens is slow, and 120 a minute per token (stateless MCP spends about three requests a tool call). Over either, `429` with `Retry-After`.
- **Tools:**
  - `get_my_subscription` (read).
  - `get_retention_options` (read): the policy's menu as structured offers, always with the note that cancelling is one call. Plan changes (`downgrade`, `switch_annual`) are left out and refused at accept: they apply only after the subscriber approves them on PayPal's page, and an agent has no way to get that link to them, so the subscriber makes them in the portal.
  - `accept_offer(offer_id)` (accept_offer).
  - `cancel_subscription(reason?)` (cancel).
- **Behind it:** `DbSessionsApi`'s `agent*` methods. Same policy (re-checked at accept), same Action engine, same audit log; the session's channel is `subscriber_agent` and audit entries say `actor: subscriber_agent`. No model is involved: the menu comes from the policy engine. Cancel needs no prior call and never touches the agent.

Mounting it in `platform.ts` comes with the sessions module's wiring (#32).

## Try it locally (fake server)

`pnpm dev:fake-sessions` mounts the real MCP server over `fake.ts`, a faked agent API on FakeSessionsApi. Actions move as the fake PayPal moves them, so a pause shows as SUSPENDED in `get_my_subscription` a second or two later.

1. Run `pnpm dev:fake-sessions` and `pnpm dev:portal`.
2. In the portal (http://localhost:5178), sign in as `maya@example.com`; the link is in the fake server's log. Under "Let an AI assistant manage this", tick the scopes and create a token.
3. Point an MCP client at `http://localhost:3000/mcp/subscriber` with the header `Authorization: Bearer <token>`. With Claude Code:

   ```bash
   claude mcp add --transport http keepwell http://localhost:3000/mcp/subscriber --header "Authorization: Bearer <token>"
   ```

   Then ask: "Pause my Pantry Plan subscription."

For the recorded Claude Desktop demo, use the deployed URL once it is mounted on staging.

## Merchant MCP server (#45)

`POST /mcp/merchant`, streamable HTTP and stateless like the subscriber server. It runs retention from Claude Desktop (or any MCP client) with a **merchant API key**.

- **Keys:** the dashboard creates them (`POST /v1/m/api-keys`, owner or admin, CSRF-checked) with a name and scopes, and shows the token once. It looks like `kwk_` plus 43 characters. Only its sha256 is stored (`merchant_api_keys`, row-level security like every tenant table). `GET` lists keys without tokens, `DELETE /v1/m/api-keys/:id` revokes at once. Creating and revoking are in the audit log by key id and name, never by token.
- **Auth:** `Authorization: Bearer kwk_...`. Anything else is `401`. The key is checked again at every tool call, so a revoked key stops mid-session. Rate limits: 300 a minute per IP (before the key is looked at), 120 per key.
- **Tools** (a key sees only the ones its scopes allow): `query_metric`, `search_quotes`, `compare_cohorts`, `list_plans` (the copilot's read-only tools, same validation and SQL), `list_at_risk` (open failed-payment cases, no names or emails) and `propose_action`.
- **Nothing executes from here.** `propose_action` only inserts an `insight_actions` row in state `proposed` (`proposed_by = merchant_mcp`, with the rationale), emits `insight_action.proposed` and writes an audit entry. A signed-in merchant user approves or rejects it in the dashboard, and only then does the action engine act. A free plan or an unknown kind is refused in code.
- **Try it:** create a key in the dashboard, then `claude mcp add --transport http keepwell-merchant https://<api>/mcp/merchant --header "Authorization: Bearer kwk_..."` and ask "How many saves did we get last week, and what's at risk?".

