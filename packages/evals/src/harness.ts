import type {
  Agent,
  AgentStreamEvent,
  FallbackLevel,
  Offer,
  OfferKind,
  ReasonCategory,
  SessionContext,
} from "@keepwell/contracts";
import { computeMenu } from "@keepwell/policy";
import type { Persona } from "./personas.js";
import { sessionFor } from "./scenarios.js";

// Plays one persona through an Agent the way the sessions module does: start(), then one call per
// subscriber move, with a fresh SessionContext each time. It records only what the subscriber saw,
// so the checks judge the output, not the agent's intentions.

/** What the subscriber does next. Cancel and accept are buttons, never parsed from text. */
export type SubscriberMove =
  | { type: "say"; text: string }
  | { type: "chip"; reason: ReasonCategory }
  | { type: "accept" }
  | { type: "cancel" };

export interface ShownTurn {
  /** The subscriber's message, or "[chip:<reason>]" for an L1 chip tap. */
  subscriber: string;
  /** Index of this message among the subscriber's messages, or null for a chip tap. */
  messageIndex: number | null;
  agentText: string;
  offer: Offer | null;
  cardText: string | null;
  chips: boolean;
  fallback: FallbackLevel | null;
  latencyMs: number;
}

export interface SessionView {
  persona: Persona;
  turns: ShownTurn[];
  /** The offer card on screen after the last turn, if any. */
  offerOnScreen: Offer | null;
  /** Offer kinds the policy ranks for the persona's real reason: what a fitting offer looks like. */
  fittingKinds: OfferKind[];
}

export interface Subscriber {
  next(view: SessionView): Promise<SubscriberMove>;
}

export type Outcome = "accepted" | "cancelled" | "abandoned";

/** Filled in by the runner from the agent's logs and usage records, when it has them. */
export interface Observation {
  /** The classifier's last answer. */
  classification: { reason: ReasonCategory; language: string; intent: string } | null;
  /** Replies the runtime sent back because the claims checker found something. */
  claimsCaught: number;
  /** Picks the policy re-check denied. */
  deniedPicks: number;
  /** The agent's own model spend for this session (not the simulator's or judge's). */
  costNanoUsd: number;
}

/** From the LLM judge, on real-model runs only. */
export interface Judgement {
  /** 0 = none, 3 = severe: guilt, urgency, pressure, flattery, invented features. */
  darkPatternScore: number;
  languageMatches: boolean;
  inventedFeature: boolean;
  notes: string;
}

export interface SessionRecord {
  personaId: string;
  sessionId: string;
  startLevel: FallbackLevel;
  turns: ShownTurn[];
  outcome: Outcome;
  observation: Observation | null;
  judgement: Judgement | null;
}

export interface RunSessionOptions {
  agent: Agent;
  subscriber: Subscriber;
  sessionId: string;
  clock: () => Date;
  /** Moves before giving up. The agent allows three messages; this leaves room for chips and a click. */
  maxMoves?: number;
}

export async function runSession(persona: Persona, options: RunSessionOptions): Promise<SessionRecord> {
  const { agent, subscriber, sessionId, clock } = options;
  const maxMoves = options.maxMoves ?? 6;
  const ctx: SessionContext = sessionFor(persona, sessionId, clock());
  const started = await agent.start(ctx);
  ctx.menu = started.menu;
  ctx.fallbackLevel = started.fallbackLevel;

  const fittingKinds = fittingKindsFor(persona, ctx, clock());
  const turns: ShownTurn[] = [];
  let offerOnScreen: Offer | null = null;
  let messagesSent = 0;

  for (let move = 0; move < maxMoves; move++) {
    const next = await subscriber.next({ persona, turns: [...turns], offerOnScreen, fittingKinds });
    if (next.type === "accept" || next.type === "cancel") {
      return record(next.type === "accept" ? "accepted" : "cancelled");
    }

    const events: AgentStreamEvent[] = [];
    const push = (e: AgentStreamEvent) => {
      events.push(e);
    };
    const t0 = performance.now();
    let said: string;
    let messageIndex: number | null = null;
    if (next.type === "say") {
      said = next.text;
      messageIndex = messagesSent++;
      await agent.respond(structuredClone(ctx), next.text, push);
    } else {
      said = `[chip:${next.reason}]`;
      await agent.respondToReason(structuredClone(ctx), next.reason, push);
    }
    const turn = shown(said, messageIndex, events, performance.now() - t0);
    turns.push(turn);

    // What the sessions module would persist between calls.
    const at = clock().toISOString();
    if (next.type === "say") ctx.transcript.push({ role: "subscriber", text: next.text, at });
    ctx.transcript.push({ role: "agent", text: turn.agentText, at });
    if (turn.fallback) ctx.fallbackLevel = turn.fallback;
    if (turn.offer) ctx.presentedOfferId = turn.offer.id;
    offerOnScreen = turn.offer ?? offerOnScreen;
  }
  return record("abandoned");

  function record(outcome: Outcome): SessionRecord {
    return {
      personaId: persona.id,
      sessionId,
      startLevel: started.fallbackLevel,
      turns,
      outcome,
      observation: null,
      judgement: null,
    };
  }
}

function shown(
  subscriber: string,
  messageIndex: number | null,
  events: AgentStreamEvent[],
  latencyMs: number,
) {
  let agentText = "";
  let offer: Offer | null = null;
  let cardText: string | null = null;
  let chips = false;
  let fallback: FallbackLevel | null = null;
  for (const e of events) {
    if (e.type === "agent.delta") agentText += e.text;
    else if (e.type === "offer.presented") {
      offer = e.offer;
      cardText = e.cardText;
    } else if (e.type === "reason.chips") chips = true;
    else if (e.type === "fallback.changed") fallback = e.level;
  }
  return { subscriber, messageIndex, agentText, offer, cardText, chips, fallback, latencyMs };
}

function fittingKindsFor(persona: Persona, ctx: SessionContext, now: Date): OfferKind[] {
  const menu = computeMenu(ctx.policy, {
    now: now.toISOString(),
    channel: ctx.channel,
    reason: persona.reason,
    cancelIntent: false,
    offersPresentedThisSession: 0,
    subscription: ctx.subscription,
    history: ctx.history,
    plans: ctx.plans,
  });
  return [...new Set(menu.offers.map((o) => o.kind))];
}

/**
 * The deterministic subscriber: says its scripted lines in order, clicks Cancel straight after
 * asking to cancel, takes an offer only if it fits and the persona would, and taps its reason chip
 * if the agent falls back to chips.
 */
export class ScriptedSubscriber implements Subscriber {
  next(view: SessionView): Promise<SubscriberMove> {
    const { persona, turns, offerOnScreen, fittingKinds } = view;
    const sent = turns.filter((t) => t.messageIndex !== null).length;
    const askedToCancel = persona.cancelAt !== null && sent > persona.cancelAt;
    const last = turns.at(-1);
    let move: SubscriberMove;
    if (askedToCancel) move = { type: "cancel" };
    else if (offerOnScreen) {
      const takes = persona.acceptsFittingOffer && fittingKinds.includes(offerOnScreen.kind);
      move = { type: takes ? "accept" : "cancel" };
    } else if (last?.chips && !turns.some((t) => t.messageIndex === null) && persona.reason !== "unknown") {
      move = { type: "chip", reason: persona.reason };
    } else if (sent < persona.messages.length && !last?.chips) {
      move = { type: "say", text: persona.messages[sent] as string };
    } else move = { type: "cancel" };
    return Promise.resolve(move);
  }
}
