# 0002: Groq as a second model provider

## Context
On 11 Nov, the day before submission, the team had no working Anthropic API key. On prod-demo every agent message timed out or errored and dropped to L1, so judges would get reason chips and scripted text instead of a conversation. Cancel and the policy-picked offers still worked, as the failure-mode matrix requires, but the conversation is the product's main feature.

The agent only reaches a model through `LlmClient.structured()` (`apps/api/src/modules/agent/llm.ts`): a system prompt, an input and a zod schema in; validated output or an `LlmError` out. Nothing else in the code depends on the provider.

Free options checked on 11 Nov:
- **Groq:** about 30 requests a minute and 1,000 a day per model on the free plan; very fast; JSON-schema output on `openai/gpt-oss-20b` and `openai/gpt-oss-120b`.
- **OpenRouter `:free` models:** 50 requests a day without $10 of credit, too few for judging.
- **Gemini free tier:** daily limits weren't clear from the published sources.

## Decision
- **Add `GroqLlmClient`** (`agent/groq.ts`) behind the same `LlmClient` seam, chosen by `LLM_PROVIDER=groq` with `GROQ_API_KEY`. `anthropic` stays the default, and switching back is one variable.
- **Models:** `openai/gpt-oss-20b` for the agent (classify, converse) and the evals' roles; `openai/gpt-oss-120b` for the copilot, the same split as Haiku and Sonnet.
- **Best-effort JSON schema** (`strict: false`), because strict mode needs every property required and our schemas have optional ones. The output is validated with zod as before, so nothing the model writes is trusted more than with Anthropic.
- **Same failure mapping:** 429, 5xx, a bad key, network errors and the 8 s deadline are `unavailable` (L1); Groq's `json_validate_failed`, bad JSON or a cut-off answer are `invalid_output` (one retry); a refusal is `refused`.
- **The budget guard still runs on every call.** Groq's free plan costs nothing, so its models are priced at zero, and Groq's own rate limits act as the cap.
- **No new dependency:** plain `fetch` to Groq's OpenAI-compatible endpoint, so `@anthropic-ai/sdk` is still imported only in `agent/anthropic.ts`.

## Consequences
- **Design laws unchanged:** the AI still picks from the policy's menu and the policy re-checks the pick; the claims checker still checks every sentence; consent is still a button; cancel never touches a model.
- **Quality:** the prompts and evals were tuned on Haiku, and gpt-oss-20b may classify or phrase things differently. The checks above bound what it can do wrong, but its eval scores aren't measured yet.
- **Rate limits:** Groq's free plan limits tokens per minute as well as requests. Several judges at once can hit a 429, which drops that message to L1 rather than failing.
- **Data:** conversations go to Groq instead of Anthropic. All of it is sandbox and fictional data (CLAUDE.md §7).
- **Before a paid Groq plan,** price its models in `budget.ts`.

## Status
Accepted, 2026-11-11.
