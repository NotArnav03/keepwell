import { z } from "zod";
import { ActionError, InsightAction, ReasonCategory, SessionOutcome } from "@keepwell/contracts";

// Response shapes that are not in packages/contracts yet. Each one should move there
// (label the PR contract-change) once the owning API branch has merged.

export const COPILOT_MAX_MESSAGES = 20;
export const COPILOT_MAX_TEXT = 2000;
/** The insights route rejects a quotes query above 50. */
export const INSIGHT_QUOTE_LIMIT = 50;
export const OUTBOX_PAGE_SIZE = 20;

/**
 * Mirrors `InsightsResponse` in `apps/api/src/modules/insights/queries.ts`
 * (origin/om/insights-extraction). Move to packages/contracts.
 */
export const InsightsResponse = z.object({
  range: z.object({ from: z.iso.date(), to: z.iso.date() }),
  total: z.number().int().min(0),
  byWeek: z.array(z.object({ week: z.iso.date(), count: z.number().int().min(0) })),
  byPlan: z.array(z.object({ plan: z.string(), count: z.number().int().min(0) })),
  byReason: z.array(z.object({ reason: ReasonCategory, count: z.number().int().min(0) })),
  /** "winback_reply" for win-back insights; "none" when a session closed without an outcome. */
  byOutcome: z.array(
    z.object({
      outcome: z.union([SessionOutcome, z.literal("winback_reply"), z.literal("none")]),
      count: z.number().int().min(0),
    }),
  ),
  topQuotes: z.array(
    z.object({
      quote: z.string(),
      reason: ReasonCategory,
      sentiment: z.enum(["negative", "neutral", "positive"]).nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type InsightsResponse = z.infer<typeof InsightsResponse>;

export const InsightsQuery = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    quotes: z.number().int().min(1).max(INSIGHT_QUOTE_LIMIT),
  })
  .refine((query) => query.from <= query.to, { message: "from must not be after to" });

/**
 * Mirrors `ChatMessage` in `apps/api/src/modules/insights/copilot/runtime.ts`
 * (origin/om/copilot). The field is `text`, which is what that route's zod object requires.
 * Move to packages/contracts.
 */
export const CopilotChatMessage = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1).max(COPILOT_MAX_TEXT),
});
export type CopilotChatMessage = z.infer<typeof CopilotChatMessage>;

export const CopilotRequest = z.object({
  messages: z.array(CopilotChatMessage).min(1).max(COPILOT_MAX_MESSAGES),
});

/**
 * Mirrors `CopilotEvent` in `apps/api/src/modules/insights/copilot/runtime.ts`.
 * The SSE `data` field is `JSON.stringify` of this object (see `frame` in routes.ts).
 * Move to packages/contracts.
 */
export const CopilotServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool_call"), tool: z.string().min(1) }),
  z.object({
    type: z.literal("tool_result"),
    tool: z.string().min(1),
    ok: z.boolean(),
    insightActionId: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("done"), flagged: z.boolean() }),
  z.object({ type: z.literal("error"), code: z.string().min(1), message: z.string() }),
]);
export type CopilotServerEvent = z.infer<typeof CopilotServerEvent>;

/**
 * Mirrors `Execution` / `InsightActionExecution` in
 * `apps/api/src/modules/insights/actions/store.ts` (origin/om/insight-actions).
 * One branch sends `error` as a string or null; the other sends an ActionError or omits it.
 * Move to packages/contracts.
 */
export const InsightActionExecution = z.object({
  status: z.enum(["pending", "confirmed", "failed", "not_applicable"]),
  error: z.union([z.string(), ActionError]).nullable().optional(),
});
export type InsightActionExecution = z.infer<typeof InsightActionExecution>;

/**
 * Mirrors `View` in `apps/api/src/modules/insights/actions/routes.ts`: the contract
 * `InsightAction` plus `error` and derived `execution`. `simulated` is optional so a
 * demo row can carry the same flag the rest of the dashboard badges, without rejecting
 * payloads that omit it. Move to packages/contracts.
 */
export const InsightActionView = InsightAction.extend({
  error: z.string().nullable(),
  execution: InsightActionExecution,
  simulated: z.boolean().optional(),
});
export type InsightActionView = z.infer<typeof InsightActionView>;

/** Mirrors `{ items: z.array(View) }` from the insight-action list route. */
export const InsightActionList = z.object({ items: z.array(InsightActionView) });
export type InsightActionList = z.infer<typeof InsightActionList>;
