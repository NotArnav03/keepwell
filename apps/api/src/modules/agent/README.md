# modules/agent (owner: Ishan, M2)

The real `Agent` (CONTRACTS.md §5, ARCHITECTURE.md §6.5). `createAgent()` builds it; the sessions module plugs it in where `FakeAgent` sits today. It's stateless: every call gets a fresh `SessionContext`.

## One subscriber message

1. **Limits.** A 4th message gets the limit text and no model call.
2. **Classify** with Claude Haiku 5.5: `reason`, `intent`, `language`, `flags`.
3. **Close without an offer** when `intent` is `cancel_now` (no-means-no), or the message is abusive or shows distress.
4. **Menu.** `computeMenu` for the classified reason. An empty menu (inactive subscription, offer already shown, nothing fits) closes without asking Sonnet.
5. **Reply** with Claude Sonnet 5.5: exactly one of `present_offer(menu id)`, `ask_one_question` (only as the agent's first turn) or `no_offer`, plus the message.
6. **Re-check.** The pick goes through `evaluate`, and the text through the claims checker (`claims.ts`, below). A rejected reply is regenerated once. Then: an allowed pick keeps its offer with template text, anything else gets the close template.
7. **Record, then show.** `session.offer_presented` and an `offer.presented` audit entry (with `explain()`) are written before the card is streamed. The card text renders from the `Offer`, never from the model, in the subscriber's language.

Each message has 8 s in total. A timeout, an API error, a refusal or two invalid classifier outputs sends `fallback.changed: L1`, template text and the reason chips. `respondToReason` (L1) never calls a model: it takes the policy's default for that chip from the full menu and re-checks it with `evaluate`.

## Claims checker

The offer card carries every term, so the model's text carries none. `checkClaims(text, offer)` rejects:
- **figures:** digits in any script, currency signs, `%`, and number words;
- **dates and durations:** month and day names, "tomorrow", "months", "semanas", "महीने";
- **promises:** "free", "guaranteed", "forever", "gratis", "मुफ़्त";
- **pressure and guilt:** "last chance", "we'll miss you", "última oportunidad", "आखिरी मौका";
- **talk of another offer:** "refund" next to a pause card, or any offer word when none is shown.

It is deterministic, with no model call: every reply passes through it, so it costs nothing and gives the same answer every time. Words are matched whole, with Unicode-aware boundaries, after NFC normalisation. A few words are left out on purpose, such as "one", "may", "today" and the singular "day" ("have a good day"). The evals (#28) will show whether the lists need tuning.

## Languages

Cards and template replies come in English, Hindi and Spanish (`i18n.ts`). Money, percentages and dates are formatted with `Intl`; money is formatted from its decimal string and never becomes a float. The classifier's `language` picks the locale, and anything else falls back to English. A reason-chip tap (L1) carries no text, so it uses English until `SessionContext` carries the session's locale.

## Model calls

- Only `anthropic.ts` imports `@anthropic-ai/sdk`. Decisions come back as **structured output** (`output_config.format`, a JSON schema from zod) and are validated with zod again. Sonnet 5.5 rejects forced `tool_choice`, so they aren't tool calls.
- The system prompts in `prompts.ts` never change between calls, so they're cached. Everything per session goes in the user message.
- `effort: "low"`, one SDK retry, and the 8 s deadline as an `AbortSignal`.
- The subscriber's words sit inside `<transcript>` / `<subscriber_messages>` tags, and both prompts treat them as data. Whatever they say, the model can only pick from the menu, and the policy re-checks that pick.

## Tests

`FakeLlmClient` scripts both calls (including invalid output, refusals and hanging until the deadline). `anthropic.test.ts` runs the real client against a fake `fetch`. Nothing calls the Anthropic API.

## Not yet (later issues)

- The session's locale in `SessionContext` (from `CreateSessionRequest.locale`), so L1 replies are localised too.
- The 20 s per-session model time, the token budget, the daily budget and rate limits (#26). They need state across calls.
- Prompt tuning against the evals (#28, #30).
