import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../canonical-json.js";
import { ReasonCategory } from "../shared.js";
import type { Action } from "../platform/actions.js";
import type { DomainEvent } from "../platform/events.js";
import type { SubscriptionSnapshot } from "../platform/subscriptions.js";
import type {
  Agent,
  AgentStreamEvent,
  FallbackLevel,
  SessionContext,
  TranscriptTurn,
} from "../brain/agent.js";
import type { Offer, OfferMenu } from "../brain/offers.js";
import type { PlanInfo, PolicyDocument } from "../brain/policy.js";
import {
  AcceptOfferRequest,
  CancelRequest,
  Consent,
  CreateSessionRequest,
  CreateSessionResponse,
  PostMessageRequest,
  PostReasonRequest,
  SAVED_OUTCOME,
  Session,
  SessionError,
  SessionStreamEvent,
  summarizeSubscription,
  type AcceptOfferResponse,
  type CancelResponse,
  type RequestMeta,
  type SessionOutcome,
  type SessionsApi,
  type SessionStreamListener,
  type SubscriberPrincipal,
} from "../surfaces/sessions.js";
import { FakeActionEngine } from "./action-engine.js";
import { FakeAgent } from "./agent.js";
import { FakeAudit } from "./audit.js";
import { FakeDomainEvents } from "./domain-events.js";
import { PANTRY_PLAN, pantryPlanSubscription } from "./pantry-plan.js";
import { uuidv7 } from "./uuidv7.js";

/** ARCHITECTURE.md §6.5: after three messages the widget offers only Cancel and Keep. */
const MAX_SUBSCRIBER_MESSAGES = 3;
const CHIP_REASONS = ReasonCategory.options.filter((r) => r !== "unknown");
const NOTHING_APPLIED: readonly Action["state"][] = ["FAILED", "ABANDONED", "SUPERSEDED"];

/** Replaces FakeAgent's single pause for one subscription, e.g. to show a downgrade card or L1. */
export interface SessionScript {
  menu?: OfferMenu;
  fallbackLevel?: FallbackLevel;
}

export interface FakeSessionsApiOptions {
  clock?: () => Date;
  /** Must be the DomainEvents the action engine emits to, or action updates never reach the stream. */
  events?: FakeDomainEvents;
  actions?: FakeActionEngine;
  audit?: FakeAudit;
  agent?: Agent;
  merchantName?: string;
  policy?: PolicyDocument;
  plans?: PlanInfo[];
  /** Subscriptions a principal may open sessions for. Default: Maya on Standard. */
  subscriptions?: SubscriptionSnapshot[];
  /** Keyed by our subscription id. */
  scripts?: Record<string, SessionScript>;
  streamUrl?: (sessionId: string, principal: SubscriberPrincipal) => string;
}

interface Entry {
  session: Session;
  snapshot: SubscriptionSnapshot;
  /** null only while agent.start() runs. */
  menu: OfferMenu | null;
  transcript: TranscriptTurn[];
  /** The agent's reply so far, until agent.done. */
  reply: string;
  presented: { offer: Offer; shownTextHash: string } | null;
  answer: { kind: "accepted"; response: AcceptOfferResponse } | { kind: "declined" } | null;
  subscriberMessages: number;
  log: { seq: number; event: SessionStreamEvent }[];
  listeners: Set<SessionStreamListener>;
  /** Action id → the outcome its APPLIED state closes the session with. */
  pending: Map<string, SessionOutcome>;
  cancelActionId: string | null;
  cancelAttempts: number;
}

/**
 * In-memory SessionsApi for building the widget, portal and dashboard before the real sessions
 * module exists; the fake sessions server (`pnpm dev:fake-sessions`) serves it over HTTP. It
 * keeps the session rules on top of the other fakes: FakeAgent talks, FakeActionEngine holds the
 * Actions (move them with `actions.transition()`, as PayPal would), and every step is audited and
 * emitted. One offer per session; consent must match the shown text; accept and cancel are
 * idempotent; cancel works in every state and never calls the agent.
 */
