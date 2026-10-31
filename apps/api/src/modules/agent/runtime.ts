import {
  AgentStreamEvent,
  ReasonCategory,
  SessionContext,
  type Agent,
  type Audit,
  type DomainEvents,
  type FallbackLevel,
  type Offer,
  type OfferMenu,
  type PolicyContext,
  type PolicyDecision,
  type TranscriptTurn,
} from "@keepwell/contracts";
import { computeMenu, evaluate, explain } from "@keepwell/policy";
import { renderCardText, shownTextHash } from "./cards.js";
import { checkClaims, type ClaimViolation } from "./claims.js";
import { resolveLocale, TEMPLATES, type Locale } from "./i18n.js";
import { uuidv7 } from "./ids.js";
import { LlmError, type AgentLogger, type LlmClient } from "./llm.js";
import {
  Classification,
  CLASSIFY_SYSTEM,
  classifyInput,
  CONVERSE_SYSTEM,
  converseInput,
  PROMPT_VERSION,
  Reply,
  type Classification as ClassificationT,
} from "./prompts.js";

// The agent runtime (ARCHITECTURE.md §6.5): Haiku classifies, a second Haiku call picks one action
// from the policy's menu, the policy re-checks the pick, and every offer card renders from the
// Offer object. Stateless: the sessions module hands it a fresh SessionContext on every call.

/** Hard session limits (§6.5). The sessions module also refuses a 4th message. */
export const MAX_SUBSCRIBER_MESSAGES = 3;
/** Past this, the session drops to L1 (§9: "timeout over 8 s"). */
export const DEFAULT_DEADLINE_MS = 8_000;

const CHIP_REASONS = ReasonCategory.options.filter((r) => r !== "unknown");

export { TEMPLATES } from "./i18n.js";

export interface AgentRuntimeOptions {
  /** null when no Anthropic key is configured: every session starts in L1. */
  llm: LlmClient | null;
  events: DomainEvents;
  audit: Audit;
  log: AgentLogger;
  clock?: () => Date;
  deadlineMs?: number;
}

type Emit = (event: AgentStreamEvent) => void;

/** One conversation reply after our checks. `offer` is set only when the policy allowed the pick. */
interface Checked {
  reply: Reply;
  offer: Offer | null;
  decision: PolicyDecision | null;
  pickOk: boolean;
  textOk: boolean;
  violations: ClaimViolation[];
}

export class AgentRuntime implements Agent {
  private readonly llm: LlmClient | null;
  private readonly events: DomainEvents;
  private readonly audit: Audit;
  private readonly log: AgentLogger;
  private readonly clock: () => Date;
  private readonly deadlineMs: number;

