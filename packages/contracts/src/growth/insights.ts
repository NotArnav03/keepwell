import { z } from "zod";
import { BillingInterval, Id, IsoDateTime, Money, ReasonCategory } from "../shared.js";

// ARCHITECTURE.md §6.12: quotes are short enough to show on a card and never identify anyone.
const QUOTE_MAX_WORDS = 20;

export const InsightQuote = z
  .string()
  .max(160)
  .refine((q) => q.trim().split(/\s+/).length <= QUOTE_MAX_WORDS, {
    message: `quote must be at most ${QUOTE_MAX_WORDS} words`,
  });

export const InsightSource = z.enum(["session", "winback_reply"]);

export const InsightRecord = z
  .object({
    sessionId: Id.nullable(),
    replyId: Id.nullable(),
    source: InsightSource,
    reason: ReasonCategory,
    subReason: z.string().nullable(),
    featureRequests: z.array(z.string()),
    competitor: z.string().nullable(),
    sentiment: z.enum(["negative", "neutral", "positive"]),
    quote: InsightQuote.nullable(),
  })
  .refine(
    (r) =>
      r.source === "session"
        ? r.sessionId !== null && r.replyId === null
        : r.replyId !== null && r.sessionId === null,
    { message: "a session insight needs only sessionId; a win-back insight needs only replyId" },
  );
export type InsightRecord = z.infer<typeof InsightRecord>;

export const InsightActionKind = z.enum(["create_plan", "update_policy", "send_winback_batch"]);
export type InsightActionKind = z.infer<typeof InsightActionKind>;

// Typed params per kind. The copilot's propose_action output is validated against these
// before an insight_actions row is written (LLM output is a zod boundary).
export const CreatePlanParams = z.object({
  name: z.string().min(1).max(127),
  description: z.string().max(127).nullable(),
  price: Money,
  interval: BillingInterval,
  // The existing plan whose product the new plan joins.
  basedOnPaypalPlanId: z.string(),
});

export const UpdatePolicyParams = z.object({
  summary: z.string().min(1),
  changes: z.array(z.object({ path: z.string().min(1), from: z.unknown(), to: z.unknown() })).min(1),
});

export const SendWinbackBatchParams = z.object({
  subscriptionIds: z.array(Id).min(1).max(500),
  reason: ReasonCategory.nullable(),
});

export const InsightActionProposal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create_plan"), params: CreatePlanParams }),
  z.object({ kind: z.literal("update_policy"), params: UpdatePolicyParams }),
  z.object({ kind: z.literal("send_winback_batch"), params: SendWinbackBatchParams }),
]);
export type InsightActionProposal = z.infer<typeof InsightActionProposal>;

export const InsightActionState = z.enum(["proposed", "approved", "rejected", "executed", "failed"]);
export type InsightActionState = z.infer<typeof InsightActionState>;

export const InsightAction = z.object({
  id: Id,
  merchantId: Id,
  kind: InsightActionKind,
  params: z.record(z.string(), z.unknown()),
  rationale: z.string(),
  // Computed deterministically from SQL aggregates, never by the model.
  estimate: z.object({ monthlyRevenueImpact: Money, basis: z.string() }).nullable(),
  state: InsightActionState,
  proposedBy: z.enum(["copilot", "merchant_mcp"]),
  actionId: Id.nullable(),
  createdAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
});
export type InsightAction = z.infer<typeof InsightAction>;