export class FakeSessionsApi implements SessionsApi {
  readonly events: FakeDomainEvents;
  readonly actions: FakeActionEngine;
  readonly audit: FakeAudit;
  private readonly agent: Agent;
  private readonly clock: () => Date;
  private readonly merchantName: string;
  private readonly policy: PolicyDocument;
  private readonly plans: PlanInfo[];
  private readonly subscriptions: SubscriptionSnapshot[];
  private readonly scripts: Record<string, SessionScript>;
  private readonly streamUrl: (sessionId: string, principal: SubscriberPrincipal) => string;
  private readonly entries = new Map<string, Entry>();
  private readonly actionSessions = new Map<string, string>();

  constructor(options: FakeSessionsApiOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.events = options.events ?? new FakeDomainEvents(this.clock);
    this.actions = options.actions ?? new FakeActionEngine({ clock: this.clock, events: this.events });
    this.audit = options.audit ?? new FakeAudit(this.clock);
    this.agent = options.agent ?? new FakeAgent({ clock: this.clock });
    this.merchantName = options.merchantName ?? PANTRY_PLAN.name;
    this.policy = options.policy ?? PANTRY_PLAN.policy;
    this.plans = options.plans ?? PANTRY_PLAN.plans;
    this.subscriptions = options.subscriptions ?? [pantryPlanSubscription(this.clock())];
    this.scripts = options.scripts ?? {};
    this.streamUrl =
      options.streamUrl ?? ((sessionId) => `https://api.keepwell.example/v1/sessions/${sessionId}/stream`);
    this.events.on("action.state_changed", "sessions.stream", (event) => this.onActionChanged(event));
  }

  async create(principal: SubscriberPrincipal, body: CreateSessionRequest): Promise<CreateSessionResponse> {
    const { channel } = parseBody(CreateSessionRequest, body);
    if (channel !== principal.channel) {
      throw new SessionError("unauthorized", `This credential can't open a ${channel} session`);
    }
    const snapshot = this.subscriptions.find(
      (s) => s.id === principal.subscriptionId && s.merchantId === principal.merchantId,
    );
    if (!snapshot) throw new SessionError("unauthorized", "Unknown subscription");

    const now = this.clock();
    const entry: Entry = {
      session: {
        id: uuidv7(now.getTime()),
        merchantId: snapshot.merchantId,
        subscriptionId: snapshot.id,
        channel,
        state: "open",
        fallbackLevel: "L0",
        reason: "unknown",
        presentedOfferId: null,
        policyVersion: this.policy.version,
        outcome: null,
        startedAt: now.toISOString(),
        closedAt: null,
        simulated: false,
      },
      snapshot,
      menu: null,
      transcript: [],
      reply: "",
      presented: null,
      answer: null,
      subscriberMessages: 0,
      log: [],
      listeners: new Set(),
      pending: new Map(),
      cancelActionId: null,
      cancelAttempts: 0,
    };
    const started = await this.agent.start(this.context(entry));
    const script = this.scripts[snapshot.id];
    entry.menu = script?.menu ?? started.menu;
    const { session } = entry;
    session.fallbackLevel = script?.fallbackLevel ?? started.fallbackLevel;
    session.policyVersion = entry.menu.policyVersion;
    this.entries.set(session.id, entry);

    await this.events.emit({
      type: "session.started",
      merchantId: session.merchantId,
      payload: {
        sessionId: session.id,
        subscriptionId: session.subscriptionId,
        channel,
        fallbackLevel: session.fallbackLevel,
      },
    });
    await this.audit.append({
      merchantId: session.merchantId,
      actor: "subscriber",
      kind: "session.started",
      subjectIds: subjects(entry),
      payload: { channel, fallbackLevel: session.fallbackLevel, policyVersion: session.policyVersion },
    });
    if (session.fallbackLevel === "L1") this.push(entry, { type: "reason.chips", reasons: CHIP_REASONS });

    return CreateSessionResponse.parse({
      sessionId: session.id,
      subscription: summarizeSubscription(snapshot),
      fallbackLevel: session.fallbackLevel,
      streamUrl: this.streamUrl(session.id, principal),
      merchant: { name: this.merchantName, supportContact: this.policy.supportContact },
    });
  }

