import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, like, lt, max, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  AcceptOfferRequest,
  CancelRequest,
  canonicalJson,
  Consent,
  CreateSessionRequest,
  CreateSessionResponse,
  Offer,
  OfferMenu,
  PostMessageRequest,
  PostReasonRequest,
  ReasonCategory,
  SAVED_OUTCOME,
  SessionError,
  SessionStreamEvent,
  summarizeSubscription,
  type AcceptOfferResponse,
  type Action,
  type ActionEngine,
  type Agent,
  type AgentStreamEvent,
  type Audit,
  type CancelResponse,
  type DomainEvent,
  type DomainEvents,
  type PolicyStore,
  type RequestMeta,
  type SessionContext,
  type SessionOutcome,
  type SessionsApi,
  type SessionStreamListener,
  type SubscriberPrincipal,
  type SubscriptionSnapshot,
  type SubscriptionSummary,
  type TranscriptTurn,
} from "@keepwell/contracts";
import {
  actions,
  merchants,
  messages,
  offers,
  sessionEvents,
  sessions,
  type Db,
  type Tx,
} from "@keepwell/db";
import { describeOffer, evaluateAcceptance } from "@keepwell/policy";
import { uuidv7 } from "../agent/ids.js";
import type { MerchantCatalog } from "../policy/service.js";
import { SessionFeed } from "./feed.js";
import { redact } from "./redact.js";
import { closingSummary } from "./summary.js";

// The real sessions module (#32): FakeSessionsApi's rules, kept in Postgres so a session survives
// a restart and any instance can serve it. ARCHITECTURE.md §6.5–6.8, CONTRACTS.md §4.
//
// Where things live:
// - `sessions`: state, reason, fallback level, outcome.
// - `offers`: one row per session. The menu computed at start, the one offer presented (with the
//   card text and its hash), the answer, and the consent record when accepted.
// - `messages`: the transcript, redacted (emails, phone and card numbers).
// - `session_events`: every SSE frame, numbered per session, so a reconnect replays from its seq.
// - `actions`: the session's Actions carry idempotency keys `<sessionId>:<offerId>` and
//   `<sessionId>:cancel:<n>`, which is how an Action's state change finds its session.
//
// Every write to a session runs in one transaction that locks its row, so two clicks, or a click
// and PayPal's answer, are applied one after the other. Cancel never touches the agent or a model.

/**
 * A stream with nothing new for this long is ended by the route, and a reconnect to a session this
 * quiet (and not waiting on PayPal) gets 204, so an open tab stops reaching the database. The
 * widget reopens the stream when the subscriber does something, and replay fills the gap.
 */
export const STREAM_IDLE_MS = 12 * 60_000;

/** A session untouched this long, and not waiting on PayPal, is closed as abandoned. */
export const ABANDON_AFTER_MS = 30 * 60_000;

/**
 * An accepted offer whose Actions changed nothing in PayPal (the buyer pressed Cancel on PayPal's
 * approval page, or it failed) can be accepted again, up to this many attempts in all.
 */
export const MAX_OFFER_ATTEMPTS = 3;

/** ARCHITECTURE.md §6.5: after three messages the widget offers only Cancel and Keep. */
export const MAX_SUBSCRIBER_MESSAGES = 3;
const NOTHING_APPLIED: readonly Action["state"][] = ["FAILED", "ABANDONED", "SUPERSEDED"];
const APPLIED: readonly Action["state"][] = ["APPLIED", "CONFIRMED"];
/** An agent that asks for options again within this time gets the same session and menu. */
const AGENT_SESSION_REUSE_MS = 30 * 60_000;
const CHIP_REASONS = ReasonCategory.options.filter((r) => r !== "unknown");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What `offers.picked_offer` holds once the agent has shown its one offer. */
const Presented = z.object({ offer: Offer, cardText: z.string(), shownTextHash: z.string() });
type Presented = z.infer<typeof Presented>;

/** What `offers.decision` holds once the offer was accepted: the answer a second click gets back. */
const Accepted = z.object({
  response: z.object({ actionIds: z.array(z.string()).min(1), approveUrl: z.string().nullable() }),
  /** How many times the offer was sent to PayPal; a retry follows one that changed nothing. */
  attempts: z.number().int().min(1).default(1),
});

/** A PayPal payment, as the refund lookup needs it. */
export interface PaymentLookup {
  listTransactions(
    merchantId: string,
    paypalSubscriptionId: string,
    range: { start: string; end: string },
  ): Promise<{ id: string; status: string; time: string }[]>;
}

export interface SessionsLogger {
  warn(obj: object, msg: string): void;
}

export interface DbSessionsApiOptions {
  db: Db;
  agent: Agent;
  engine: ActionEngine<Tx>;
  events: DomainEvents<Tx>;
  audit: Audit<Tx>;
  policies: PolicyStore;
  /** Plans, and the subscription's snapshot and history, for the agent and the accept re-check. */
  catalog: MerchantCatalog;
  /** Finds the capture a partial refund applies to (snapshots don't carry it). */
  payments: PaymentLookup;
  /** The absolute SSE URL for a session; it may carry a read-only ticket. */
  streamUrl: (sessionId: string, principal: SubscriberPrincipal) => string;
  feed?: SessionFeed;
  log?: SessionsLogger;
  clock?: () => Date;
  /** How often an open stream looks for events written elsewhere. */
  pollMs?: number;
  /** Default STREAM_IDLE_MS. */
  idleMs?: number;
  /** Default ABANDON_AFTER_MS. */
  abandonAfterMs?: number;
}

type SessionRow = typeof sessions.$inferSelect;
type OfferRow = typeof offers.$inferSelect;
type Push = (event: SessionStreamEvent) => Promise<void>;

export class DbSessionsApi implements SessionsApi {
  readonly feed: SessionFeed;
  private readonly o: DbSessionsApiOptions;
  private readonly clock: () => Date;

