import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicLlmClient } from "./anthropic.js";
import { LlmError, type AgentLogger, type LlmPurpose } from "./llm.js";

// The real client against a fake fetch: checks the request we send and how responses map to
// LlmError, without ever reaching the Anthropic API.

const silent: AgentLogger = { info: () => {}, warn: () => {}, error: () => {} };
const Schema = z.object({ answer: z.enum(["yes", "no"]) });

function message(text: string, stopReason = "end_turn") {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: stopReason === "refusal" ? { type: "refusal", category: null, explanation: null } : null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

function clientReturning(...responses: { status: number; body: unknown }[]) {
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
  return { llm: new AnthropicLlmClient({ client, log: silent }), requests };
}

const call = (purpose: LlmPurpose = "classify", signal = new AbortController().signal) => ({
  purpose,
  system: "SYSTEM",
  input: "INPUT",
  schema: Schema,
  maxTokens: 256,
  signal,
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

describe("AnthropicLlmClient", () => {
  it("sends a cached system prompt and a JSON schema, and returns validated output", async () => {
    const { llm, requests } = clientReturning({ status: 200, body: message('{"answer":"yes"}') });
    await expect(llm.structured(call("converse"))).resolves.toEqual({ answer: "yes" });
    expect(requests[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 256,
      system: [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "INPUT" }],
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    expect(requests[0]).not.toHaveProperty("tool_choice");
  });

  it("uses Haiku to classify", async () => {
    const { llm, requests } = clientReturning({ status: 200, body: message('{"answer":"no"}') });
    await llm.structured(call("classify"));
    expect(requests[0]?.model).toBe("claude-haiku-5-5");
  });

  it.each([
    ["text that isn't JSON", message("yes"), "invalid_output"],
    ["JSON that fails the schema", message('{"answer":"maybe"}'), "invalid_output"],
    ["a refusal", message("", "refusal"), "refused"],
  ])("maps %s", async (_name, body, expected) => {
    const { llm } = clientReturning({ status: 200, body });
    expect(await failure(llm.structured(call()))).toBe(expected);
  });

  it("maps API errors to unavailable after one retry", async () => {
    const overloaded = {
      status: 529,
      body: { type: "error", error: { type: "overloaded_error", message: "x" } },
    };
    const { llm, requests } = clientReturning(overloaded, overloaded);
    expect(await failure(llm.structured(call()))).toBe("unavailable");
    expect(requests).toHaveLength(2);
  });

  it("maps an aborted call to unavailable", async () => {
    const { llm } = clientReturning({ status: 200, body: message('{"answer":"yes"}') });
    expect(await failure(llm.structured(call("classify", AbortSignal.abort())))).toBe("unavailable");
  });
});
