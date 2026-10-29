# apps/api

**Owner: Arnav (M1 Rails, platform shell).** The one Render service: HTTP API, webhooks, SSE, MCP and pg-boss workers. Each module under `src/modules/` has its own owner:

Root `CLAUDE.md` rules apply. Rules specific to this package:

- Module owners: `paypal`, `webhooks`, `actions`, `reconcile`, `audit`, `pool` → Arnav. `agent`, `policy` → Ishan. `sessions`, `portal`, `mcp`, `demo` → Aditya. `merchant` → Ayush. `recovery`, `winback`, `notify`, `insights` → Om.
- Modules talk to each other only through the interfaces in docs/CONTRACTS.md §5, never by importing another module's internals.
- Only `modules/paypal` makes HTTP calls to PayPal. Every PayPal mutation goes through the ActionEngine.
- Only `modules/agent` imports `@anthropic-ai/sdk`.
- Every route validates input and output with zod and is scoped by `merchant_id`.
- The cancel route (`POST /v1/sessions/:id/cancel`) must never call the agent or any LLM.