  subscribe(
    principal: SubscriberPrincipal,
    sessionId: string,
    afterSeq: number,
    listener: SessionStreamListener,
  ): Promise<{ unsubscribe: () => void; closed: boolean }> {
    return new Promise((resolve) => {
      const entry = this.entryFor(principal, sessionId);
      for (const { seq, event } of entry.log) if (seq > afterSeq) listener(seq, event);
      entry.listeners.add(listener);
      resolve({
        unsubscribe: () => {
          entry.listeners.delete(listener);
        },
        closed: entry.session.state === "closed",
      });
    });
  }

  async message(principal: SubscriberPrincipal, sessionId: string, body: PostMessageRequest): Promise<void> {
    const { text } = parseBody(PostMessageRequest, body);
    const entry = this.conversing(principal, sessionId);
    if (entry.subscriberMessages >= MAX_SUBSCRIBER_MESSAGES) {
      throw new SessionError("limit_reached", "That's the message limit for this conversation");
    }
    entry.subscriberMessages++;
    entry.transcript.push({ role: "subscriber", text, at: this.now() });
    await this.runAgent(entry, (context, stream) => this.agent.respond(context, text, stream));
  }

  async reason(principal: SubscriberPrincipal, sessionId: string, body: PostReasonRequest): Promise<void> {
    const { reason } = parseBody(PostReasonRequest, body);
    const entry = this.conversing(principal, sessionId);
    entry.session.reason = reason;
    await this.runAgent(entry, (context, stream) => this.agent.respondToReason(context, reason, stream));
  }

  async accept(
    principal: SubscriberPrincipal,
    sessionId: string,
    offerId: string,
    body: AcceptOfferRequest,
    meta: RequestMeta,
  ): Promise<AcceptOfferResponse> {
    const { shownTextHash } = parseBody(AcceptOfferRequest, body);
    const entry = this.entryFor(principal, sessionId);
    const { presented, answer, session } = entry;
    if (answer?.kind === "accepted" && presented?.offer.id === offerId) return answer.response;
    if (session.state === "closed") throw new SessionError("session_closed", "This conversation has ended");
    if (!presented || presented.offer.id !== offerId || answer) {
      throw new SessionError("offer_unavailable", "That offer isn't open in this conversation");
    }
    if (session.state === "awaiting_paypal") {
      throw new SessionError("action_in_progress", "A cancellation is already being applied");
    }
    if (shownTextHash !== presented.shownTextHash) {
      throw new SessionError("consent_mismatch", "The offer on screen doesn't match the offer on record");
    }

    const { offer } = presented;
    const consent = Consent.parse({
      offerHash: sha256(canonicalJson(offer)),
      shownTextHash,
      at: this.now(),
      channel: session.channel,
      ipPrefix: meta.ipPrefix,
      userAgent: meta.userAgent,
    });
    const action = await this.createOfferAction(entry, offer);
    const response: AcceptOfferResponse = { actionIds: [action.id], approveUrl: null };
    entry.answer = { kind: "accepted", response };
    entry.pending.set(action.id, SAVED_OUTCOME[offer.kind]);
    session.state = "awaiting_paypal";

    await this.events.emit({
      type: "session.offer_accepted",
      merchantId: session.merchantId,
      payload: {
        sessionId: session.id,
        subscriptionId: session.subscriptionId,
        offer,
        consent,
        actionIds: response.actionIds,
      },
    });
    await this.audit.append({
      merchantId: session.merchantId,
      actor: "subscriber",
      kind: "offer.accepted",
      subjectIds: { ...subjects(entry), actionId: action.id },
      payload: { offer, consent },
    });
    await this.track(entry, action);
    return response;
  }

