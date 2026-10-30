import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicLlmClient } from "./anthropic.js";
import { InMemoryLlmUsageStore, LlmBudget, type LlmUsageStore } from "./budget.js";
import { LlmError, type AgentLogger, type LlmPurpose } from "./llm.js";

// The real client against a fake fetch: checks the request we send, how responses map to
// LlmError, and the budget guard, without ever reaching the Anthropic API.

const NOW = new Date("2026-11-01T10:00:00.000Z");
const SESSION = "0199a1b2-c3d4-7e5f-8a6b-00000000aaaa";
const Schema = z.object({ answer: z.enum(["yes", "no"]) });

function logger() {
  const errors: string[] = [];
  const log: AgentLogger = {
    info: () => {},
    warn: () => {},
    error: (_obj: unknown, msg?: string) => {
      errors.push(msg ?? "");
    },
  } as AgentLogger;
  return { log, errors };
}

function message(text: string, stopReason = "end_turn", tokens = { input: 1000, output: 100 }) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: stopReason === "refusal" ? { type: "refusal", category: null, explanation: null } : null,
    usage: {
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 0,
    },
  };
}

const apiError = (status: number, type: string) => ({
  status,
  body: { type: "error", error: { type, message: "x" } },
});

function clientReturning(
  responses: { status: number; body: unknown }[],
  budget: LlmBudget | null = null,
  log: AgentLogger = logger().log,
) {
  const requests: Record<string, unknown>[] = [];
  const fetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // The SDK sends a JSON string body; anything else is a test failure.
    if (typeof init?.body !== "string") throw new Error("expected a JSON string body");
    requests.push(JSON.parse(init.body) as Record<string, unknown>);
    const next = responses.shift();
    if (!next) throw new Error("no response scripted");
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json", "retry-after-ms": "0" },
      }),
    );
  };
  const client = new Anthropic({ apiKey: "test-not-a-key", fetch, maxRetries: 0 });
  let t = 0;
  // Each call "takes" 400 ms of model time.
  const now = () => (t += 200);
  return { llm: new AnthropicLlmClient({ client, log, budget, now }), requests };
}

const call = (purpose: LlmPurpose = "classify", signal = new AbortController().signal) => ({
  purpose,
  system: "SYSTEM",
  input: "INPUT",
  schema: Schema,
  maxTokens: 256,
  signal,
  sessionId: SESSION,
});

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof LlmError) return err.failure;
    throw err;
  }
  throw new Error("expected an LlmError");
}

const budgetWith = (
  store: LlmUsageStore,
  dailyBudgetUsd = 5,
  extra: { sessionModelMs?: number; sessionTokens?: number } = {},
) => new LlmBudget({ store, dailyBudgetUsd, clock: () => NOW, ...extra });

