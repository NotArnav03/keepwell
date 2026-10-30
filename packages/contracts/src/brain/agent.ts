import { z } from "zod";
import { Channel, Id, IsoDateTime, ReasonCategory } from "../shared.js";
import { Sha256Hex } from "../platform/audit.js";
import { SubscriptionSnapshot } from "../platform/subscriptions.js";
import { Offer, OfferMenu } from "./offers.js";
import { PlanInfo, PolicyDocument, SubscriberHistory } from "./policy.js";

// The agent runtime's seam with the sessions module (M2 → M3, M4, evals). ARCHITECTURE.md §6.5.

/** L0 full AI · L1 no AI (reason chips + template text) · L2 API unreachable (widget static shell). */
export const FallbackLevel = z.enum(["L0", "L1", "L2"]);
export type FallbackLevel = z.infer<typeof FallbackLevel>;

export const TranscriptTurn = z.object({
  role: z.enum(["subscriber", "agent"]),
  text: z.string(),
  at: IsoDateTime,
});
export type TranscriptTurn = z.infer<typeof TranscriptTurn>;

/**
 * Everything the agent needs for one call. The sessions module (M3) loads it fresh for every
 * request, so the agent keeps no state between calls and any API instance can serve a session.
 */
export const SessionContext = z.object({
  sessionId: Id,
  merchantId: Id,
  channel: Channel,
  policy: PolicyDocument,
  subscription: SubscriptionSnapshot,
  history: SubscriberHistory,
  plans: z.array(PlanInfo),
  /** null until start() has computed it. */
  menu: OfferMenu.nullable(),
  transcript: z.array(TranscriptTurn),
  /** The one offer already shown this session, if any. */
  presentedOfferId: z.string().nullable(),
  fallbackLevel: FallbackLevel,
});
export type SessionContext = z.infer<typeof SessionContext>;

/**
 * The SessionStreamEvent variants the agent produces (CONTRACTS.md §4). M3's SessionStreamEvent
 * is this union plus its own `action.update`, `session.closed` and `error`.
 */
export const AgentStreamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent.delta"), text: z.string() }),
  z.object({ type: z.literal("agent.done"), messageId: Id }),
  z.object({
    type: z.literal("offer.presented"),
    offer: Offer,
    /** Rendered from `offer` by template, never by the model. */
    cardText: z.string().min(1),
    /** sha256 of the exact card + message text shown; the accept click sends it back as consent. */
    shownTextHash: Sha256Hex,
  }),
  z.object({ type: z.literal("reason.chips"), reasons: z.array(ReasonCategory).min(1) }),
  z.object({ type: z.literal("fallback.changed"), level: FallbackLevel }),
]);
export type AgentStreamEvent = z.infer<typeof AgentStreamEvent>;

export interface Agent {
  /** Computes the menu and picks the starting fallback level (L1 if the AI is unavailable). */
  start(session: SessionContext): Promise<{ menu: OfferMenu; fallbackLevel: FallbackLevel }>;
  /** Replies to free text. Never parses consent from it: accepting is a button click. */
  respond(session: SessionContext, text: string, stream: (event: AgentStreamEvent) => void): Promise<void>;
  /** L1: the subscriber tapped a reason chip. No model call. */
  respondToReason(
    session: SessionContext,
    reason: ReasonCategory,
    stream: (event: AgentStreamEvent) => void,
  ): Promise<void>;
}

/** Domain events M2 produces (CONTRACTS.md §2); spread into domainEventPayloads. */
export const brainEventPayloads = {
  "session.offer_presented": z.object({
    sessionId: Id,
    subscriptionId: Id,
    offer: Offer,
    policyVersion: z.number().int().min(1),
  }),
  "policy.published": z.object({ version: z.number().int().min(1) }),
} as const;

/** M2 job queues (CONTRACTS.md §3), same shape as platformJobs. */
export const brainJobs = {
  "llm.budget_reset": {
    payload: z.strictObject({}),
    /** One reset per UTC day. */
    idempotencyKey: (_payload: Record<string, never>, now: Date): string => now.toISOString().slice(0, 10),
  },
} as const;
