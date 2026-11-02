import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { LlmError, MODEL_FOR, type AgentLogger, type LlmClient, type StructuredCall } from "./llm.js";

// The one place in the repo that imports @anthropic-ai/sdk (apps/api/CLAUDE.md).

export interface AnthropicLlmClientOptions {
  client: Anthropic;
  log: AgentLogger;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly log: AgentLogger;

  constructor(options: AnthropicLlmClientOptions) {
    this.client = options.client;
    this.log = options.log;
  }

  async structured<S extends z.ZodType>(call: StructuredCall<S>): Promise<z.infer<S>> {
    const model = MODEL_FOR[call.purpose];
    // Sonnet 5.5 rejects forced tool_choice, so decisions come back as structured output instead
    // of a tool call. The SDK's parse() would throw before we could tell a refusal from bad JSON,
    // so this sends the schema only and validates below.
    const { type, schema } = zodOutputFormat(call.schema);
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model,
          max_tokens: call.maxTokens,
          system: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: call.input }],
          // Short, latency-bound replies inside an 8 s budget: low effort is enough.
          output_config: { effort: "low", format: { type, schema } },
        },
        // One SDK retry for a blip; the deadline signal still caps the total.
        { signal: call.signal, maxRetries: 1 },
      );
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        // Covers aborts, timeouts and connection errors too: all of them subclass APIError.
        this.log.warn({ err, model, status: err.status }, "llm call failed");
        throw new LlmError("unavailable", `${model} call failed`, { cause: err });
      }
      throw err;
    }

    const { usage } = message;
    this.log.info(
      {
        model,
        purpose: call.purpose,
        stopReason: message.stop_reason,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheWriteTokens: usage.cache_creation_input_tokens,
      },
      "llm call",
    );

    if (message.stop_reason === "refusal") {
      throw new LlmError("refused", `${model} declined (${message.stop_details?.category ?? "no category"})`);
    }
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new LlmError("invalid_output", `${model} returned text that isn't JSON`, { cause: err });
    }
    const parsed = call.schema.safeParse(json);
    if (!parsed.success) {
      throw new LlmError("invalid_output", `${model} output failed validation`, { cause: parsed.error });
    }
    return parsed.data;
  }
}
