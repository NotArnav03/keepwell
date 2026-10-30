import { describe, expect, it } from "vitest";
import type { CreateSessionResponse, Offer, SessionStreamEvent } from "@keepwell/contracts";
import {
  cancelFailed,
  cancelling,
  initialState,
  offerAction,
  reduce,
  type WidgetEvent,
  type WidgetState,
} from "./state.js";
import { readStreamEvent } from "./transport.js";

const session: CreateSessionResponse = {
  sessionId: "0199a1b2-c3d4-7e5f-8a6b-000000000099",
  subscription: {
    paypalSubscriptionId: "I-FAKE",
    planName: "Standard",
    price: { value: "12.00", currency: "USD" },
    interval: { unit: "MONTH", count: 1 },
    status: "ACTIVE",
    nextBillingTime: "2026-11-19T10:00:00.000Z",
    subscriberFirstName: "Maya",
  },
  fallbackLevel: "L0",
  streamUrl: "http://localhost:3000/v1/sessions/x/stream",
  merchant: { name: "Pantry Plan", supportContact: "help@pantryplan.example" },
};
const pause: Offer = { id: "offer-pause", kind: "pause", cycles: 2, resumesOn: "2027-01-19T10:00:00.000Z" };
const HASH = "a".repeat(64);

function run(...events: WidgetEvent[]): WidgetState {
  return events.reduce(reduce, initialState);
}
let seq = 0;
const s = (event: SessionStreamEvent): WidgetEvent => ({ type: "stream", seq: ++seq, event });

describe("widget state", () => {
  it("streams the agent's reply into one line", () => {
    seq = 0;
    const state = run(
      { type: "started", session },
      { type: "sent", text: "Travelling for two months" },
      s({ type: "agent.delta", text: "That " }),
      s({ type: "agent.delta", text: "makes sense." }),
      s({ type: "agent.done", messageId: session.sessionId }),
    );
    expect(state.phase).toBe("chat");
    expect(state.lines).toEqual([
      { role: "subscriber", text: "Travelling for two months" },
      { role: "agent", text: "That makes sense." },
    ]);
    expect(state.streaming).toBe(false);
  });

  it("skips events it has already seen on a reconnect", () => {
    const delta: SessionStreamEvent = { type: "agent.delta", text: "once" };
    const state = run(
      { type: "started", session },
      { type: "stream", seq: 1, event: delta },
      { type: "stream", seq: 1, event: delta },
    );
    expect(state.lines).toEqual([{ role: "agent", text: "once" }]);
    expect(state.lastSeq).toBe(1);
  });

  it("shows at most one offer", () => {
    seq = 0;
    const other: Offer = { ...pause, id: "offer-2" };
    const state = run(
      { type: "started", session },
      s({ type: "offer.presented", offer: pause, cardText: "Pause.", shownTextHash: HASH }),
      s({ type: "offer.presented", offer: other, cardText: "Again.", shownTextHash: HASH }),
    );
    expect(state.offer?.offer.id).toBe("offer-pause");
  });

  it("follows the offer's Action and closes with the summary", () => {
    seq = 0;
    const update = (state: "PENDING" | "APPLIED"): SessionStreamEvent => ({
      type: "action.update",
      actionId: "a1",
      actionType: "suspend",
      state,
      approveUrl: null,
      error: null,
    });
    const applying = run(
      { type: "started", session },
      s({ type: "offer.presented", offer: pause, cardText: "Pause.", shownTextHash: HASH }),
      { type: "answered", answer: "accepted" },
      s(update("PENDING")),
    );
    expect(offerAction(applying)).toMatchObject({ id: "a1", state: "PENDING" });
    const done = [
      s(update("APPLIED")),
      s({ type: "session.closed", outcome: "saved_pause", summary: "Paused." }),
    ].reduce(reduce, applying);
    expect(done).toMatchObject({ phase: "closed", closed: { outcome: "saved_pause", summary: "Paused." } });
  });

  it("knows when a cancel is under way and when it failed", () => {
    seq = 0;
    const requested = run({ type: "started", session }, { type: "cancel_requested", actionId: "c1" });
    expect(cancelling(requested)).toBe(true);
    const failed = reduce(
      requested,
      s({
        type: "action.update",
        actionId: "c1",
        actionType: "cancel",
        state: "FAILED",
        approveUrl: null,
        error: { code: "UNPROCESSABLE", message: "No" },
      }),
    );
    expect(cancelling(failed)).toBe(false);
    expect(cancelFailed(failed)).toBe(true);
  });

  it("goes to the L2 shell when the API is unreachable", () => {
    expect(run({ type: "offline" })).toMatchObject({ phase: "offline", fallbackLevel: "L2" });
  });
});

describe("readStreamEvent", () => {
  it("passes known events and skips unknown or broken ones", () => {
    expect(readStreamEvent('{"type":"agent.done","messageId":"m"}')).toEqual({
      type: "agent.done",
      messageId: "m",
    });
    expect(readStreamEvent('{"type":"offer.retracted"}')).toBeNull();
    expect(readStreamEvent("not json")).toBeNull();
  });
});