  constructor(options: DbSessionsApiOptions) {
    this.o = options;
    this.feed = options.feed ?? new SessionFeed();
    this.clock = options.clock ?? (() => new Date());
  }

  async create(principal: SubscriberPrincipal, body: CreateSessionRequest): Promise<CreateSessionResponse> {
    const { channel } = parseBody(CreateSessionRequest, body);
    if (channel !== principal.channel) {
      throw new SessionError("unauthorized", `This credential can't open a ${channel} session`);
    }
    return this.start(principal);
  }

  /** Starts a session on the principal's own channel (the HTTP body can't ask for subscriber_agent). */
  private async start(principal: SubscriberPrincipal): Promise<CreateSessionResponse> {
    const { channel } = principal;
    const { merchantId, subscriptionId } = principal;
    const [sample] = await this.o.catalog.samples(merchantId, [subscriptionId]);
    if (!sample) throw new SessionError("unauthorized", "Unknown subscription");
    const [stored, plans, merchantName] = await Promise.all([
      this.o.policies.current(merchantId),
      this.o.catalog.plans(merchantId),
      this.merchantName(merchantId),
    ]);
    if (!stored) throw new SessionError("internal", "This merchant has no published retention policy yet");

    const id = uuidv7(this.clock().getTime());
    const started = await this.o.agent.start({
      sessionId: id,
      merchantId,
      channel,
      policy: stored.document,
      subscription: sample.subscription,
      history: sample.history,
      plans,
      menu: null,
      transcript: [],
      presentedOfferId: null,
      fallbackLevel: "L0",
    });
    const menu = OfferMenu.parse(started.menu);

    await this.o.db.forMerchant(merchantId, async (tx) => {
      const [row] = await tx
        .insert(sessions)
        .values({
          id,
          merchantId,
          subscriptionId,
          channel,
          fallbackLevel: started.fallbackLevel,
          policyVersion: menu.policyVersion,
        })
        .returning();
      if (!row) throw new SessionError("internal", "The session wasn't stored");
      await tx.insert(offers).values({ merchantId, sessionId: id, menuSnapshot: menu });
      await this.o.events.emit(
        {
          type: "session.started",
          merchantId,
          payload: { sessionId: id, subscriptionId, channel, fallbackLevel: started.fallbackLevel },
        },
        tx,
      );
      await this.o.audit.append(
        {
          merchantId,
          actor: actorFor(row.channel),
          kind: "session.started",
          subjectIds: subjects(row, sample.subscription),
          payload: { channel, fallbackLevel: started.fallbackLevel, policyVersion: menu.policyVersion },
        },
        tx,
      );
      // Reason chips are for people; an agent reads the menu from get_retention_options.
      if (started.fallbackLevel === "L1" && channel !== "subscriber_agent") {
        await this.pusher(tx, row)({ type: "reason.chips", reasons: CHIP_REASONS });
      }
    });
    this.feed.wake(id);

    return CreateSessionResponse.parse({
      sessionId: id,
      subscription: summarizeSubscription(sample.subscription),
      fallbackLevel: started.fallbackLevel,
      streamUrl: this.o.streamUrl(id, principal),
      merchant: { name: merchantName, supportContact: stored.document.supportContact },
    });
  }