  constructor(options: AgentRuntimeOptions) {
    this.llm = options.llm;
    this.events = options.events;
    this.audit = options.audit;
    this.log = options.log;
    this.clock = options.clock ?? (() => new Date());
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  /**
   * The first menu uses reason "unknown", which allows every kind, so every reason chip's
   * default is on it if L1 is needed later (#73 review).
   */
  start(session: SessionContext): Promise<{ menu: OfferMenu; fallbackLevel: FallbackLevel }> {
    return new Promise((resolve) => {
      const s = SessionContext.parse(session);
      const menu = computeMenu(s.policy, policyContext(s, this.now(), "unknown", 0));
      resolve({ menu, fallbackLevel: this.llm === null ? "L1" : "L0" });
    });
  }

  async respond(session: SessionContext, text: string, stream: Emit): Promise<void> {
    const s = SessionContext.parse(session);
    const emit = checkedEmitter(stream);
    const llm = this.llm;
    // The session's language until the classifier hears the subscriber's own.
    let locale: Locale = resolveLocale(s.locale);
    if (llm === null || s.fallbackLevel !== "L0") return this.fallToL1(emit, false, locale);

    const transcript = withCurrentMessage(s.transcript, text, this.now());
    const subscriberTurns = transcript.filter((t) => t.role === "subscriber").length;
    if (subscriberTurns > MAX_SUBSCRIBER_MESSAGES)
      return this.say(emit, TEMPLATES[locale].limit, null, locale);

    const signal = AbortSignal.timeout(this.deadlineMs);
    const log = { sessionId: s.sessionId, merchantId: s.merchantId, subscriptionId: s.subscription.id };
    try {
      const classification = await retryOnce(() =>
        llm.structured({
          purpose: "classify",
          system: CLASSIFY_SYSTEM,
          input: classifyInput(transcript),
          schema: Classification,
          maxTokens: 1024,
          signal,
          sessionId: s.sessionId,
        }),
      );
      this.log.info({ ...log, classification, promptVersion: PROMPT_VERSION }, "agent classified");
      locale = resolveLocale(classification.language, s.locale);

      // No-means-no, abuse and distress close without a model reply and without an offer.
      if (classification.flags.includes("distress"))
        return this.say(emit, TEMPLATES[locale].care, null, locale);
      if (classification.intent === "cancel_now" || classification.flags.includes("abusive")) {
        return this.say(emit, TEMPLATES[locale].close, null, locale);
      }

      const presented = s.presentedOfferId === null ? 0 : 1;
      const ctx = policyContext(s, this.now(), classification.reason, presented);
      const menu = computeMenu(s.policy, ctx);
      if (menu.offers.length === 0) return this.say(emit, TEMPLATES[locale].close, null, locale);

      // One clarifying question per session, and only as the agent's first turn, when an answer
      // can still come. The transcript has no turn kinds, so "first agent turn" is the safe proxy.
      const agentTurns = transcript.filter((t) => t.role === "agent").length;
      const questionAllowed =
        presented === 0 && agentTurns === 0 && subscriberTurns < MAX_SUBSCRIBER_MESSAGES;
      const input = converseInput({ menu, classification, questionAllowed, transcript });

      let fallbackPick: Checked | null = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        let reply: Reply;
        try {
          reply = await llm.structured({
            purpose: "converse",
            system: CONVERSE_SYSTEM,
            input,
            schema: Reply,
            maxTokens: 2048,
            signal,
            sessionId: s.sessionId,
          });
        } catch (err) {
          if (err instanceof LlmError && err.failure === "invalid_output" && attempt === 1) continue;
          throw err;
        }
        const checked = this.check(s, ctx, menu, reply, questionAllowed);
        if (checked.pickOk && checked.textOk)
          return this.reply(s, emit, checked, reply.message, classification, locale);
        this.log.warn(
          {
            ...log,
            attempt,
            action: reply.action,
            offerId: reply.offerId,
            pickOk: checked.pickOk,
            textOk: checked.textOk,
            violations: checked.violations,
          },
          "agent reply rejected",
        );
        // Only an allowed offer is worth keeping; a later reply without one mustn't replace it.
        if (checked.offer) fallbackPick = checked;
      }
      // Two rejected replies: keep a pick the policy allowed, with template text; else close.
      if (fallbackPick?.offer)
        return this.reply(s, emit, fallbackPick, TEMPLATES[locale].offer, classification, locale);
      return this.say(emit, TEMPLATES[locale].close, null, locale);
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      this.log.warn({ ...log, failure: err.failure, err }, "agent falling back to L1");
      return this.fallToL1(emit, true, locale);
    }
  }

  /** L1: a reason chip was tapped. No model call; the policy's default for that reason, re-checked. */
  async respondToReason(session: SessionContext, reason: ReasonCategory, stream: Emit): Promise<void> {
    const s = SessionContext.parse(session);
    const chosen = ReasonCategory.parse(reason);
    const emit = checkedEmitter(stream);
    // A chip tap carries no text to detect a language from, so the session's language it is.
    const locale: Locale = resolveLocale(s.locale);
    if (s.presentedOfferId !== null) return this.say(emit, TEMPLATES[locale].close, null, locale);

    const now = this.now();
    const fullMenu = computeMenu(s.policy, policyContext(s, now, "unknown", 0));
    const offerId = fullMenu.defaultByReason[chosen];
    if (!offerId) return this.say(emit, TEMPLATES[locale].close, null, locale);
    const decision = evaluate(s.policy, policyContext(s, now, chosen, 0), offerId, fullMenu);
    if (!decision.allowed || !decision.offer) {
      this.log.warn(
        { sessionId: s.sessionId, reason: chosen, violations: decision.violations },
        "L1 default denied",
      );
      return this.say(emit, TEMPLATES[locale].close, null, locale);
    }
    await this.recordOffer(s, decision.offer, decision, chosen);
    this.say(emit, TEMPLATES[locale].offer, decision.offer, locale);
  }

