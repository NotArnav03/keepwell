import { z } from "zod";
import type { LlmBudget, Reservation, TokenUsage } from "./budget.js";
import { LlmError, type AgentLogger, type LlmClient, type LlmPurpose, type StructuredCall } from "./llm.js";

// The second LlmClient behind the same seam as AnthropicLlmClient (ADR 0002): Groq's
// OpenAI-compatible chat API, chosen by LLM_PROVIDER=groq. Everything around the model stays as it
// is: the policy re-checks every pick, the claims checker every sentence, the budget guard every
// call, and any failure drops the session to L1. Plain fetch, so no new dependency.

export const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

/**
 * gpt-oss-20b for the agent's latency-bound calls (fast, and on Groq's JSON-schema list);
 * gpt-oss-120b for the copilot's open questions, as Sonnet is on Anthropic.
 */
export const GROQ_MODEL_FOR: Record<LlmPurpose, string> = {
  classify: "openai/gpt-oss-20b",
  converse: "openai/gpt-oss-20b",
  copilot: "openai/gpt-oss-120b",
  simulate: "openai/gpt-oss-20b",
  judge: "openai/gpt-oss-20b",
};

/**
 * gpt-oss reasons before it answers, and those tokens come out of the same completion limit. The
 * callers' maxTokens are sized for the answer alone, so the request gets this much on top.
 */
export const REASONING_HEADROOM_TOKENS = 1024;

const ChatResponse = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          content: z.string().nullish(),
          refusal: z.string().nullish(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0),
      completion_tokens: z.number().int().min(0),
    })
    .nullish(),
});

const ErrorBody = z.object({
  error: z.object({ code: z.string().nullish(), message: z.string().nullish() }),
});

export interface GroqLlmClientOptions {
  apiKey: string;
  log: AgentLogger;
  /** The budget guard. null only in tests that aren't about spending. */
  budget: LlmBudget | null;
  /** Injected in tests; global fetch otherwise. */
  fetch?: typeof fetch;
  /** Monotonic milliseconds, for model time. */
  now?: () => number;
}

export class GroqLlmClient implements LlmClient {
  private readonly apiKey: string;
  private readonly log: AgentLogger;
  private readonly budget: LlmBudget | null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(options: GroqLlmClientOptions) {
    this.apiKey = options.apiKey;
    this.log = options.log;
    this.budget = options.budget;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => performance.now());
  }

  async structured<S extends z.ZodType>(call: StructuredCall<S>): Promise<z.infer<S>> {
    const model = GROQ_MODEL_FOR[call.purpose];
    // Best-effort mode (strict: false): strict mode needs every property required, and our schemas
    // have optional fields. The output is validated below either way, as on Anthropic.
    const schema = z.toJSONSchema(call.schema, { target: "draft-7", io: "output" });
    const inputBytes = [call.system, call.input, JSON.stringify(schema)].reduce(
      (sum, text) => sum + Buffer.byteLength(text),
      0,
    );
    const reservation = await this.reserve(call, model, inputBytes);
    try {
      return await this.send(call, model, schema);
    } finally {
      // After send() has recorded the usage, so the cost is always counted by the hold, the store
      // or both, never by neither.
      reservation?.release();
    }
  }

  private async send<S extends z.ZodType>(
    call: StructuredCall<S>,
    model: string,
    schema: Record<string, unknown>,
  ): Promise<z.infer<S>> {
    const started = this.now();
    let response: Response;
    let body: unknown;
    try {
      response = await this.fetch(GROQ_API_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: call.system },
            { role: "user", content: call.input },
          ],
          max_completion_tokens: call.maxTokens + REASONING_HEADROOM_TOKENS,
          // Short, latency-bound replies inside an 8 s budget, as with Anthropic's low effort.
          reasoning_effort: "low",
          include_reasoning: false,
          response_format: {
            type: "json_schema",
            json_schema: { name: call.purpose, strict: false, schema },
          },
        }),
        signal: call.signal,
      });
      body = await response.json().catch(() => null);
    } catch (err) {
      // Abort, timeout or network: the time still counts against the session.
      await this.recordUsage(call, model, started, NO_TOKENS);
      this.log.warn({ err, model }, "llm call failed");
      throw new LlmError("unavailable", `${model} call failed`, { cause: err });
    }

    if (!response.ok) {
      await this.recordUsage(call, model, started, NO_TOKENS);
      const error = ErrorBody.safeParse(body);
      const code = error.success ? (error.data.error.code ?? undefined) : undefined;
      // The API key is only in the request headers, which are never logged.
      this.log.warn({ model, status: response.status, code }, "llm call failed");
      // Best-effort mode answers 400 json_validate_failed when the output missed the schema: the
      // model answered, so it is worth the runtime's one retry. Anything else (429, 5xx, a bad key,
      // our own 4xx) is unavailable, and the session goes to L1.
      if (response.status === 400 && code === "json_validate_failed") {
        throw new LlmError("invalid_output", `${model} output failed Groq's schema check`);
      }
      throw new LlmError("unavailable", `${model} call failed (${response.status})`);
    }

    const parsedResponse = ChatResponse.safeParse(body);
    if (!parsedResponse.success) {
      await this.recordUsage(call, model, started, NO_TOKENS);
      throw new LlmError("unavailable", `${model} returned an unexpected response`, {
        cause: parsedResponse.error,
      });
    }
    const { choices, usage } = parsedResponse.data;
    const tokens: TokenUsage = {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const recorded = await this.recordUsage(call, model, started, tokens);
    // min(1) above guarantees a first choice.
    const choice = choices[0]!;
    this.log.info(
      {
        model,
        purpose: call.purpose,
        sessionId: call.sessionId,
        stopReason: choice.finish_reason,
        ...tokens,
        costNanoUsd: recorded?.costNanoUsd,
        durationMs: recorded?.durationMs,
      },
      "llm call",
    );

    if (choice.message.refusal) {
      throw new LlmError("refused", `${model} declined`);
    }
    if (choice.finish_reason === "length") {
      throw new LlmError("invalid_output", `${model} ran out of tokens before finishing`);
    }
    let json: unknown;
    try {
      json = JSON.parse(choice.message.content ?? "");
    } catch (err) {
      throw new LlmError("invalid_output", `${model} returned text that isn't JSON`, { cause: err });
    }
    const parsed = call.schema.safeParse(json);
    if (!parsed.success) {
      throw new LlmError("invalid_output", `${model} output failed validation`, { cause: parsed.error });
    }
    return parsed.data;
  }

  /** As AnthropicLlmClient: holds the worst case until recorded, and fails closed. */
  private async reserve(
    call: StructuredCall<z.ZodType>,
    model: string,
    inputBytes: number,
  ): Promise<Reservation | null> {
    if (!this.budget) return null;
    const { sessionId } = call;
    try {
      return await this.budget.reserve({
        sessionId,
        model,
        inputBytes,
        maxOutputTokens: call.maxTokens + REASONING_HEADROOM_TOKENS,
      });
    } catch (err) {
      if (err instanceof LlmError) {
        this.log.warn({ sessionId, reason: err.message }, "llm budget refused the call");
        throw err;
      }
      this.log.error({ err, sessionId }, "llm budget check failed; refusing the call");
      throw new LlmError("unavailable", "The LLM budget couldn't be checked", { cause: err });
    }
  }

  /** As AnthropicLlmClient: a failed write doesn't take the reply away; the budget keeps counting. */
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
