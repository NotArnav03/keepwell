import type {
  Agent,
  AgentStreamEvent,
  FallbackLevel,
  Offer,
  OfferMenu,
  ReasonCategory,
  SessionContext,
} from "@keepwell/contracts";
import { computeMenu } from "@keepwell/policy";

// A policy-backed stand-in agent for the harness tests. Well-behaved by default; each `misbehave`
// switch breaks one rule, so the tests can prove the checks catch it.

export interface Misbehaviour {
  offPolicy?: boolean;
  secondOffer?: boolean;
  ignoreCancel?: boolean;
  claimInText?: boolean;
  noCard?: boolean;
}

const CANCEL = /cancel|cancela|रद्द/i;
const DONE_ID = "0199a1b2-c3d4-7e5f-8a6b-00000000d0e0";

export class TestAgent implements Agent {
  constructor(
    private readonly clock: () => Date,
    private readonly misbehave: Misbehaviour = {},
    private readonly level: FallbackLevel = "L0",
  ) {}

  start(s: SessionContext): Promise<{ menu: OfferMenu; fallbackLevel: FallbackLevel }> {
    return Promise.resolve({ menu: this.menu(s, "unknown"), fallbackLevel: this.level });
  }

  respond(s: SessionContext, text: string, emit: (e: AgentStreamEvent) => void): Promise<void> {
    if (s.fallbackLevel === "L1") {
      this.say(emit, "Pick a reason below, or cancel.", null);
      emit({ type: "reason.chips", reasons: ["price", "temporary"] });
      return Promise.resolve();
    }
    const cancel = CANCEL.test(text) && !this.misbehave.ignoreCancel;
    const again = s.presentedOfferId !== null && !this.misbehave.secondOffer;
    let offer = cancel || again ? null : (this.menu(s, "unknown").offers[0] ?? null);
    if (offer && this.misbehave.offPolicy)
      offer = {
        id: "free-year",
        kind: "discount",
        percent: 100,
        cycles: 12,
        newPrice: { value: "0.00", currency: "USD" },
        firstAffectedBilling: this.clock().toISOString(),
      };
    this.say(emit, this.misbehave.claimInText ? "Only $5, last chance!" : "Here is one option.", offer);
    return Promise.resolve();
  }

  respondToReason(
    s: SessionContext,
    reason: ReasonCategory,
    emit: (e: AgentStreamEvent) => void,
  ): Promise<void> {
    const menu = this.menu(s, "unknown");
    const id = menu.defaultByReason[reason];
    this.say(emit, "Here is one option.", menu.offers.find((o) => o.id === id) ?? null);
    return Promise.resolve();
  }

  private menu(s: SessionContext, reason: ReasonCategory): OfferMenu {
    return computeMenu(s.policy, {
      now: this.clock().toISOString(),
      channel: s.channel,
      reason,
      cancelIntent: false,
      offersPresentedThisSession: 0,
      subscription: s.subscription,
      history: s.history,
      plans: s.plans,
    });
  }

  private say(emit: (e: AgentStreamEvent) => void, text: string, offer: Offer | null): void {
    emit({ type: "agent.delta", text });
    if (offer) {
      emit({
        type: "offer.presented",
        offer,
        cardText: this.misbehave.noCard ? "" : `card:${offer.kind}`,
        shownTextHash: "a".repeat(64),
      });
    }
    emit({ type: "agent.done", messageId: DONE_ID });
  }
}