  private check(
    s: SessionContext,
    ctx: PolicyContext,
    menu: OfferMenu,
    reply: Reply,
    questionAllowed: boolean,
  ): Checked {
    // The text is checked against the offer it would accompany: none unless the pick is allowed.
    const withText = (offer: Offer | null, decision: PolicyDecision | null, pickOk: boolean): Checked => {
      const violations = checkClaims(reply.message, offer);
      return { reply, offer, decision, pickOk, textOk: violations.length === 0, violations };
    };
    if (reply.action === "no_offer") return withText(null, null, true);
    if (reply.action === "ask_one_question") return withText(null, null, questionAllowed);
    if (reply.offerId === null) return withText(null, null, false);
    // Defence in depth: the pick is re-checked against a menu recomputed from scratch.
    const decision = evaluate(s.policy, ctx, reply.offerId, menu);
    const offer = decision.allowed ? decision.offer : null;
    return withText(offer, decision, offer !== null);
  }

  private async reply(
    s: SessionContext,
    emit: Emit,
    checked: Checked,
    message: string,
    classification: ClassificationT,
    locale: Locale,
  ): Promise<void> {
    if (checked.offer && checked.decision) {
      await this.recordOffer(s, checked.offer, checked.decision, classification.reason);
    }
    this.say(emit, message, checked.offer, locale);
  }

  /** Recorded before the card is shown, so the subscriber never sees an offer the log lacks. */
  private async recordOffer(
    s: SessionContext,
    offer: Offer,
    decision: PolicyDecision,
    reason: ReasonCategory,
  ): Promise<void> {
    await this.events.emit({
      type: "session.offer_presented",
      merchantId: s.merchantId,
      payload: {
        sessionId: s.sessionId,
        subscriptionId: s.subscription.id,
        offer,
        policyVersion: s.policy.version,
      },
    });
    await this.audit.append({
      merchantId: s.merchantId,
      actor: "agent",
      kind: "offer.presented",
      subjectIds: {
        sessionId: s.sessionId,
        subscriptionId: s.subscription.id,
        paypalSubscriptionId: s.subscription.paypalSubscriptionId,
      },
      payload: {
        offer,
        reason,
        fallbackLevel: s.fallbackLevel,
        promptVersion: PROMPT_VERSION,
        decision: explain(decision),
      },
    });
  }

  private fallToL1(emit: Emit, changed: boolean, locale: Locale): void {
    if (changed) emit({ type: "fallback.changed", level: "L1" });
    this.say(emit, TEMPLATES[locale].l1, null, locale);
    emit({ type: "reason.chips", reasons: CHIP_REASONS });
  }

  /** Streams the text, then the card (if any), then done: the order the widget expects. */
  private say(emit: Emit, message: string, offer: Offer | null, locale: Locale): void {
    for (const word of message.split(/(?<= )/)) emit({ type: "agent.delta", text: word });
    if (offer) {
      const cardText = renderCardText(offer, locale);
      emit({ type: "offer.presented", offer, cardText, shownTextHash: shownTextHash(message, cardText) });
    }
    emit({ type: "agent.done", messageId: uuidv7(this.clock().getTime()) });
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function policyContext(
  s: SessionContext,
  now: string,
  reason: ReasonCategory,
  offersPresentedThisSession: number,
): PolicyContext {
  return {
    now,
    channel: s.channel,
    reason,
    // cancel_now never reaches computeMenu: respond() closes first.
    cancelIntent: false,
    offersPresentedThisSession,
    subscription: s.subscription,
    history: s.history,
    plans: s.plans,
  };
}

/** The sessions module appends the message before calling respond(); tolerate one that didn't. */
function withCurrentMessage(transcript: TranscriptTurn[], text: string, at: string): TranscriptTurn[] {
  const last = transcript.at(-1);
  if (last?.role === "subscriber" && last.text === text) return transcript;
  return [...transcript, { role: "subscriber", text, at }];
}

function checkedEmitter(stream: Emit): Emit {
  return (event) => stream(AgentStreamEvent.parse(event));
}

/** zod at the model boundary: invalid output gets one more try (§6.5). */
async function retryOnce<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof LlmError && err.failure === "invalid_output") return call();
    throw err;
  }
}