  async decline(principal: SubscriberPrincipal, sessionId: string, offerId: string): Promise<void> {
    const entry = this.entryFor(principal, sessionId);
    const { presented, answer, session } = entry;
    if (answer?.kind === "declined" && presented?.offer.id === offerId) return;
    if (session.state === "closed") throw new SessionError("session_closed", "This conversation has ended");
    if (!presented || presented.offer.id !== offerId || answer) {
      throw new SessionError("offer_unavailable", "That offer isn't open in this conversation");
    }
    entry.answer = { kind: "declined" };
    if (session.state === "offer_presented") session.state = "open";

    await this.events.emit({
      type: "session.offer_declined",
      merchantId: session.merchantId,
      payload: { sessionId: session.id, subscriptionId: session.subscriptionId, offerId },
    });
    await this.audit.append({
      merchantId: session.merchantId,
      actor: "subscriber",
      kind: "offer.declined",
      subjectIds: subjects(entry),
      payload: { offerId },
    });
  }

  async keep(principal: SubscriberPrincipal, sessionId: string): Promise<void> {
    const entry = this.entryFor(principal, sessionId);
    const { session } = entry;
    if (session.state === "closed") {
      if (session.outcome === "kept_without_offer") return;
      throw new SessionError("session_closed", "This conversation has ended");
    }
    if (session.state === "awaiting_paypal") {
      throw new SessionError("action_in_progress", "A change is already being applied");
    }
    await this.close(entry, "kept_without_offer");
  }

  async cancel(
    principal: SubscriberPrincipal,
    sessionId: string,
    body: CancelRequest,
  ): Promise<CancelResponse> {
    const { reason } = parseBody(CancelRequest, body);
    const entry = this.entryFor(principal, sessionId);
    const { session } = entry;
    if (entry.cancelActionId !== null) {
      const previous = await this.actions.get(session.merchantId, entry.cancelActionId);
      // A double click gets the cancel already under way; only one that changed nothing is redone.
      if (previous && !NOTHING_APPLIED.includes(previous.state)) return { actionId: previous.id };
    }
    if (reason) session.reason = reason;
    entry.cancelAttempts++;
    const action = await this.actions.create({
      merchantId: session.merchantId,
      subscriptionId: session.subscriptionId,
      origin: "session",
      type: "cancel",
      params: { reason: "Cancelled by the subscriber" },
      idempotencyKey: `${session.id}:cancel:${entry.cancelAttempts}`,
    });
    entry.cancelActionId = action.id;
    // Cancel pre-empts everything: an offer still being applied no longer closes the session.
    entry.pending.clear();
    entry.pending.set(action.id, "cancelled");
    session.state = "awaiting_paypal";
    session.outcome = null;
    session.closedAt = null;

    await this.audit.append({
      merchantId: session.merchantId,
      actor: "subscriber",
      kind: "session.cancel_requested",
      subjectIds: { ...subjects(entry), actionId: action.id },
      payload: { reason: session.reason },
    });
    await this.track(entry, action);
    return { actionId: action.id };
  }

  /** The session as the sessions table would hold it, for assertions. */
  get(sessionId: string): Session | undefined {
    const entry = this.entries.get(sessionId);
    return entry ? structuredClone(entry.session) : undefined;
  }

  private entryFor(principal: SubscriberPrincipal, sessionId: string): Entry {
    const entry = this.entries.get(sessionId);
    if (
      !entry ||
      entry.session.merchantId !== principal.merchantId ||
      entry.session.subscriptionId !== principal.subscriptionId
    ) {
      throw new SessionError("not_found", "No such session");
    }
    return entry;
  }

  /** A session that can still take messages and reason chips. */
  private conversing(principal: SubscriberPrincipal, sessionId: string): Entry {
    const entry = this.entryFor(principal, sessionId);
    if (entry.session.state === "closed") {
      throw new SessionError("session_closed", "This conversation has ended");
    }
    if (entry.session.state === "awaiting_paypal") {
      throw new SessionError("action_in_progress", "A change is already being applied");
    }
    return entry;
  }

