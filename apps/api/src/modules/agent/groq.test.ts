import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicLlmClient } from "./anthropic.js";
import { InMemoryLlmUsageStore, LlmBudget } from "./budget.js";
import { GROQ_API_URL, GROQ_MODEL_FOR, GroqLlmClient, REASONING_HEADROOM_TOKENS } from "./groq.js";
import { createLlmClient } from "./index.js";
import { LlmError, type AgentLogger, type LlmPurpose } from "./llm.js";

// The real client against a fake fetch: the request we send, how Groq's answers map to LlmError,
// and the budget guard, without ever reaching Groq.

const SESSION = "0199a1b2-c3d4-7e5f-8a6b-00000000aaaa";
const Schema = z.object({ answer: z.enum(["yes", "no"]), note: z.string().optional() });

function logger() {
  const warnings: Record<string, unknown>[] = [];
  const log: AgentLogger = {
    info: () => {},
    warn: (obj: unknown) => {
      warnings.push(obj as Record<string, unknown>);
    },
    error: () => {},
  } as AgentLogger;
  return { log, warnings };
}

const completion = (content: string | null, finishReason = "stop", refusal: string | null = null) => ({
  id: "chatcmpl-test",
  choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content, refusal } }],
  usage: { prompt_tokens: 900, completion_tokens: 60 },
});

function clientReturning(
  responses: ({ status: number; body: unknown } | Error)[],
  options: { budget?: LlmBudget | null; log?: AgentLogger } = {},
) {
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({
      url: url instanceof Request ? url.url : url.toString(),
      headers: init?.headers as Record<string, string>,
      // The client always sends a JSON string body.
      body: JSON.parse(init?.body as string) as Record<string, unknown>,
    });
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
  };
  const client = new GroqLlmClient({
    apiKey: "gsk_test",
    log: options.log ?? logger().log,
    budget: options.budget ?? null,
    fetch,
  });
  return { client, requests };
}

const call = (purpose: LlmPurpose = "converse") => ({
  purpose,
  sessionId: SESSION,
  system: "You are a test.",
  input: "Answer yes.",
  schema: Schema,
  maxTokens: 200,
  signal: new AbortController().signal,
});

describe("GroqLlmClient", () => {
  it("sends one chat completion with the schema, low reasoning effort and room to reason", async () => {
    const { client, requests } = clientReturning([{ status: 200, body: completion('{"answer":"yes"}') }]);
    await expect(client.structured(call())).resolves.toEqual({ answer: "yes" });
    const [request] = requests;
    expect(request?.url).toBe(GROQ_API_URL);
    expect(request?.headers.authorization).toBe("Bearer gsk_test");
    expect(request?.body).toMatchObject({
      model: GROQ_MODEL_FOR.converse,
      messages: [
        { role: "system", content: "You are a test." },
        { role: "user", content: "Answer yes." },
      ],
      max_completion_tokens: 200 + REASONING_HEADROOM_TOKENS,
      reasoning_effort: "low",
      response_format: { type: "json_schema", json_schema: { name: "converse", strict: false } },
    });
    const schema = (request?.body.response_format as { json_schema: { schema: Record<string, unknown> } })
      .json_schema.schema;
    expect(schema).toMatchObject({ type: "object", required: ["answer"] });
  });

  it("uses the bigger model for the copilot", async () => {
    const { client, requests } = clientReturning([{ status: 200, body: completion('{"answer":"no"}') }]);
    await client.structured(call("copilot"));
    expect(requests[0]?.body.model).toBe("openai/gpt-oss-120b");
  });

  it("is unavailable on a rate limit, a bad key or a 5xx, so the session goes to L1", async () => {
    for (const status of [429, 401, 503]) {
      const { client } = clientReturning([{ status, body: { error: { code: "x", message: "nope" } } }]);
      const error = await client.structured(call()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LlmError);
      expect(error).toMatchObject({ failure: "unavailable" });
    }
  });

  it("is unavailable when the network fails or the deadline aborts the call", async () => {
    const { client } = clientReturning([new DOMException("aborted", "AbortError")]);
    await expect(client.structured(call())).rejects.toMatchObject({ failure: "unavailable" });
  });

  it("treats Groq's own schema rejection as invalid output, worth the runtime's one retry", async () => {
    const { client } = clientReturning([
      {
        status: 400,
        body: { error: { code: "json_validate_failed", message: "Generated JSON does not match" } },
      },
    ]);
    await expect(client.structured(call())).rejects.toMatchObject({ failure: "invalid_output" });
  });

  it("validates the answer itself, whatever Groq accepted", async () => {
    const { client } = clientReturning([
      { status: 200, body: completion('{"answer":"maybe"}') },
      { status: 200, body: completion("not json") },
      { status: 200, body: completion('{"answer":"yes"', "length") },
    ]);
    for (let i = 0; i < 3; i++) {
      await expect(client.structured(call())).rejects.toMatchObject({ failure: "invalid_output" });
    }
  });

  it("reports a refusal as refused", async () => {
    const { client } = clientReturning([
      { status: 200, body: completion(null, "stop", "I can't help with that.") },
    ]);
    await expect(client.structured(call())).rejects.toMatchObject({ failure: "refused" });
  });

  it("never logs the API key", async () => {
    const { log, warnings } = logger();
    const { client } = clientReturning([{ status: 401, body: { error: { code: "invalid_api_key" } } }], {
      log,
    });
    await client.structured(call()).catch(() => {});
    expect(JSON.stringify(warnings)).not.toContain("gsk_test");
    expect(warnings[0]).toMatchObject({ status: 401, code: "invalid_api_key" });
  });

  it("goes through the budget guard and records usage at no cost", async () => {
    const store = new InMemoryLlmUsageStore();
    const budget = new LlmBudget({ store, dailyBudgetUsd: 0.1 });
    const { client } = clientReturning([{ status: 200, body: completion('{"answer":"yes"}') }], { budget });
    await client.structured(call());
    const entries = store.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      model: "openai/gpt-oss-20b",
      purpose: "converse",
      inputTokens: 900,
      outputTokens: 60,
      costNanoUsd: 0,
    });
  });
});

describe("createLlmClient", () => {
  const budget = new LlmBudget({ store: new InMemoryLlmUsageStore(), dailyBudgetUsd: 0.1 });
  const { log } = logger();

  it("builds the Groq client when LLM_PROVIDER is groq, and none without its key", () => {
    expect(
      createLlmClient({ provider: "groq", anthropicApiKey: undefined, groqApiKey: "gsk", budget, log }),
    ).toBeInstanceOf(GroqLlmClient);
    // An Anthropic key alone doesn't switch providers behind the setting's back: no client means L1.
    expect(
      createLlmClient({ provider: "groq", anthropicApiKey: "sk-ant", groqApiKey: undefined, budget, log }),
    ).toBeNull();
  });

  it("stays on Anthropic by default", () => {
    expect(createLlmClient({ anthropicApiKey: "sk-ant", groqApiKey: "gsk", budget, log })).toBeInstanceOf(
      AnthropicLlmClient,
    );
  });
});