describe("AnthropicLlmClient", () => {
  it("sends a cached system prompt and a JSON schema, and returns validated output", async () => {
    const { llm, requests } = clientReturning([{ status: 200, body: message('{"answer":"yes"}') }]);
    await expect(llm.structured(call("converse"))).resolves.toEqual({ answer: "yes" });
    expect(requests[0]).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 256,
      system: [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "INPUT" }],
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    expect(requests[0]).not.toHaveProperty("tool_choice");
  });

  it("uses Haiku for both the classifier and the conversation", async () => {
    const ok = { status: 200, body: message('{"answer":"no"}') };
    const { llm, requests } = clientReturning([ok, ok]);
    await llm.structured(call("classify"));
    await llm.structured(call("converse"));
    expect(requests.map((r) => r.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5"]);
  });

  it.each([
    ["text that isn't JSON", message("yes"), "invalid_output"],
    ["JSON that fails the schema", message('{"answer":"maybe"}'), "invalid_output"],
    ["a refusal", message("", "refusal"), "refused"],
  ])("maps %s", async (_name, body, expected) => {
    const { llm } = clientReturning([{ status: 200, body }]);
    expect(await failure(llm.structured(call()))).toBe(expected);
  });

  it("maps API errors to unavailable after one retry", async () => {
    const overloaded = apiError(529, "overloaded_error");
    const { llm, requests } = clientReturning([overloaded, overloaded]);
    expect(await failure(llm.structured(call()))).toBe("unavailable");
    expect(requests).toHaveLength(2);
  });

  it("maps a revoked key to unavailable, so the session falls to L1", async () => {
    const { llm, requests } = clientReturning([apiError(401, "authentication_error")]);
    expect(await failure(llm.structured(call()))).toBe("unavailable");
    expect(requests).toHaveLength(1);
  });

  it("maps an aborted call to unavailable", async () => {
    const { llm } = clientReturning([{ status: 200, body: message('{"answer":"yes"}') }]);
    expect(await failure(llm.structured(call("classify", AbortSignal.abort())))).toBe("unavailable");
  });
});

describe("AnthropicLlmClient with the budget guard", () => {
  it("records each call's tokens, cost and model time", async () => {
    const store = new InMemoryLlmUsageStore();
    const { llm } = clientReturning([{ status: 200, body: message('{"answer":"yes"}') }], budgetWith(store));
    await llm.structured(call("converse"));
    expect(store.entries).toEqual([
      {
        at: NOW.toISOString(),
        sessionId: SESSION,
        purpose: "converse",
        model: "claude-haiku-5-5",
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 2000,
        cacheWriteTokens: 0,
        // 1000 × 100 + 100 × 500 + 2000 × 10 nano-dollars: $0.00017
        costNanoUsd: 170_000,
        durationMs: 200,
      },
    ]);
  });

  it("refuses to call once today's budget is spent, without sending a request", async () => {
    const store = new InMemoryLlmUsageStore();
    // $0.0001 budget; one call above costs $0.00017. Two good responses: only the guard stops the second.
    const ok = { status: 200, body: message('{"answer":"yes"}') };
    const { llm, requests } = clientReturning([ok, ok], budgetWith(store, 0.0001));
    await llm.structured(call("converse"));
    expect(await failure(llm.structured(call("converse")))).toBe("unavailable");
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["model time", { sessionModelMs: 200 }],
    ["tokens", { sessionTokens: 3000 }],
  ] as const)("enforces the session's %s limit without sending the request", async (_name, limits) => {
    const store = new InMemoryLlmUsageStore();
    // Two good responses: if the guard let the second call through, it would succeed.
    const ok = { status: 200, body: message('{"answer":"yes"}') };
    const { llm, requests } = clientReturning([ok, ok], budgetWith(store, 5, limits));
    await llm.structured(call());
    expect(await failure(llm.structured(call()))).toBe("unavailable");
    expect(requests).toHaveLength(1);
    // Another session is unaffected.
    await expect(budgetWith(store, 5, limits).assertCanSpend("someone-else")).resolves.toBeUndefined();
  });

  it("counts the time of a failed call against the session", async () => {
    const store = new InMemoryLlmUsageStore();
    const { llm } = clientReturning([apiError(401, "authentication_error")], budgetWith(store));
    await failure(llm.structured(call()));
    expect(store.entries[0]).toMatchObject({ durationMs: 200, inputTokens: 0, costNanoUsd: 0 });
  });

  it("fails closed when the usage store can't be read", async () => {
    const broken: LlmUsageStore = {
      spentOn: () => Promise.reject(new Error("db down")),
      sessionTotals: () => Promise.reject(new Error("db down")),
      record: () => Promise.resolve(),
    };
    const { log, errors } = logger();
    const { llm, requests } = clientReturning([], budgetWith(broken), log);
    expect(await failure(llm.structured(call()))).toBe("unavailable");
    expect(requests).toHaveLength(0);
    expect(errors).toContain("llm budget check failed; refusing the call");
  });

  it("still returns the reply when recording usage fails, and logs it as an error", async () => {
    const store = new InMemoryLlmUsageStore();
    const failingRecord: LlmUsageStore = {
      spentOn: (day) => store.spentOn(day),
      sessionTotals: (id) => store.sessionTotals(id),
      record: () => Promise.reject(new Error("db down")),
    };
    const { log, errors } = logger();
    const { llm } = clientReturning(
      [{ status: 200, body: message('{"answer":"yes"}') }],
      budgetWith(failingRecord),
      log,
    );
    await expect(llm.structured(call())).resolves.toEqual({ answer: "yes" });
    expect(errors).toContain("llm usage not recorded");
  });
});
