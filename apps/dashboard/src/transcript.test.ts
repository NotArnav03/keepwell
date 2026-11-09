import { describe, expect, it } from "vitest";
import type { SessionStreamEvent } from "@keepwell/contracts";
import { condenseTranscript } from "./transcript.js";

const delta = (text: string): SessionStreamEvent => ({ type: "agent.delta", text });

describe("condenseTranscript", () => {
  it("joins a reply that arrived word by word into one line", () => {
    const lines = condenseTranscript([
      delta("Thanks "),
      delta("for "),
      delta("telling "),
      delta("me."),
      { type: "agent.done", messageId: "0199a1b2-0000-7000-8000-000000000001" },
    ]);
    expect(lines).toEqual([{ who: "Assistant", text: "Thanks for telling me.", tone: "neutral" }]);
  });

  it("keeps the order: question, reply, offer, outcome", () => {
    const lines = condenseTranscript([
      { type: "reason.chips", reasons: ["price", "other"] },
      delta("Here is one option."),
      {
        type: "offer.presented",
        offer: { id: "pause-1", kind: "pause", cycles: 1, resumesOn: "2026-12-01T00:00:00.000Z" },
        cardText: "Pause for 1 month.",
        shownTextHash: "a".repeat(64),
      },
      { type: "session.closed", outcome: "saved_pause", summary: "Paused until 1 Dec." },
    ] as SessionStreamEvent[]);
    expect(lines.map((l) => l.who)).toEqual(["Asked", "Assistant", "Offer shown", "Outcome"]);
    expect(lines[3]).toMatchObject({ tone: "good", text: "Paused until 1 Dec." });
  });

  it("shows each action state once, and a failure as one", () => {
    const update = (state: string, error: { code: string; message: string } | null = null) =>
      ({
        type: "action.update",
        actionId: "0199a1b2-0000-7000-8000-000000000002",
        actionType: "cancel",
        state,
        approveUrl: null,
        error,
      }) as unknown as SessionStreamEvent;
    const lines = condenseTranscript([
      update("EXECUTING"),
      update("EXECUTING"),
      update("FAILED", { code: "x", message: "PayPal said no" }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ who: "PayPal", tone: "bad" });
    expect(lines[1]?.text).toContain("PayPal said no");
  });

  it("flushes a reply that never got its done event, and says nothing for nothing", () => {
    expect(condenseTranscript([delta("Hello")])).toEqual([
      { who: "Assistant", text: "Hello", tone: "neutral" },
    ]);
    expect(condenseTranscript([])).toEqual([]);
  });
});
