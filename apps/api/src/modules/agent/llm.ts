import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod";

// The agent module's only seam to a model. AnthropicLlmClient is the real one; FakeLlmClient
// scripts it for tests and evals, so no unit test ever calls the Anthropic API.

/** Each job maps to one model (CLAUDE.md §3). */
export type LlmPurpose = "classify" | "converse";

export const MODEL_FOR: Record<LlmPurpose, string> = {
  classify: "claude-haiku-5-5",
  converse: "claude-sonnet-5-5",
};

export interface StructuredCall<S extends z.ZodType> {
  purpose: LlmPurpose;
  /** For the per-session limits in the budget guard; null outside a session. */
  sessionId: string | null;
  /** Identical bytes on every call, so it is served from the prompt cache. */
  system: string;
  /** Everything that varies: the menu, the transcript. */
  input: string;
  /** The model's output is constrained to this schema and validated against it again. */
  schema: S;
  maxTokens: number;
  /** The respond() deadline. Aborting counts as "unavailable". */
  signal: AbortSignal;
}

export interface LlmClient {
  /** Resolves with output that passed `schema`, or rejects with an LlmError. */
  structured<S extends z.ZodType>(call: StructuredCall<S>): Promise<z.infer<S>>;
}

/**
 * - `invalid_output`: the model answered but the answer didn't fit; worth one retry.
 * - `refused`: the model declined; a retry would most likely decline too.
 * - `unavailable`: timeout, abort, network, rate limit, 5xx or our own 4xx. The session goes to L1.
 */
export type LlmFailure = "invalid_output" | "refused" | "unavailable";

export class LlmError extends Error {
  constructor(
    readonly failure: LlmFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmError";
  }
}

export type AgentLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;
