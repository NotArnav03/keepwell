import Anthropic from "@anthropic-ai/sdk";
import type { Audit, DomainEvents } from "@keepwell/contracts";
import { AnthropicLlmClient } from "./anthropic.js";
import { GroqLlmClient } from "./groq.js";
import { LlmBudget, type LlmUsageStore } from "./budget.js";
export { PgLlmUsageStore } from "./pg-usage-store.js";
import type { AgentLogger, LlmClient } from "./llm.js";
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
  /** PgLlmUsageStore (the llm_usage table) in production. InMemoryLlmUsageStore forgets spend on restart: dev and tests only. */
  usageStore: LlmUsageStore;
  /** The budget the platform shares with createLlmClient. Omitted: createAgent makes one from the two options above. */
  budget?: LlmBudget;
  /** A client built by createLlmClient (any provider); null for L1 only. Omitted: built from anthropicApiKey. */
  llm?: LlmClient | null;
  events: DomainEvents;
  audit: Audit;
  log: AgentLogger;
}

/**
 * The one LlmClient other modules (insights, copilot) share with the agent. It must be built from
 * the SAME `LlmBudget` instance as `createAgent`'s, so the daily cap and the in-flight reservations
 * (`LlmBudget.reserve`) cover every caller. null when no API key is set.
 */
export function createLlmClient(options: {
  /** LLM_PROVIDER (ADR 0002). Omitted: anthropic. */
  provider?: LlmProvider;
  anthropicApiKey: string | undefined;
  groqApiKey?: string | undefined;
  budget: LlmBudget;
  log: AgentLogger;
}): LlmClient | null {
  const { budget, log } = options;
  if (options.provider === "groq") {
    return options.groqApiKey ? new GroqLlmClient({ apiKey: options.groqApiKey, budget, log }) : null;
  }
  return options.anthropicApiKey
    ? new AnthropicLlmClient({ client: new Anthropic({ apiKey: options.anthropicApiKey }), log, budget })
    : null;
}

/** Which model API the shared LlmClient calls. */
export type LlmProvider = "anthropic" | "groq";

/** The Agent the sessions module (#32) plugs in where FakeAgent sits today. */
export function createAgent(options: CreateAgentOptions): AgentRuntime {
  const { anthropicApiKey, dailyBudgetUsd, usageStore, events, audit, log } = options;
  // Pass `budget` to share one cap with createLlmClient; the default is a budget of its own.
  const budget = options.budget ?? new LlmBudget({ store: usageStore, dailyBudgetUsd });
  // The platform passes the client it already built, so every caller shares one.
  const llm = options.llm !== undefined ? options.llm : createLlmClient({ anthropicApiKey, budget, log });
  if (!llm) log.warn("No model API key is set: the agent runs in L1 only");
  return new AgentRuntime({ llm, events, audit, log });
}
