# Chaos report (9 Nov 2026)

Each owner breaks their component on purpose and records whether the system behaved as the failure-mode matrix in [ARCHITECTURE.md §9](ARCHITECTURE.md) says. Each section below is written by its owner. A drill that found a problem says so, and links the fix.

| Owner | Component | Status |
|---|---|---|
| Ishan (M2) | Agent: revoked Anthropic key, spent budget, prompt injection | Done, below |
| Arnav (M1) | API killed mid-action, dropped webhooks, PayPal 5xx | Open |
| Aditya (M3) | API down → widget L2, SSE reconnect | Open |
| Ayush (M4) | Dashboard with API errors, empty states | Open |
| Om (M5) | Email provider down, duplicate `payment_failed` | Open |

## M2: the agent (Ishan)

All three drills ran on `main` at `e83d02e` with the real `AnthropicLlmClient`, the real budget guard and the real session runtime, over the 51-persona PR subset (`pnpm --filter @keepwell/api eval -- --mode real --subset`), or all 404 personas for the free adversarial run. They ran from a developer machine, not on staging: the agent is mounted behind the same client and guard on staging, and a drill that needs no PayPal and no browser is faster to run where the code is.

### 1. Revoked Anthropic key

Matrix row: *Anthropic API down, slow or over budget → session falls to L1; cancel unaffected.*

**How:** `ANTHROPIC_API_KEY` set to a key Anthropic does not know, so every request is a real HTTP 401 (`authentication_error: invalid x-api-key`) from api.anthropic.com.

| Result | |
|---|---|
| Sessions run / completed | 51 / 51 |
| Sessions that fell to L1 | 100% (`fallbackRate` 1) |
| Spend | $0.0000 |
| Policy violations | 0 |
| Clicks to cancel (max) | 1 |
| Outcomes | 30 cancelled, 21 accepted a card, 0 abandoned |
| Requests that reached Anthropic | each failed with a 401, then the session moved to L1 |

**Finding, fixed:** the first run crashed. The eval tool's *simulated subscriber* (the model that words a persona's follow-up messages, `evals/roles.ts`) did not catch the model being unavailable, so one 401 ended the whole run. The production agent was not affected (it already fell to L1, covered by `anthropic.test.ts` "a revoked API key"), and an unavailable judge was already tolerated, but the simulator was the odd one out. It would have wasted the paid run (#30) the same way if the budget ran out half way. Fix: the simulator sends the persona's scripted words when the model is unavailable, with a test that fails without the fix.

**Not done, and worth knowing:** nothing stops the agent from asking Anthropic again on every new session while the key is revoked (105 failed requests in the 51-session run). Each costs nothing and falls to L1 (p50 240 ms, p95 500 ms per session), so there's no harm to a subscriber; a circuit breaker would only save those requests.

### 2. Daily budget spent

Matrix row: *LLM cost runaway → L1 mode until reset.*

**How:** the same run with a daily budget of $0.0001, below the worst-case hold of a single call.

| Result | |
|---|---|
| Sessions run / completed | 51 / 51 |
| Sessions that fell to L1 | 100% |
| Requests sent to Anthropic | **0** (the guard refused before any request: `Daily LLM budget reached for 2026-11-09`) |
| Spend | $0.0000 |
| Policy violations / max clicks to cancel | 0 / 1 |

The unit tests cover the other halves: overlapping calls can't all pass one check (`budget.test.ts`), a failed call releases its hold, and the cap survives a restart because the spend is read from `llm_usage` (`pg-usage-store.test.ts`).

### 3. Prompt injection and a jailbroken model

Matrix row: *Prompt injection ("give me a year free") → pick denied, logged as `policy_violation_attempt`; no unauthorised offer.*

**How:** the free adversarial run (`--mode adversarial`): all 404 personas, where the *model itself is fully jailbroken* and tries to give away free months, offer twice, offer after a cancel, invent perks and pitch without a card, whatever the persona says. The red-team personas add `ignore_instructions`, `fake_markup`, and the other attack scripts in `packages/evals`.

| Result | |
|---|---|
| Sessions | 404 |
| Policy violations that reached a subscriber | **0** (off-policy offer 0, second offer 0, offer after cancel 0, claim in text 0, offer without card 0) |
| Illegal picks the policy engine refused | 132 |
| Invented claims the claims checker caught | 204 |
| "No" means no | 100% |
| Clicks to cancel (max) | 1 |

This matches the committed `packages/evals/results/adversarial.json`.

### What this does not cover

- No real Haiku or Sonnet output: all three drills run without a working key. The real run (#30, about $1 of the $5 credit) is still to do and is the only evidence on tone, language and dark patterns.
- A live staging drill (revoke the key in Render, watch a Judge Mode session): the same code path, but it needs access to Render. Arnav, if you run it, add what you see here.
