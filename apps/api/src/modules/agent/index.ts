import Anthropic from "@anthropic-ai/sdk";
import type { Audit, DomainEvents } from "@keepwell/contracts";
import { AnthropicLlmClient } from "./anthropic.js";
import type { AgentLogger } from "./llm.js";
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

/** The Agent the sessions module (#32) plugs in where FakeAgent sits today. */
export function createAgent({ anthropicApiKey, events, audit, log }: CreateAgentOptions): AgentRuntime {
  const llm = anthropicApiKey
    ? new AnthropicLlmClient({ client: new Anthropic({ apiKey: anthropicApiKey }), log })
    : null;
  if (!llm) log.warn("ANTHROPIC_API_KEY is not set: the agent runs in L1 only");
  return new AgentRuntime({ llm, events, audit, log });
}