  private async runAgent(
    entry: Entry,
    call: (context: SessionContext, stream: (event: AgentStreamEvent) => void) => Promise<void>,
  ): Promise<void> {
    const effects: Promise<void>[] = [];
    await call(this.context(entry), (event) => {
      const effect = this.fromAgent(entry, event);
      if (effect) effects.push(effect);
    });
    await Promise.all(effects);
  }

  /** Forwards an agent event to the stream and keeps the session record in step with it. */
  private fromAgent(entry: Entry, event: AgentStreamEvent): Promise<void> | null {
    const { session } = entry;
    if (event.type === "offer.presented") {
      // One offer per session, whatever the agent does: a second one is never shown.
      if (entry.presented) return null;
      entry.presented = { offer: event.offer, shownTextHash: event.shownTextHash };
      session.presentedOfferId = event.offer.id;
      session.state = "offer_presented";
    }
    if (event.type === "agent.delta") entry.reply += event.text;
    if (event.type === "agent.done") {
      entry.transcript.push({ role: "agent", text: entry.reply, at: this.now() });
      entry.reply = "";
    }
    if (event.type === "fallback.changed") session.fallbackLevel = event.level;
    this.push(entry, event);
    return event.type === "offer.presented" ? this.offerPresented(entry, event.offer) : null;
  }

  /** The real agent runtime emits session.offer_presented itself; FakeAgent doesn't, so this does. */
  private async offerPresented(entry: Entry, offer: Offer): Promise<void> {
    const { session } = entry;
    await this.events.emit({
      type: "session.offer_presented",
      merchantId: session.merchantId,
      payload: {
        sessionId: session.id,
        subscriptionId: session.subscriptionId,
        offer,
        policyVersion: session.policyVersion,
      },
    });
    await this.audit.append({
      merchantId: session.merchantId,
      actor: "agent",
      kind: "offer.presented",
      subjectIds: subjects(entry),
      payload: { offer },
    });
  }

  private async createOfferAction(entry: Entry, offer: Offer): Promise<Action> {
    const { merchantId, subscriptionId, id } = entry.session;
    const base = {
      merchantId,
      subscriptionId,
      origin: "session",
      idempotencyKey: `${id}:${offer.id}`,
    } as const;
    switch (offer.kind) {
      case "pause": {
        const suspend = await this.actions.create({
          ...base,
          type: "suspend",
          params: { reason: "Paused at the subscriber's request" },
        });
        await this.actions.scheduleResume({ merchantId, subscriptionId, dueAt: offer.resumesOn });
        return suspend;
      }
      case "downgrade":
      case "switch_annual":
        return this.actions.create({ ...base, type: "revise", params: { planId: offer.toPlanId } });
      case "discount":
        return this.actions.create({ ...base, type: "patch_price", params: { fixedPrice: offer.newPrice } });
      case "refund_partial":
        // The real module looks the payment's transaction id up in PayPal; snapshots don't carry it.
        return this.actions.create({
          ...base,
          type: "refund",
          params: { transactionId: `FAKE-TXN-${entry.snapshot.paypalSubscriptionId}`, amount: offer.amount },
        });
    }
  }

  /** Links an Action to its session, then reports the state it's already in. */
  private async track(entry: Entry, action: Action): Promise<void> {
    this.actionSessions.set(action.id, entry.session.id);
    await this.onActionState(entry, action);
  }

  private async onActionChanged(event: DomainEvent<"action.state_changed">): Promise<void> {
    const { actionId, type, to, approveUrl, error } = event.payload;
    const sessionId = this.actionSessions.get(actionId);
    const entry = sessionId === undefined ? undefined : this.entries.get(sessionId);
    // Skips Actions from elsewhere, and the PENDING event fired inside create(): track() reports it.
    if (!entry) return;
    await this.onActionState(entry, { id: actionId, type, state: to, approveUrl, error });
  }

