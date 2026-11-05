import Anthropic from "@anthropic-ai/sdk";
import type { Audit, DomainEvents } from "@keepwell/contracts";
import { AnthropicLlmClient } from "./anthropic.js";
import type { AgentLogger, LlmClient } from "./llm.js";
import { AgentRuntime } from "./runtime.js";

export { AgentRuntime, MAX_SUBSCRIBER_MESSAGES, TEMPLATES } from "./runtime.js";
export { LlmError, MODEL_FOR, type LlmClient, type LlmFailure, type StructuredCall } from "./llm.js";

export interface CreateAgentOptions {
  /** Unset means no model: every session runs in L1, and cancel works as always. */
  anthropicApiKey: string | undefined;
  events: DomainEvents;
  audit: Audit;
  log: AgentLogger;
}

/**
 * The one LlmClient other modules (insights, copilot) share, so a budget guard added here covers
 * them all. null when no API key is set.
 */
export function createLlmClient(options: {
  anthropicApiKey: string | undefined;
  log: AgentLogger;
}): LlmClient | null {
  return options.anthropicApiKey
    ? new AnthropicLlmClient({ client: new Anthropic({ apiKey: options.anthropicApiKey }), log: options.log })
    : null;
}

/** The Agent the sessions module (#32) plugs in where FakeAgent sits today. */
export function createAgent({ anthropicApiKey, events, audit, log }: CreateAgentOptions): AgentRuntime {
  const llm = createLlmClient({ anthropicApiKey, log });
  if (!llm) log.warn("ANTHROPIC_API_KEY is not set: the agent runs in L1 only");
  return new AgentRuntime({ llm, events, audit, log });
}
