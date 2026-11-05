# modules/mcp (owner: Aditya, M3)

`subscriber.ts`: the subscriber-agent MCP server (ARCHITECTURE.md §6.14, #41) at `POST /mcp/subscriber`, streamable HTTP, stateless, plus the discovery document at `GET /.well-known/keepwell-agent.json`.

- **Auth:** `Authorization: Bearer kwd_…`, a delegation token the subscriber creates in the portal. Only the tools its scopes allow are listed, and each call re-checks the token, so a revoked token stops working mid-conversation.
- **Tools:**
  - `get_my_subscription` (read).
  - `get_retention_options` (read): the policy's menu as structured offers, always with the note that cancelling is one call.
  - `accept_offer(offer_id)` (accept_offer).
  - `cancel_subscription(reason?)` (cancel).
- **Behind it:** `DbSessionsApi`'s `agent*` methods. Same policy (re-checked at accept), same Action engine, same audit log; the session's channel is `subscriber_agent` and audit entries say `actor: subscriber_agent`. No model is involved: the menu comes from the policy engine. Cancel needs no prior call and never touches the agent.

Mounting it in `platform.ts` comes with the sessions module's wiring (#32). To try it with Claude Desktop, add a remote MCP server with the URL from the discovery document and the token as a bearer header.