  private async onActionState(
    entry: Entry,
    action: Pick<Action, "id" | "type" | "state" | "approveUrl" | "error">,
  ): Promise<void> {
    this.push(entry, {
      type: "action.update",
      actionId: action.id,
      actionType: action.type,
      state: action.state,
      approveUrl: action.approveUrl,
      error: action.error,
    });
    const outcome = entry.pending.get(action.id);
    if (outcome === undefined) return;
    if (action.state === "APPLIED") {
      entry.pending.delete(action.id);
      await this.close(entry, outcome);
    } else if (NOTHING_APPLIED.includes(action.state)) {
      // Nothing changed in PayPal, so the subscriber can still cancel or keep from here.
      entry.pending.delete(action.id);
      if (entry.pending.size === 0) entry.session.state = "open";
    }
  }

  private async close(entry: Entry, outcome: SessionOutcome): Promise<void> {
    const { session } = entry;
    session.state = "closed";
    session.outcome = outcome;
    session.closedAt = this.now();
    const offer = entry.answer?.kind === "accepted" ? (entry.presented?.offer ?? null) : null;
    this.push(entry, { type: "session.closed", outcome, summary: closingSummary(outcome, offer) });

    await this.events.emit({
      type: "session.closed",
      merchantId: session.merchantId,
      payload: {
        sessionId: session.id,
        subscriptionId: session.subscriptionId,
        outcome,
        reason: session.reason,
      },
    });
    await this.audit.append({
      merchantId: session.merchantId,
      actor: "system",
      kind: "session.closed",
      subjectIds: subjects(entry),
      payload: { outcome, reason: session.reason },
    });
  }

  private push(entry: Entry, event: SessionStreamEvent): void {
    Session.parse(entry.session);
    const parsed = SessionStreamEvent.parse(event);
    const seq = entry.log.length + 1;
    entry.log.push({ seq, event: parsed });
    for (const listener of entry.listeners) listener(seq, parsed);
  }

  private context(entry: Entry): SessionContext {
    const { session, snapshot } = entry;
    return {
      sessionId: session.id,
      merchantId: session.merchantId,
      channel: session.channel,
      policy: this.policy,
      subscription: snapshot,
      history: {
        savesLast365d: 0,
        pausesLast365d: 0,
        lastPauseEndedAt: null,
        refundedLast30d: { value: "0.00", currency: snapshot.price.currency },
      },
      plans: this.plans,
      menu: entry.menu,
      transcript: [...entry.transcript],
      presentedOfferId: session.presentedOfferId,
      fallbackLevel: session.fallbackLevel,
    };
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) throw new SessionError("invalid_request", z.prettifyError(result.error));
  return result.data;
}

function subjects(entry: Entry): Record<string, string> {
  return {
    sessionId: entry.session.id,
    subscriptionId: entry.session.subscriptionId,
    paypalSubscriptionId: entry.snapshot.paypalSubscriptionId,
  };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const money = (m: { value: string; currency: string }) => `${m.value} ${m.currency}`;
const day = (iso: string) => iso.slice(0, 10);

/** Plain English for the fake; the real module renders this from the i18n templates. */
function closingSummary(outcome: SessionOutcome, offer: Offer | null): string {
  if (outcome === "cancelled") return "Your subscription is cancelled. You won't be charged again.";
  if (outcome === "kept_without_offer") return "Nothing has changed. Your subscription continues as before.";
  if (outcome === "abandoned" || offer === null) return "This conversation ended without any change.";
  switch (offer.kind) {
    case "pause":
      return `Your subscription is paused. Billing restarts on ${day(offer.resumesOn)}.`;
    case "downgrade":
      return `You're now on ${offer.toPlanName} at ${money(offer.newPrice)}.`;
    case "switch_annual":
      return `You're now on annual billing at ${money(offer.newPrice)} a year.`;
    case "discount":
      return `${offer.percent}% off applies from ${day(offer.firstAffectedBilling)}.`;
    case "refund_partial":
      return `A refund of ${money(offer.amount)} is on its way.`;
  }
}
