import Anthropic from "@anthropic-ai/sdk";
import type { Audit, DomainEvents } from "@keepwell/contracts";
import { AnthropicLlmClient } from "./anthropic.js";
import { LlmBudget, type LlmUsageStore } from "./budget.js";
import type { AgentLogger } from "./llm.js";
import { AgentRuntime } from "./runtime.js";

export { AgentRuntime, MAX_SUBSCRIBER_MESSAGES, TEMPLATES } from "./runtime.js";
export { LlmError, MODEL_FOR, type LlmClient, type LlmFailure, type StructuredCall } from "./llm.js";
export {
  InMemoryLlmUsageStore,
  LlmBudget,
  costOf,
  type LlmUsageEntry,
  type LlmUsageStore,
  type NanoUsd,
} from "./budget.js";

export interface CreateAgentOptions {
  /** Unset means no model: every session runs in L1, and cancel works as always. */
  anthropicApiKey: string | undefined;
  /** LLM_DAILY_BUDGET_USD. Required, so no agent ever runs without a spending cap. */
  dailyBudgetUsd: number;
  /** M1's llm_usage table. InMemoryLlmUsageStore forgets spend on restart: dev and tests only. */
  usageStore: LlmUsageStore;
  events: DomainEvents;
  audit: Audit;
  log: AgentLogger;
}

/** The Agent the sessions module (#32) plugs in where FakeAgent sits today. */
export function createAgent(options: CreateAgentOptions): AgentRuntime {
  const { anthropicApiKey, dailyBudgetUsd, usageStore, events, audit, log } = options;
  const budget = new LlmBudget({ store: usageStore, dailyBudgetUsd });
  const llm = anthropicApiKey
    ? new AnthropicLlmClient({ client: new Anthropic({ apiKey: anthropicApiKey }), log, budget })
    : null;
  if (!llm) log.warn("ANTHROPIC_API_KEY is not set: the agent runs in L1 only");
  return new AgentRuntime({ llm, events, audit, log });
}