  async subscribe(
    principal: SubscriberPrincipal,
    sessionId: string,
    afterSeq: number,
    listener: SessionStreamListener,
  ): Promise<{ unsubscribe: () => void; closed: boolean; idle: boolean }> {
    await this.owned(principal, sessionId);
    let last = afterSeq;
    let stopped = false;
    let busy = false;
    let again = false;
    let timer: NodeJS.Timeout | undefined;
    // Polling costs a query a second, and on Neon an open tab would keep the compute awake: it
    // stops when the session closes, and the route ends an idle stream (see STREAM_IDLE_MS).
    const stopPolling = () => {
      clearInterval(timer);
      timer = undefined;
    };

    // One query at a time, in seq order. A wake during a query asks for one more pass, so nothing
    // written meanwhile is missed, and nothing at or below `last` is delivered twice.
    const pump = async (): Promise<void> => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          const rows = await this.o.db.forMerchant(principal.merchantId, (tx) =>
            tx
              .select({ seq: sessionEvents.seq, event: sessionEvents.event })
              .from(sessionEvents)
              .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.seq, last)))
              .orderBy(asc(sessionEvents.seq)),
          );
          for (const row of rows) {
            if (stopped) return;
            last = row.seq;
            const event = SessionStreamEvent.parse(row.event);
            listener(row.seq, event);
            // Nothing more comes on its own; a cancel after a save reopens the stream.
            if (event.type === "session.closed") stopPolling();
          }
        } while (again && !stopped);
      } finally {
        busy = false;
      }
    };
    const safePump = () => {
      if (stopped) return;
      pump().catch((err: unknown) => this.o.log?.warn({ err, sessionId }, "session stream read failed"));
    };

    // Watch before replaying, so an event written during the replay still wakes us.
    const unwatch = this.feed.watch(sessionId, safePump);
    await pump();
    const session = await this.owned(principal, sessionId);
    const closed = session.state === "closed";
    const idle =
      !closed &&
      session.state !== "awaiting_paypal" &&
      (await this.quietFor(principal, sessionId, session.startedAt));
    if (!closed && !idle) timer = setInterval(safePump, this.o.pollMs ?? 1000);
    return {
      closed,
      idle,
      unsubscribe: () => {
        stopped = true;
        stopPolling();
        unwatch();
      },
    };
  }

  /**
   * Nothing written to the session's stream for STREAM_IDLE_MS. A session with no events yet (L0
   * starts with none) counts from when it started, as abandonIdle does.
   */
  private async quietFor(
    principal: SubscriberPrincipal,
    sessionId: string,
    startedAt: Date,
  ): Promise<boolean> {
    const [row] = await this.o.db.forMerchant(principal.merchantId, (tx) =>
      tx
        .select({ at: max(sessionEvents.createdAt) })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId)),
    );
    const at = row?.at ? new Date(row.at) : startedAt;
    return this.clock().getTime() - at.getTime() > (this.o.idleMs ?? STREAM_IDLE_MS);
  }

  async message(principal: SubscriberPrincipal, sessionId: string, body: PostMessageRequest): Promise<void> {
    const { text } = parseBody(PostMessageRequest, body);
    const transcript = await this.inSession(principal, sessionId, async (tx, row) => {
      conversing(row);
      const turns = await this.transcript(tx, sessionId);
      if (turns.filter((t) => t.role === "subscriber").length >= MAX_SUBSCRIBER_MESSAGES) {
        throw new SessionError("limit_reached", "That's the message limit for this conversation");
      }
      await tx.insert(messages).values({
        merchantId: row.merchantId,
        sessionId,
        role: "subscriber",
        text: redact(text),
      });
      return turns;
    });
    // The model never sees emails, phone or card numbers (ARCHITECTURE.md §10): it gets the same
    // redacted text the transcript stores, and earlier turns are read back redacted too.
    await this.runAgent(principal, sessionId, transcript, (context, stream) =>
      this.o.agent.respond(context, redact(text), stream),
    );
  }

  async reason(principal: SubscriberPrincipal, sessionId: string, body: PostReasonRequest): Promise<void> {
    const { reason } = parseBody(PostReasonRequest, body);
    const transcript = await this.inSession(principal, sessionId, async (tx, row) => {
      conversing(row);
      await tx.update(sessions).set({ reason }).where(eq(sessions.id, sessionId));
      return this.transcript(tx, sessionId);
    });
    await this.runAgent(principal, sessionId, transcript, (context, stream) =>
      this.o.agent.respondToReason(context, reason, stream),
    );
  }

  async accept(
    principal: SubscriberPrincipal,
    sessionId: string,
    offerId: string,
    body: AcceptOfferRequest,
    meta: RequestMeta,
  ): Promise<AcceptOfferResponse> {
    const { shownTextHash } = parseBody(AcceptOfferRequest, body);
    const { merchantId, subscriptionId } = principal;

    // Read what the re-check needs before locking: catalog and policy reads, and for a refund a
    // PayPal call, shouldn't hold the session's row lock.
    await this.owned(principal, sessionId);
    const offerRow = await this.offerRow(merchantId, sessionId);
    const presented = offerRow ? presentedOf(offerRow) : null;
    const [sample] = await this.o.catalog.samples(merchantId, [subscriptionId]);
    const [stored, plans] = await Promise.all([
      this.o.policies.current(merchantId),
      this.o.catalog.plans(merchantId),
    ]);
    const refundTransaction =
      presented?.offer.id === offerId && presented.offer.kind === "refund_partial" && sample
        ? await this.findPayment(merchantId, sample.subscription, presented.offer.ofPaymentOn)
        : null;

    const outcome = await this.inSession(principal, sessionId, async (tx, row, push) => {
      const answer = await this.lockedOfferRow(tx, sessionId);
      const shown = presentedOf(answer);
      let attempt = 1;
      if (answer.status === "accepted" && shown?.offer.id === offerId) {
        // A second click gets the first click's Actions, unless they all changed nothing: then
        // this is the subscriber trying again, which goes through every check below once more.
        const earlier = Accepted.parse(answer.decision);
        const previous = await tx
          .select({ state: actions.state })
          .from(actions)
          .where(and(eq(actions.merchantId, merchantId), inArray(actions.id, earlier.response.actionIds)));
        const changedNothing =
          previous.length > 0 && previous.every((a) => NOTHING_APPLIED.includes(a.state));
        if (!changedNothing) return { response: earlier.response };
        attempt = earlier.attempts + 1;
        if (attempt > MAX_OFFER_ATTEMPTS) {
          throw new SessionError(
            "offer_unavailable",
            "That offer didn't go through. You can still cancel or keep your plan.",
          );
        }
      }
      if (row.state === "closed") throw new SessionError("session_closed", "This conversation has ended");
      if (!shown || shown.offer.id !== offerId || (answer.status !== "presented" && attempt === 1)) {
        throw new SessionError("offer_unavailable", "That offer isn't open in this conversation");
      }
      if (row.state === "awaiting_paypal") {
        throw new SessionError("action_in_progress", "A cancellation is already being applied");
      }
      if (shownTextHash !== shown.shownTextHash) {
        throw new SessionError("consent_mismatch", "The offer on screen doesn't match the offer on record");
      }
      if (!sample || !stored) throw new SessionError("internal", "The subscription or policy is missing");

      // The card may have sat open for hours: re-check it against today's policy and subscription.
      const menu = OfferMenu.parse(answer.menuSnapshot);
      const decision = evaluateAcceptance(
        stored.document,
        {
          now: this.now(),
          channel: row.channel,
          reason: row.reason,
          cancelIntent: false,
          offersPresentedThisSession: 0,
          subscription: sample.subscription,
          history: sample.history,
          plans,
        },
        { offer: shown.offer, policyVersion: menu.policyVersion },
      );
      const refundMissing = shown.offer.kind === "refund_partial" && refundTransaction === null;
      if (!decision.allowed || refundMissing) {
        await tx
          .update(offers)
          .set({ status: "refused_at_accept", decision, answeredAt: this.clock() })
          .where(eq(offers.id, answer.id));
        if (row.state === "offer_presented") {
          await tx.update(sessions).set({ state: "open" }).where(eq(sessions.id, sessionId));
        }
        await this.o.audit.append(
          {
            merchantId,
            actor: "policy",
            kind: "offer.refused_at_accept",
            subjectIds: subjects(row, sample.subscription),
            payload: {
              offerId,
              violations: refundMissing
                ? [{ rule: "refund_payment", message: "The payment to refund wasn't found in PayPal" }]
                : decision.violations,
            },
          },
          tx,
        );
        return { refused: true as const };
      }

      const consent = Consent.parse({
        offerHash: sha256(canonicalJson(shown.offer)),
        shownTextHash,
        at: this.now(),
        channel: row.channel,
        ipPrefix: meta.ipPrefix,
        userAgent: meta.userAgent,
      });
      const action = await this.createOfferAction(tx, row, shown.offer, refundTransaction, attempt);
      if (shown.offer.kind === "pause") {
        // Due only once the suspend applies, and dropped if it fails: the engine ties them together.
        await this.o.engine.scheduleResume(
          { merchantId, subscriptionId, dueAt: shown.offer.resumesOn, afterActionId: action.id },
          tx,
        );
      }
      const response: AcceptOfferResponse = { actionIds: [action.id], approveUrl: null };
      await tx
        .update(offers)
        .set({
          status: "accepted",
          consent,
          decision: { response, policy: decision, attempts: attempt },
          answeredAt: this.clock(),
        })
        .where(eq(offers.id, answer.id));
      await tx.update(sessions).set({ state: "awaiting_paypal" }).where(eq(sessions.id, sessionId));
      await this.o.events.emit(
        {
          type: "session.offer_accepted",
          merchantId,
          payload: { sessionId, subscriptionId, offer: shown.offer, consent, actionIds: response.actionIds },
        },
        tx,
      );
      await this.o.audit.append(
        {
          merchantId,
          actor: actorFor(row.channel),
          kind: "offer.accepted",
          subjectIds: { ...subjects(row, sample.subscription), actionId: action.id },
          payload: { offer: shown.offer, consent, attempt },
        },
        tx,
      );
      await push(actionUpdate(action));
      return { response };
    });
    if ("refused" in outcome) {
      throw new SessionError(
        "offer_unavailable",
        "That offer is no longer available. You can still cancel or keep.",
      );
    }
    return outcome.response;
  }

  async decline(principal: SubscriberPrincipal, sessionId: string, offerId: string): Promise<void> {
    const { merchantId, subscriptionId } = principal;
    await this.inSession(principal, sessionId, async (tx, row) => {
      const answer = await this.lockedOfferRow(tx, sessionId);
      const shown = presentedOf(answer);
      if (answer.status === "declined" && shown?.offer.id === offerId) return;
      if (row.state === "closed") throw new SessionError("session_closed", "This conversation has ended");
      if (!shown || shown.offer.id !== offerId || answer.status !== "presented") {
        throw new SessionError("offer_unavailable", "That offer isn't open in this conversation");
      }
      await tx
        .update(offers)
        .set({ status: "declined", answeredAt: this.clock() })
        .where(eq(offers.id, answer.id));
      if (row.state === "offer_presented") {
        await tx.update(sessions).set({ state: "open" }).where(eq(sessions.id, sessionId));
      }
      await this.o.events.emit(
        { type: "session.offer_declined", merchantId, payload: { sessionId, subscriptionId, offerId } },
        tx,
      );
      await this.o.audit.append(
        {
          merchantId,
          actor: actorFor(row.channel),
          kind: "offer.declined",
          subjectIds: { sessionId, subscriptionId },
          payload: { offerId },
        },
        tx,
      );
    });
  }

  async keep(principal: SubscriberPrincipal, sessionId: string): Promise<void> {
    await this.inSession(principal, sessionId, async (tx, row, push) => {
      if (row.state === "closed") {
        if (row.outcome === "kept_without_offer") return;
        throw new SessionError("session_closed", "This conversation has ended");
      }
      if (row.state === "awaiting_paypal") {
        throw new SessionError("action_in_progress", "A change is already being applied");
      }
      await this.close(tx, row, push, "kept_without_offer", null);
    });
  }

  /** Works in every state, including after a save. Never touches the agent or any model. */
  async cancel(
    principal: SubscriberPrincipal,
    sessionId: string,
    body: CancelRequest,
  ): Promise<CancelResponse> {
    const { reason } = parseBody(CancelRequest, body);
    const { merchantId, subscriptionId } = principal;
    return this.inSession(principal, sessionId, async (tx, row, push) => {
      const previous = await this.cancelActions(tx, merchantId, sessionId);
      const latest = previous[0];
      // A double click gets the cancel already under way; only one that changed nothing is redone.
      if (latest && !NOTHING_APPLIED.includes(latest.state)) return { actionId: latest.id };

      const action = await this.o.engine.create(
        {
          merchantId,
          subscriptionId,
          origin: "session",
          type: "cancel",
          params: { reason: "Cancelled by the subscriber" },
          idempotencyKey: `${sessionId}:cancel:${previous.length + 1}`,
        },
        tx,
      );
      const nextReason: ReasonCategory = reason ?? row.reason;
      await tx
        .update(sessions)
        .set({ state: "awaiting_paypal", reason: nextReason, outcome: null, closedAt: null })
        .where(eq(sessions.id, sessionId));
      await this.o.audit.append(
        {
          merchantId,
          actor: actorFor(row.channel),
          kind: "session.cancel_requested",
          subjectIds: { sessionId, subscriptionId, actionId: action.id },
          payload: { reason: nextReason },
        },
        tx,
      );
      await push(actionUpdate(action));
      return { actionId: action.id };
    });
  }

  /**
   * Register for `action.state_changed`: tells the session's stream, and closes the session when
   * its Action applied. A cancel pre-empts an offer still being applied, and only the latest
   * cancel attempt counts. At-least-once delivery is fine: a closed session stays closed.
   */
  async onActionStateChanged(event: DomainEvent<"action.state_changed">): Promise<void> {
    const { actionId, type, from, to, approveUrl, error } = event.payload;
    // The PENDING event fires inside create(); the session already streamed that state.
    if (from === null) return;
    const merchantId = event.merchantId;
    const [action] = await this.o.db.forMerchant(merchantId, (tx) =>
      tx
        .select({ key: actions.idempotencyKey, subscriptionId: actions.subscriptionId })
        .from(actions)
        .where(and(eq(actions.id, actionId), eq(actions.merchantId, merchantId))),
    );
    const sessionId = action?.key?.split(":")[0];
    if (!action || !sessionId || !UUID.test(sessionId) || !action.subscriptionId) return;
    // The session is found by the Action's own merchant and subscription; the channel plays no part.
    const principal = { merchantId, subscriptionId: action.subscriptionId, channel: "widget" as const };
    const isCancel = action.key?.startsWith(`${sessionId}:cancel:`) ?? false;

    await this.inSession(principal, sessionId, async (tx, row, push) => {
      await push({ type: "action.update", actionId, actionType: type, state: to, approveUrl, error });
      const latestCancel = (await this.cancelActions(tx, merchantId, sessionId))[0];
      const answer = await this.lockedOfferRow(tx, sessionId);
      const accepted = answer.status === "accepted" ? Accepted.parse(answer.decision) : null;
      const offer = accepted ? (presentedOf(answer)?.offer ?? null) : null;
      const reopen = () => tx.update(sessions).set({ state: "open" }).where(eq(sessions.id, sessionId));

      if (isCancel) {
        // Only the latest cancel attempt counts.
        if (latestCancel?.id !== actionId) return;
        if (APPLIED.includes(to)) {
          if (row.state !== "closed") await this.close(tx, row, push, "cancelled", null);
          return;
        }
        if (!NOTHING_APPLIED.includes(to) || row.state !== "awaiting_paypal") return;
        // The cancel changed nothing. An offer it pre-empted may have gone through meanwhile: then
        // that is the outcome. One still being applied keeps the session waiting on PayPal.
        const offerStates = accepted
          ? await this.actionStates(tx, merchantId, accepted.response.actionIds)
          : [];
        if (offer && offerStates.some((s) => APPLIED.includes(s))) {
          return this.close(tx, row, push, SAVED_OUTCOME[offer.kind], offer);
        }
        if (offerStates.some((s) => !APPLIED.includes(s) && !NOTHING_APPLIED.includes(s))) return;
        await reopen();
        return;
      }

      // Only the latest attempt at the accepted offer counts: a late duplicate of one a retry
      // replaced must not reopen the session while the retry is in flight.
      if (!accepted?.response.actionIds.includes(actionId)) return;
      // A cancel that is still live (or applied) pre-empts the offer; one that changed nothing doesn't.
      if (latestCancel && !NOTHING_APPLIED.includes(latestCancel.state)) return;
      if (APPLIED.includes(to)) {
        if (row.state !== "closed" && offer)
          await this.close(tx, row, push, SAVED_OUTCOME[offer.kind], offer);
      } else if (NOTHING_APPLIED.includes(to) && row.state === "awaiting_paypal") {
        // Nothing changed in PayPal, so the subscriber can still retry, cancel or keep from here.
        await reopen();
      }
    });
  }

  // ---------- the subscriber's own agent (MCP, #41) ----------
  //
  // An agent holding a delegation token gets the policy's menu as structured data, accepts by
  // offer id, and can always cancel in one call. No model is involved: the menu comes from the
  // policy engine, and consent is the agent's call under a token the subscriber scoped to it.
  // Each of these runs in a session on the subscriber_agent channel, so the dashboard and the
  // audit log show what came through an agent.

  /** The subscription the token is bound to: the subscriber's own data, no email or payer id. */
  async agentSubscription(principal: SubscriberPrincipal): Promise<SubscriptionSummary> {
    const [sample] = await this.o.catalog.samples(principal.merchantId, [principal.subscriptionId]);
    if (!sample) throw new SessionError("not_found", "The subscription for this token is gone");
    return summarizeSubscription(sample.subscription);
  }

  /** The offers the policy allows right now, in an agent session that agentAccept then uses. */
  async agentOptions(principal: SubscriberPrincipal): Promise<{ sessionId: string; menu: OfferMenu }> {
    const who = agentChannel(principal);
    const current = await this.latestAgentSession(who);
    if (current?.state === "open" && current.ageMs < AGENT_SESSION_REUSE_MS) {
      const answer = await this.offerRow(who.merchantId, current.id);
      if (answer && answer.pickedOffer === null) {
        return { sessionId: current.id, menu: OfferMenu.parse(answer.menuSnapshot) };
      }
    }
    const created = await this.start(who);
    const answer = await this.offerRow(who.merchantId, created.sessionId);
    if (!answer) throw new SessionError("internal", "The agent session has no menu");
    return { sessionId: created.sessionId, menu: OfferMenu.parse(answer.menuSnapshot) };
  }

  /**
   * Accepts an offer from the agent session's menu. The structured offer the agent received is
   * what was "shown", so its hash is the consent's shownTextHash.
   */
  async agentAccept(
    principal: SubscriberPrincipal,
    offerId: string,
    meta: RequestMeta,
  ): Promise<AcceptOfferResponse> {
    const who = agentChannel(principal);
    const current = await this.latestAgentSession(who);
    if (!current) {
      throw new SessionError(
        "offer_unavailable",
        "Call get_retention_options first, then accept one of its offers",
      );
    }
    const hash = await this.inSession(who, current.id, async (tx, row, push) => {
      const answer = await this.lockedOfferRow(tx, current.id);
      const shown = presentedOf(answer);
      if (shown) {
        if (shown.offer.id !== offerId) {
          throw new SessionError("offer_unavailable", "Another offer was already accepted in this session");
        }
        return shown.shownTextHash;
      }
      const offer = OfferMenu.parse(answer.menuSnapshot).offers.find((o) => o.id === offerId);
      if (!offer) throw new SessionError("offer_unavailable", "That offer isn't one of the current options");
      const presented: Presented = {
        offer,
        cardText: describeOffer(offer),
        shownTextHash: sha256(canonicalJson(offer)),
      };
      await tx.update(offers).set({ pickedOffer: presented }).where(eq(offers.id, answer.id));
      if (row.state === "open") {
        await tx
          .update(sessions)
          .set({ state: "offer_presented", presentedOfferId: offer.id })
          .where(eq(sessions.id, current.id));
      }
      await push({
        type: "offer.presented",
        offer,
        cardText: presented.cardText,
        shownTextHash: presented.shownTextHash,
      });
      return presented.shownTextHash;
    });
    return this.accept(who, current.id, offerId, { shownTextHash: hash }, meta);
  }

  /** One call, whatever state things are in. Never touches the agent. */
  async agentCancel(principal: SubscriberPrincipal, body: CancelRequest): Promise<CancelResponse> {
    const who = agentChannel(principal);
    const current = await this.latestAgentSession(who);
    const sessionId = current?.id ?? (await this.bareAgentSession(who));
    return this.cancel(who, sessionId, body);
  }

  /** The newest agent session for this subscription that isn't closed. */
  private async latestAgentSession(principal: SubscriberPrincipal) {
    const [row] = await this.o.db.forMerchant(principal.merchantId, (tx) =>
      tx
        .select({ id: sessions.id, state: sessions.state, startedAt: sessions.startedAt })
        .from(sessions)
        .where(
          and(
            eq(sessions.merchantId, principal.merchantId),
            eq(sessions.subscriptionId, principal.subscriptionId),
            eq(sessions.channel, "subscriber_agent"),
            ne(sessions.state, "closed"),
          ),
        )
        .orderBy(desc(sessions.startedAt), desc(sessions.id))
        .limit(1),
    );
    return row ? { ...row, ageMs: this.clock().getTime() - row.startedAt.getTime() } : null;
  }

  /** A session for a cancel with nothing before it: no agent, no menu, nothing that can fail first. */
  private async bareAgentSession(principal: SubscriberPrincipal): Promise<string> {
    const stored = await this.o.policies.current(principal.merchantId).catch(() => null);
    const id = uuidv7(this.clock().getTime());
    const menu: OfferMenu = {
      policyVersion: stored?.version ?? 1,
      computedAt: this.now(),
      offers: [],
      defaultByReason: Object.fromEntries(
        ReasonCategory.options.map((r) => [r, null]),
      ) as OfferMenu["defaultByReason"],
      excluded: [],
    };
    await this.o.db.forMerchant(principal.merchantId, async (tx) => {
      await tx.insert(sessions).values({
        id,
        merchantId: principal.merchantId,
        subscriptionId: principal.subscriptionId,
        channel: "subscriber_agent",
        policyVersion: menu.policyVersion,
      });
      await tx.insert(offers).values({ merchantId: principal.merchantId, sessionId: id, menuSnapshot: menu });
    });
    return id;
  }

  private async actionStates(tx: Tx, merchantId: string, ids: string[]): Promise<Action["state"][]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select({ state: actions.state })
      .from(actions)
      .where(and(eq(actions.merchantId, merchantId), inArray(actions.id, ids)));
    return rows.map((r) => r.state);
  }

  /**
   * The `sessions.abandon_sweep` job: closes sessions nobody has touched for ABANDON_AFTER_MS as
   * `abandoned`, so the dashboard doesn't count them as open forever. Only `open` and
   * `offer_presented` ones: a session waiting on PayPal is PayPal's to finish. Each is re-checked
   * under its row lock, so a click that lands meanwhile wins. Returns how many it closed.
   */
  async abandonIdle(limit = 200): Promise<number> {
    const cutoff = new Date(this.clock().getTime() - (this.o.abandonAfterMs ?? ABANDON_AFTER_MS));
    const lastTouched = sql<Date>`coalesce((select max(${sessionEvents.createdAt}) from ${sessionEvents} where ${sessionEvents.sessionId} = ${sessions.id}), ${sessions.startedAt})`;
    const candidates = await this.o.db.acrossMerchants((tx) =>
      tx
        .select({ id: sessions.id, merchantId: sessions.merchantId, subscriptionId: sessions.subscriptionId })
        .from(sessions)
        .where(and(inArray(sessions.state, ["open", "offer_presented"]), lt(lastTouched, cutoff)))
        .orderBy(asc(sessions.startedAt))
        .limit(limit),
    );
    let closed = 0;
    for (const candidate of candidates) {
      const principal = {
        merchantId: candidate.merchantId,
        subscriptionId: candidate.subscriptionId,
        channel: "widget" as const,
      };
      const done = await this.inSession(principal, candidate.id, async (tx, row, push) => {
        if (row.state !== "open" && row.state !== "offer_presented") return false;
        const [latest] = await tx
          .select({ at: max(sessionEvents.createdAt) })
          .from(sessionEvents)
          .where(eq(sessionEvents.sessionId, row.id));
        const touched = latest?.at ? new Date(latest.at) : row.startedAt;
        if (touched.getTime() >= cutoff.getTime()) return false;
        await this.close(tx, row, push, "abandoned", null);
        return true;
      }).catch((err: unknown) => {
        this.o.log?.warn({ err, sessionId: candidate.id }, "abandoning a session failed");
        return false;
      });
      if (done) closed += 1;
    }
    return closed;
  }

  // ---------- internals ----------

  /**
   * Runs `fn` in one transaction with the session's row locked, then wakes its streams. Someone
   * else's session, or one that doesn't exist, is not_found.
   */
  private async inSession<T>(
    principal: SubscriberPrincipal,
    sessionId: string,
    fn: (tx: Tx, row: SessionRow, push: Push) => Promise<T>,
  ): Promise<T> {
    if (!UUID.test(sessionId)) throw notFound();
    let pushed = false;
    const result = await this.o.db.forMerchant(principal.merchantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.merchantId, principal.merchantId),
            eq(sessions.subscriptionId, principal.subscriptionId),
          ),
        )
        .for("update");
      if (!row) throw notFound();
      const push = this.pusher(tx, row);
      return fn(tx, row, async (event) => {
        pushed = true;
        await push(event);
      });
    });
    if (pushed) this.feed.wake(sessionId);
    return result;
  }

  /** Appends stream events for a session whose row this transaction holds locked. */
  private pusher(tx: Tx, row: SessionRow): Push {
    return async (event) => {
      const parsed = SessionStreamEvent.parse(event);
      const [top] = await tx
        .select({ seq: max(sessionEvents.seq) })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, row.id));
      await tx.insert(sessionEvents).values({
        merchantId: row.merchantId,
        sessionId: row.id,
        seq: (top?.seq ?? 0) + 1,
        event: parsed,
      });
    };
  }

  /** Calls the agent outside any transaction, and applies what it streams in order. */
  private async runAgent(
    principal: SubscriberPrincipal,
    sessionId: string,
    transcript: TranscriptTurn[],
    call: (context: SessionContext, stream: (event: AgentStreamEvent) => void) => Promise<void>,
  ): Promise<void> {
    const context = await this.context(principal, sessionId, transcript);
    let chain: Promise<void> = Promise.resolve();
    let reply = "";
    // A holder, so the check below sees what the callbacks set (narrowing would say it is still null).
    const failure: { error: Error | null } = { error: null };
    await call(context, (event) => {
      chain = chain
        .then(() =>
          this.inSession(principal, sessionId, async (tx, row, push) => {
            // The subscriber cancelled (or the session ended) while the agent was still talking:
            // the rest of the reply, and any offer in it, no longer belongs on the stream. agent.done
            // still goes through, so the widget closes the reply it already started showing.
            if ((row.state === "awaiting_paypal" || row.state === "closed") && event.type !== "agent.done") {
              return;
            }
            if (event.type === "offer.presented") {
              // One offer per session, whatever the agent does: a second one is never shown.
              const answer = await this.lockedOfferRow(tx, sessionId);
              if (answer.pickedOffer !== null) return;
              const presented: Presented = {
                offer: event.offer,
                cardText: event.cardText,
                shownTextHash: event.shownTextHash,
              };
              await tx.update(offers).set({ pickedOffer: presented }).where(eq(offers.id, answer.id));
              await tx
                .update(sessions)
                .set({
                  presentedOfferId: event.offer.id,
                  state: row.state === "open" ? "offer_presented" : row.state,
                })
                .where(eq(sessions.id, sessionId));
            }
            if (event.type === "agent.delta") reply += event.text;
            if (event.type === "agent.done") {
              await tx.insert(messages).values({
                merchantId: row.merchantId,
                sessionId,
                role: "agent",
                text: redact(reply),
              });
              reply = "";
            }
            if (event.type === "fallback.changed") {
              await tx.update(sessions).set({ fallbackLevel: event.level }).where(eq(sessions.id, sessionId));
            }
            await push(event);
          }),
        )
        .catch((err: unknown) => {
          failure.error ??= err instanceof Error ? err : new Error(String(err));
        });
    });
    await chain;
    if (failure.error) throw failure.error;
  }

  /** Everything the agent needs, loaded fresh (the runtime keeps no state between calls). */
  private async context(
    principal: SubscriberPrincipal,
    sessionId: string,
    transcript: TranscriptTurn[],
  ): Promise<SessionContext> {
    const { merchantId, subscriptionId } = principal;
    const [row, answer, samples, stored, plans] = await Promise.all([
      this.owned(principal, sessionId),
      this.offerRow(merchantId, sessionId),
      this.o.catalog.samples(merchantId, [subscriptionId]),
      this.o.policies.current(merchantId),
      this.o.catalog.plans(merchantId),
    ]);
    const sample = samples[0];
    if (!sample || !stored || !answer) {
      throw new SessionError("internal", "The subscription, policy or menu for this session is missing");
    }
    return {
      sessionId,
      merchantId,
      channel: row.channel,
      policy: stored.document,
      subscription: sample.subscription,
      history: sample.history,
      plans,
      menu: OfferMenu.parse(answer.menuSnapshot),
      transcript,
      presentedOfferId: row.presentedOfferId,
      fallbackLevel: row.fallbackLevel,
    };
  }

  private async close(
    tx: Tx,
    row: SessionRow,
    push: Push,
    outcome: SessionOutcome,
    offer: Offer | null,
  ): Promise<void> {
    await tx
      .update(sessions)
      .set({ state: "closed", outcome, closedAt: this.clock() })
      .where(eq(sessions.id, row.id));
    await push({ type: "session.closed", outcome, summary: closingSummary(outcome, offer) });
    await this.o.events.emit(
      {
        type: "session.closed",
        merchantId: row.merchantId,
        payload: { sessionId: row.id, subscriptionId: row.subscriptionId, outcome, reason: row.reason },
      },
      tx,
    );
    await this.o.audit.append(
      {
        merchantId: row.merchantId,
        actor: "system",
        kind: "session.closed",
        subjectIds: { sessionId: row.id, subscriptionId: row.subscriptionId },
        payload: { outcome, reason: row.reason },
      },
      tx,
    );
  }

  private async createOfferAction(
    tx: Tx,
    row: SessionRow,
    offer: Offer,
    refundTransaction: string | null,
    attempt = 1,
  ): Promise<Action> {
    const base = {
      merchantId: row.merchantId,
      subscriptionId: row.subscriptionId,
      origin: "session",
      // A retry is a new Action: the first keeps the plain key, later ones say which attempt.
      idempotencyKey: attempt === 1 ? `${row.id}:${offer.id}` : `${row.id}:${offer.id}:${attempt}`,
    } as const;
    switch (offer.kind) {
      case "pause":
        return this.o.engine.create(
          { ...base, type: "suspend", params: { reason: "Paused at the subscriber's request" } },
          tx,
        );
      case "downgrade":
      case "switch_annual":
        return this.o.engine.create({ ...base, type: "revise", params: { planId: offer.toPlanId } }, tx);
      case "discount":
        return this.o.engine.create(
          { ...base, type: "patch_price", params: { fixedPrice: offer.newPrice } },
          tx,
        );
      case "refund_partial":
        return this.o.engine.create(
          {
            ...base,
            type: "refund",
            params: { transactionId: refundTransaction ?? "", amount: offer.amount },
          },
          tx,
        );
    }
  }

  /** The completed PayPal payment nearest the one the offer names, or null. */
  private async findPayment(
    merchantId: string,
    subscription: SubscriptionSnapshot,
    paidOn: string,
  ): Promise<string | null> {
    const at = new Date(paidOn).getTime();
    const day = 24 * 3600_000;
    try {
      const found = await this.o.payments.listTransactions(merchantId, subscription.paypalSubscriptionId, {
        start: new Date(at - day).toISOString(),
        end: new Date(at + day).toISOString(),
      });
      const completed = found
        .filter((t) => t.status === "COMPLETED")
        .sort(
          (a, b) => Math.abs(new Date(a.time).getTime() - at) - Math.abs(new Date(b.time).getTime() - at),
        );
      return completed[0]?.id ?? null;
    } catch (err) {
      // Not a refusal: the offer stays open and the subscriber can accept again. Only a lookup that
      // worked and found no payment is recorded as refused_at_accept.
      this.o.log?.warn({ err, merchantId }, "refund payment lookup failed");
      throw new SessionError(
        "internal",
        "PayPal couldn't be reached to find the payment. Nothing was changed; please try again in a moment.",
      );
    }
  }

  private async cancelActions(tx: Tx, merchantId: string, sessionId: string) {
    return tx
      .select({ id: actions.id, state: actions.state })
      .from(actions)
      .where(and(eq(actions.merchantId, merchantId), like(actions.idempotencyKey, `${sessionId}:cancel:%`)))
      .orderBy(desc(actions.createdAt), desc(actions.id));
  }

  private async transcript(tx: Tx, sessionId: string): Promise<TranscriptTurn[]> {
    const rows = await tx
      .select({ role: messages.role, text: messages.text, at: messages.createdAt })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    return rows.map((r) => ({ role: r.role, text: r.text, at: r.at.toISOString() }));
  }

  private async lockedOfferRow(tx: Tx, sessionId: string): Promise<OfferRow> {
    const [row] = await tx.select().from(offers).where(eq(offers.sessionId, sessionId)).for("update");
    if (!row) throw new SessionError("internal", "This session has no menu");
    return row;
  }

  private async offerRow(merchantId: string, sessionId: string): Promise<OfferRow | null> {
    const [row] = await this.o.db.forMerchant(merchantId, (tx) =>
      tx.select().from(offers).where(eq(offers.sessionId, sessionId)),
    );
    return row ?? null;
  }

  /** The session, if it is this principal's. */
  private async owned(principal: SubscriberPrincipal, sessionId: string): Promise<SessionRow> {
    if (!UUID.test(sessionId)) throw notFound();
    const [row] = await this.o.db.forMerchant(principal.merchantId, (tx) =>
      tx
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.merchantId, principal.merchantId),
            eq(sessions.subscriptionId, principal.subscriptionId),
          ),
        ),
    );
    if (!row) throw notFound();
    return row;
  }

  private async merchantName(merchantId: string): Promise<string> {
    const [row] = await this.o.db.forMerchant(merchantId, (tx) =>
      tx.select({ name: merchants.name }).from(merchants).where(eq(merchants.id, merchantId)),
    );
    return row?.name ?? "Your subscription";
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

/** Audit entries say whether the subscriber acted, or their delegated agent did. */
function actorFor(channel: SessionRow["channel"]): "subscriber" | "subscriber_agent" {
  return channel === "subscriber_agent" ? "subscriber_agent" : "subscriber";
}

function agentChannel(principal: SubscriberPrincipal): SubscriberPrincipal {
  return { ...principal, channel: "subscriber_agent" };
}

/** A session that can still take messages and reason chips. */
function conversing(row: SessionRow): void {
  if (row.state === "closed") throw new SessionError("session_closed", "This conversation has ended");
  if (row.state === "awaiting_paypal") {
    throw new SessionError("action_in_progress", "A change is already being applied");
  }
}

function presentedOf(row: OfferRow): Presented | null {
  return row.pickedOffer === null ? null : Presented.parse(row.pickedOffer);
}

function actionUpdate(action: Action): SessionStreamEvent {
  return {
    type: "action.update",
    actionId: action.id,
    actionType: action.type,
    state: action.state,
    approveUrl: action.approveUrl,
    error: action.error,
  };
}

function subjects(row: SessionRow, subscription: SubscriptionSnapshot): Record<string, string> {
  return {
    sessionId: row.id,
    subscriptionId: row.subscriptionId,
    paypalSubscriptionId: subscription.paypalSubscriptionId,
  };
}

function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) throw new SessionError("invalid_request", z.prettifyError(result.error));
  return result.data;
}

function notFound(): SessionError {
  return new SessionError("not_found", "No such session");
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
