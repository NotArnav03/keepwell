# modules/mcp (owner: Aditya, M3)

`subscriber.ts`: the subscriber-agent MCP server (ARCHITECTURE.md §6.14, #41) at `POST /mcp/subscriber`, streamable HTTP, stateless, plus the discovery document at `GET /.well-known/keepwell-agent.json`.

- **Auth:** `Authorization: Bearer kwd_…`, a delegation token the subscriber creates in the portal. Only the tools its scopes allow are listed, and each call re-checks the token, so a revoked token stops working mid-conversation.
- **Rate limits:** 300 requests a minute per IP, counted before the token is checked so guessing tokens is slow, and 120 a minute per token (stateless MCP spends about three requests a tool call). Over either, `429` with `Retry-After`.
- **Tools:**
  - `get_my_subscription` (read).
  - `get_retention_options` (read): the policy's menu as structured offers, always with the note that cancelling is one call.
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
