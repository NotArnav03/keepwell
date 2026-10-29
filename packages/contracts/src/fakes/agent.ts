import { createHash } from "node:crypto";
import { ReasonCategory, type BillingInterval } from "../shared.js";
import { AgentStreamEvent, SessionContext, type Agent, type FallbackLevel } from "../brain/agent.js";
import { OfferKind, OfferMenu, type Offer } from "../brain/offers.js";
import { uuidv7 } from "./uuidv7.js";

const PAUSE_OFFER_ID = "offer-pause-1";
const DEFAULT_REPLY =
  "Thanks for telling me. If you just need a break, you can pause instead of cancelling. Cancel stays one click away.";
const CLOSE_REPLY = "Understood. The Cancel button below ends your subscription right away.";
const L1_REPLY = "Thanks. Here's one option that might help, or you can cancel below.";
const CANCEL_INTENT = /\b(cancel|unsubscribe)\b/i;

/**
 * Scripted Agent for building the widget, sessions API, dashboard and evals before the real
 * runtime exists. It never calls a model. Its menu is a single 1-cycle pause (when the policy
 * enables pause), it streams a fixed reply word by word, and it keeps the rules every
 * caller relies on: no-means-no, at most one offer per session, card text from the offer object.
 */
export class FakeAgent implements Agent {
  readonly calls: { method: "start" | "respond" | "respondToReason"; sessionId: string }[] = [];
  private readonly clock: () => Date;
  private readonly reply: string;
  private readonly fallbackLevel: FallbackLevel;

  constructor(options: { clock?: () => Date; reply?: string; fallbackLevel?: FallbackLevel } = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.reply = options.reply ?? DEFAULT_REPLY;
    this.fallbackLevel = options.fallbackLevel ?? "L0";
  }

  start(session: SessionContext): Promise<{ menu: OfferMenu; fallbackLevel: FallbackLevel }> {
    return new Promise((resolve) => {
      const parsed = SessionContext.parse(session);
      this.calls.push({ method: "start", sessionId: parsed.sessionId });
      resolve({ menu: this.menuFor(parsed), fallbackLevel: this.fallbackLevel });
    });
  }

  respond(session: SessionContext, text: string, stream: (event: AgentStreamEvent) => void): Promise<void> {
    return new Promise((resolve) => {
      const parsed = SessionContext.parse(session);
      this.calls.push({ method: "respond", sessionId: parsed.sessionId });
      const offer = this.firstUnusedOffer(parsed);
      if (CANCEL_INTENT.test(text) || !offer) this.say(stream, CLOSE_REPLY, null);
      else this.say(stream, this.reply, offer);
      resolve();
    });
  }

  respondToReason(
    session: SessionContext,
    reason: ReasonCategory,
    stream: (event: AgentStreamEvent) => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      const parsed = SessionContext.parse(session);
      this.calls.push({ method: "respondToReason", sessionId: parsed.sessionId });
      const menu = parsed.menu ?? this.menuFor(parsed);
      const offerId = menu.defaultByReason[ReasonCategory.parse(reason)];
      const offer = parsed.presentedOfferId === null ? menu.offers.find((o) => o.id === offerId) : undefined;
      if (offer) this.say(stream, L1_REPLY, offer);
      else this.say(stream, CLOSE_REPLY, null);
      resolve();
    });
  }

  private menuFor(session: SessionContext): OfferMenu {
    const now = this.clock();
    const { policy, subscription } = session;
    const offers: Offer[] = [];
    if (policy.offers.pause.enabled) {
      const from = subscription.nextBillingTime ?? now.toISOString();
      offers.push({
        id: PAUSE_OFFER_ID,
        kind: "pause",
        cycles: 1,
        resumesOn: addInterval(from, subscription.interval),
      });
    }
    const pauseId = offers[0]?.id ?? null;
    return OfferMenu.parse({
      policyVersion: policy.version,
      computedAt: now.toISOString(),
      offers,
      defaultByReason: Object.fromEntries(ReasonCategory.options.map((r) => [r, pauseId])),
      excluded: OfferKind.options
        .filter((kind) => kind !== "none" && (kind !== "pause" || pauseId === null))
        .map((kind) => ({ kind, because: "FakeAgent only offers pause" })),
    });
  }

  /** At most one offer per session: once one was shown, nothing else is offered. */
  private firstUnusedOffer(session: SessionContext): Offer | undefined {
    if (session.presentedOfferId !== null) return undefined;
    return (session.menu ?? this.menuFor(session)).offers[0];
  }

  private say(stream: (event: AgentStreamEvent) => void, text: string, offer: Offer | null): void {
    const emit = (event: AgentStreamEvent) => stream(AgentStreamEvent.parse(event));
    for (const word of text.split(/(?<= )/)) emit({ type: "agent.delta", text: word });
    if (offer) {
      const cardText = renderCardText(offer);
      const shownTextHash = createHash("sha256").update(`${text}\n${cardText}`).digest("hex");
      emit({ type: "offer.presented", offer, cardText, shownTextHash });
    }
    emit({ type: "agent.done", messageId: uuidv7(this.clock().getTime()) });
  }
}

/** Plain English card text. The real templates (en, hi, es) come with the claims checker (#25). */
function renderCardText(offer: Offer): string {
  switch (offer.kind) {
    case "pause":
      return `Pause for ${offer.cycles} billing cycle${offer.cycles === 1 ? "" : "s"}. Billing resumes on ${day(offer.resumesOn)}.`;
    case "downgrade":
      return `Switch to ${offer.toPlanName} for ${money(offer.newPrice)}.`;
    case "switch_annual":
      return `Switch to annual billing: ${money(offer.newPrice)} a year (${money(offer.effectiveMonthly)} a month).`;
    case "discount":
      return `${offer.percent}% off for ${offer.cycles} billing cycle${offer.cycles === 1 ? "" : "s"}: ${money(offer.newPrice)} from ${day(offer.firstAffectedBilling)}.`;
    case "refund_partial":
      return `A refund of ${money(offer.amount)} on your payment of ${day(offer.ofPaymentOn)}.`;
  }
}

const money = (m: { value: string; currency: string }) => `${m.value} ${m.currency}`;
const day = (iso: string) => iso.slice(0, 10);

function addInterval(iso: string, interval: BillingInterval): string {
  const d = new Date(iso);
  if (interval.unit === "DAY") d.setUTCDate(d.getUTCDate() + interval.count);
  if (interval.unit === "WEEK") d.setUTCDate(d.getUTCDate() + 7 * interval.count);
  if (interval.unit === "MONTH") d.setUTCMonth(d.getUTCMonth() + interval.count);
  if (interval.unit === "YEAR") d.setUTCFullYear(d.getUTCFullYear() + interval.count);
  return d.toISOString();
}
