import {
  SessionError,
  summarizeSubscription,
  type AcceptOfferResponse,
  type Action,
  type ActionCreateInput,
  type CancelResponse,
  type Offer,
  type OfferMenu,
  type ReasonCategory,
  type RequestMeta,
  type SubscriberPrincipal,
  type SubscriptionSnapshot,
  type SubscriptionSummary,
} from "@keepwell/contracts";
import type { FakeSessionsApi } from "@keepwell/contracts/fakes";
import type { SubscriberAgentApi } from "./subscriber.js";

// The agent side of the sessions module, faked for the fake sessions server, so the real MCP
// server (subscriber.ts) can be tried locally with Claude Desktop or Claude Code before #32 is
// wired. Actions go through FakeSessionsApi's FakeActionEngine, where the fake server's timer
// moves them the way PayPal would, and every step is audited as the subscriber's agent.
// Local development only: fake-server.ts is its only user, and neither is in the build.

const NOTHING_APPLIED: readonly Action["state"][] = ["FAILED", "ABANDONED", "SUPERSEDED"];

export class FakeSubscriberAgent implements SubscriberAgentApi {
  /** What PayPal would now say about each subscription, once its Actions apply. */
  private readonly status = new Map<string, SubscriptionSnapshot["status"]>();
  private readonly accepted = new Map<string, { offerId: string; response: AcceptOfferResponse }>();
  private readonly cancels = new Map<string, string>();

  constructor(
    private readonly o: {
      api: FakeSessionsApi;
      subscriptions: SubscriptionSnapshot[];
      menuFor: (subscriptionId: string) => OfferMenu;
    },
  ) {
    o.api.events.on("action.state_changed", "fake.agent.status", (event) => {
      const { type, to } = event.payload;
      const subscriptionId = this.subscriptionOf(event.payload.actionId);
      if (subscriptionId && to === "APPLIED") {
        if (type === "suspend") this.status.set(subscriptionId, "SUSPENDED");
        if (type === "cancel") this.status.set(subscriptionId, "CANCELLED");
      }
      return Promise.resolve();
    });
  }

  agentSubscription(principal: SubscriberPrincipal): Promise<SubscriptionSummary> {
    const snapshot = this.snapshot(principal);
    return Promise.resolve({
      ...summarizeSubscription(snapshot),
      status: this.status.get(snapshot.id) ?? snapshot.status,
    });
  }

  agentOptions(principal: SubscriberPrincipal): Promise<{ sessionId: string; menu: OfferMenu }> {
    const snapshot = this.snapshot(principal);
    return Promise.resolve({ sessionId: `fake-agent-${snapshot.id}`, menu: this.agentMenu(snapshot.id) });
  }

  async agentAccept(
    principal: SubscriberPrincipal,
    offerId: string,
    _meta: RequestMeta,
  ): Promise<AcceptOfferResponse> {
    const snapshot = this.snapshot(principal);
    const earlier = this.accepted.get(snapshot.id);
    if (earlier) {
      if (earlier.offerId === offerId) return earlier.response;
      throw new SessionError("offer_unavailable", "Another offer was already accepted");
    }
    const offer = this.agentMenu(snapshot.id).offers.find((o) => o.id === offerId);
    if (!offer) throw new SessionError("offer_unavailable", "That offer isn't one of the current options");
    const action = await this.o.api.actions.create(actionFor(snapshot, offer));
    const response = { actionIds: [action.id], approveUrl: null };
    this.accepted.set(snapshot.id, { offerId, response });
    this.track(action.id, snapshot.id);
    await this.o.api.audit.append({
      merchantId: snapshot.merchantId,
      actor: "subscriber_agent",
      kind: "offer.accepted",
      subjectIds: { subscriptionId: snapshot.id, actionId: action.id },
      payload: { offer },
    });
    return response;
  }

  async agentCancel(
    principal: SubscriberPrincipal,
    body: { reason?: ReasonCategory },
  ): Promise<CancelResponse> {
    const snapshot = this.snapshot(principal);
    const previous = this.cancels.get(snapshot.id);
    if (previous) {
      const action = await this.o.api.actions.get(snapshot.merchantId, previous);
      if (action && !NOTHING_APPLIED.includes(action.state)) return { actionId: action.id };
    }
    const action = await this.o.api.actions.create({
      merchantId: snapshot.merchantId,
      subscriptionId: snapshot.id,
      origin: "session",
      type: "cancel",
      params: { reason: "Cancelled by the subscriber's agent" },
      idempotencyKey: `fake-agent:${snapshot.id}:cancel:${Date.now()}`,
    });
    this.cancels.set(snapshot.id, action.id);
    this.track(action.id, snapshot.id);
    await this.o.api.audit.append({
      merchantId: snapshot.merchantId,
      actor: "subscriber_agent",
      kind: "session.cancel_requested",
      subjectIds: { subscriptionId: snapshot.id, actionId: action.id },
      payload: { reason: body.reason ?? "unknown" },
    });
    return { actionId: action.id };
  }

  /** As the real module: plan changes need the subscriber's own PayPal approval, so agents don't get them. */
  private agentMenu(subscriptionId: string): OfferMenu {
    const menu = this.o.menuFor(subscriptionId);
    return {
      ...menu,
      offers: menu.offers.filter((o) => o.kind !== "downgrade" && o.kind !== "switch_annual"),
    };
  }

  private readonly actionSubscriptions = new Map<string, string>();

  private track(actionId: string, subscriptionId: string): void {
    this.actionSubscriptions.set(actionId, subscriptionId);
  }

  private subscriptionOf(actionId: string): string | undefined {
    return this.actionSubscriptions.get(actionId);
  }

  private snapshot(principal: SubscriberPrincipal): SubscriptionSnapshot {
    const found = this.o.subscriptions.find(
      (s) => s.id === principal.subscriptionId && s.merchantId === principal.merchantId,
    );
    if (!found) throw new SessionError("not_found", "The subscription for this token is gone");
    return found;
  }
}

function actionFor(snapshot: SubscriptionSnapshot, offer: Offer): ActionCreateInput {
  const base = {
    merchantId: snapshot.merchantId,
    subscriptionId: snapshot.id,
    origin: "session",
    idempotencyKey: `fake-agent:${snapshot.id}:${offer.id}`,
  } as const;
  switch (offer.kind) {
    case "pause":
      return { ...base, type: "suspend", params: { reason: "Paused by the subscriber's agent" } };
    case "downgrade":
    case "switch_annual":
      return { ...base, type: "revise", params: { planId: offer.toPlanId } };
    case "discount":
      return { ...base, type: "patch_price", params: { fixedPrice: offer.newPrice } };
    case "refund_partial":
      return {
        ...base,
        type: "refund",
        params: { transactionId: `FAKE-TXN-${snapshot.paypalSubscriptionId}`, amount: offer.amount },
      };
  }
}
