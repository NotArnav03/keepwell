# modules/agent (owner: Ishan, M2)

The real `Agent` (CONTRACTS.md §5, ARCHITECTURE.md §6.5). `createAgent()` builds it; the sessions module plugs it in where `FakeAgent` sits today. It's stateless: every call gets a fresh `SessionContext`.

## One subscriber message

1. **Limits.** A 4th message gets the limit text and no model call.
2. **Classify** with Claude Haiku 5.5: `reason`, `intent`, `language`, `flags`.
3. **Close without an offer** when `intent` is `cancel_now` (no-means-no), or the message is abusive or shows distress.
4. **Menu.** `computeMenu` for the classified reason. An empty menu (inactive subscription, offer already shown, nothing fits) closes without asking Sonnet.
5. **Reply** with Claude Sonnet 5.5: exactly one of `present_offer(menu id)`, `ask_one_question` (only as the agent's first turn) or `no_offer`, plus the message.
6. **Re-check.** The pick goes through `evaluate`, and the text may not contain any figure (a digit, `$ € £ ₹ ¥` or `%`) until the claims checker (#25) replaces that rule. A rejected reply is regenerated once. Then: an allowed pick keeps its offer with template text, anything else gets the close template.
7. **Record, then show.** `session.offer_presented` and an `offer.presented` audit entry (with `explain()`) are written before the card is streamed. The card text renders from the `Offer`, never from the model.

Each message has 8 s in total. A timeout, an API error, a refusal or two invalid classifier outputs sends `fallback.changed: L1`, template text and the reason chips. `respondToReason` (L1) never calls a model: it takes the policy's default for that chip from the full menu and re-checks it with `evaluate`.

## Model calls

- Only `anthropic.ts` imports `@anthropic-ai/sdk`. Decisions come back as **structured output** (`output_config.format`, a JSON schema from zod) and are validated with zod again. Sonnet 5.5 rejects forced `tool_choice`, so they aren't tool calls.
- The system prompts in `prompts.ts` never change between calls, so they're cached. Everything per session goes in the user message.
- `effort: "low"`, one SDK retry, and the 8 s deadline as an `AbortSignal`.
- The subscriber's words sit inside `<transcript>` / `<subscriber_messages>` tags, and both prompts treat them as data. Whatever they say, the model can only pick from the menu, and the policy re-checks that pick.

## Tests

`FakeLlmClient` scripts both calls (including invalid output, refusals and hanging until the deadline). `anthropic.test.ts` runs the real client against a fake `fetch`. Nothing calls the Anthropic API.

## Not yet (later issues)

- Multilingual templates and card text (#24, #25), and the real claims checker (#25).
- The 20 s per-session model time, the token budget, the daily budget and rate limits (#26). They need state across calls.
- Prompt tuning against the evals (#28, #30).
