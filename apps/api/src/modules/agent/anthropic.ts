import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { LlmBudget, TokenUsage } from "./budget.js";
import { LlmError, MODEL_FOR, type AgentLogger, type LlmClient, type StructuredCall } from "./llm.js";

// The one place in the repo that imports @anthropic-ai/sdk (apps/api/CLAUDE.md).

export interface AnthropicLlmClientOptions {
  client: Anthropic;
  log: AgentLogger;
  /** The budget guard. null only in tests that aren't about spending. */
  budget: LlmBudget | null;
  /** Monotonic milliseconds, for model time. */
  now?: () => number;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly log: AgentLogger;
  private readonly budget: LlmBudget | null;
  private readonly now: () => number;

  constructor(options: AnthropicLlmClientOptions) {
    this.client = options.client;
    this.log = options.log;
    this.budget = options.budget;
    this.now = options.now ?? (() => performance.now());
  }

  async structured<S extends z.ZodType>(call: StructuredCall<S>): Promise<z.infer<S>> {
    const model = MODEL_FOR[call.purpose];
    await this.assertBudget(call.sessionId);

    // Sonnet 5.5 rejects forced tool_choice, so decisions come back as structured output instead
    // of a tool call. The SDK's parse() would throw before we could tell a refusal from bad JSON,
    // so this sends the schema only and validates below.
    const { type, schema } = zodOutputFormat(call.schema);
    const started = this.now();
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
        // Covers aborts, timeouts, connection errors and a revoked key: all subclass APIError.
        // The time still counts against the session.
        await this.recordUsage(call, model, started, NO_TOKENS);
        this.log.warn({ err, model, status: err.status }, "llm call failed");
        throw new LlmError("unavailable", `${model} call failed`, { cause: err });
      }
      throw err;
    }

    const { usage } = message;
    const tokens: TokenUsage = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    };
    const recorded = await this.recordUsage(call, model, started, tokens);
    this.log.info(
      {
        model,
        purpose: call.purpose,
        sessionId: call.sessionId,
        stopReason: message.stop_reason,
        ...tokens,
        costNanoUsd: recorded?.costNanoUsd,
        durationMs: recorded?.durationMs,
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

  /** Fails closed: if the usage store can't be read, we can't prove there's budget left. */
  private async assertBudget(sessionId: string | null): Promise<void> {
    if (!this.budget) return;
    try {
      await this.budget.assertCanSpend(sessionId);
    } catch (err) {
      if (err instanceof LlmError) {
        this.log.warn({ sessionId, reason: err.message }, "llm budget refused the call");
        throw err;
      }
      this.log.error({ err, sessionId }, "llm budget check failed; refusing the call");
      throw new LlmError("unavailable", "The LLM budget couldn't be checked", { cause: err });
    }
  }

  /**
   * The call already happened, so a failure to record it doesn't take the subscriber's reply away;
   * it is logged as an error, because unrecorded spend weakens the budget.
   */
  private async recordUsage(
    call: StructuredCall<z.ZodType>,
    model: string,
    started: number,
    tokens: TokenUsage,
  ) {
    if (!this.budget) return null;
    const durationMs = Math.max(0, Math.round(this.now() - started));
    try {
      return await this.budget.record({
        sessionId: call.sessionId,
        purpose: call.purpose,
        model,
        durationMs,
        ...tokens,
      });
    } catch (err) {
      this.log.error({ err, model, sessionId: call.sessionId }, "llm usage not recorded");
      return null;
    }
  }
}

const NO_TOKENS: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
