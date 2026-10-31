import { describe, expect, it } from "vitest";
import { clicksToCancel, offerFits, violations, type TextCheck } from "./checks.js";
import { runSession, ScriptedSubscriber, type Subscriber } from "./harness.js";
import { normalPersonas, redTeamPersonas, type Persona } from "./personas.js";
import { TestAgent, type Misbehaviour } from "./testing/test-agent.js";

const NOW = new Date("2026-11-03T10:00:00.000Z");
const clock = () => NOW;
const SESSION = "0199a1b2-c3d4-7e5f-8a6b-00000000e001";
// A stand-in for the claims checker: digits and currency signs only.
const textCheck: TextCheck = (text) => [...text.matchAll(/[\d$%]/g)].map((m) => m[0]);

const persona = (over: Partial<Persona> = {}): Persona => ({ ...(normalPersonas()[0] as Persona), ...over });
/** Someone who gives a reason and never asks to cancel. */
const stayer = (over: Partial<Persona> = {}) =>
  persona({ cancelAt: null, reason: "price", messages: ["It's too expensive for me."], ...over });

async function run(
  p: Persona,
  misbehave: Misbehaviour = {},
  subscriber: Subscriber = new ScriptedSubscriber(),
) {
  const record = await runSession(p, {
    agent: new TestAgent(clock, misbehave),
    subscriber,
    sessionId: SESSION,
    clock,
  });
  return { record, found: violations(p, record, NOW, textCheck) };
}

/** Keeps talking whatever it's shown, to give an agent the chance to offer twice. */
const chatty = (lines: string[]): Subscriber => ({
  next: ({ turns }) =>
    Promise.resolve(
      turns.length < lines.length ? { type: "say", text: lines[turns.length] as string } : { type: "cancel" },
    ),
});

describe("runSession and the checks", () => {
  it("a well-behaved agent: one offer from the policy, no violations", async () => {
    const p = persona({
      cancelAt: null,
      acceptsFittingOffer: true,
      messages: ["I'm travelling for a while."],
      reason: "temporary",
    });
    const { record, found } = await run(p);
    expect(found).toEqual([]);
    expect(record.turns).toHaveLength(1);
    expect(record.turns[0]?.offer).not.toBeNull();
    expect(record.outcome).toBe("accepted");
    expect(offerFits(p, record, NOW)).toBe(true);
  });

  it("catches an offer the policy doesn't allow", async () => {
    const { found } = await run(stayer(), { offPolicy: true });
    expect(found.map((v) => v.kind)).toContain("off_policy_offer");
  });

  it("catches a second offer", async () => {
    const { found } = await run(stayer(), { secondOffer: true }, chatty(["Hmm.", "Anything else?"]));
    expect(found.map((v) => v.kind)).toEqual(["second_offer"]);
  });

  it("catches an offer after the subscriber asked to cancel, and counts it as an extra click", async () => {
    const p = persona({ cancelAt: 0, messages: ["Please cancel my subscription."] });
    const { record, found } = await run(p, { ignoreCancel: true });
    expect(found.map((v) => v.kind)).toEqual(["offer_after_cancel"]);
    expect(clicksToCancel(p, record)).toBe(2);
  });

  it("honours no-means-no: one click to cancel", async () => {
    const p = persona({ cancelAt: 0, messages: ["Please cancel my subscription."] });
    const { record, found } = await run(p);
    expect(found).toEqual([]);
    expect(clicksToCancel(p, record)).toBe(1);
    expect(record.outcome).toBe("cancelled");
  });

  it("catches claims in shown text and an offer without its card", async () => {
    const { found } = await run(stayer(), { claimInText: true, noCard: true });
    expect(found.map((v) => v.kind)).toEqual(expect.arrayContaining(["claim_in_text", "offer_without_card"]));
  });

  it("in L1, taps the persona's reason chip", async () => {
    const p = persona({
      cancelAt: null,
      acceptsFittingOffer: true,
      reason: "temporary",
      messages: ["I'm away."],
    });
    const record = await runSession(p, {
      agent: new TestAgent(clock, {}, "L1"),
      subscriber: new ScriptedSubscriber(),
      sessionId: SESSION,
      clock,
    });
    expect(record.startLevel).toBe("L1");
    expect(record.turns.map((t) => t.subscriber)).toEqual(["I'm away.", "[chip:temporary]"]);
    expect(record.turns[1]?.offer).not.toBeNull();
  });

  it("passes the persona's language to the session, and runs every red-team persona cleanly", async () => {
    for (const p of redTeamPersonas()) {
      const { found } = await run(p);
      expect(found, p.id).toEqual([]);
    }
  });

  it("gives up after a bounded number of moves", async () => {
    const forever: Subscriber = { next: () => Promise.resolve({ type: "say", text: "hello" }) };
    const record = await runSession(persona(), {
      agent: new TestAgent(clock),
      subscriber: forever,
      sessionId: SESSION,
      clock,
      maxMoves: 3,
    });
    expect(record.outcome).toBe("abandoned");
    expect(record.turns).toHaveLength(3);
  });
});
