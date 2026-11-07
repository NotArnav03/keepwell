import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { normalPersonas, type Persona, type SessionRecord, type SessionView } from "@keepwell/evals";
import { InMemoryLlmUsageStore } from "../budget.js";
import { LlmError, type LlmClient, type LlmPurpose, type StructuredCall } from "../llm.js";
import { judge, SimulatedSubscriber } from "./roles.js";
import { runEvals } from "./run.js";

const NOW = new Date("2026-11-03T10:00:00.000Z");

/** Answers by purpose, and remembers what it was asked. */
class ByPurpose implements LlmClient {
  readonly calls: { purpose: LlmPurpose; input: string }[] = [];
  constructor(private readonly answers: Partial<Record<LlmPurpose, () => unknown>>) {}
  structured<S extends z.ZodType>(call: StructuredCall<S>): Promise<z.infer<S>> {
    this.calls.push({ purpose: call.purpose, input: call.input });
    const answer = this.answers[call.purpose];
    if (!answer) return Promise.reject(new LlmError("unavailable", `no answer for ${call.purpose}`));
    return Promise.resolve(call.schema.parse(answer()));
  }
}

const vague = normalPersonas().find((p) => p.honesty === "vague" && p.cancelAt === null) as Persona;
const view = (over: Partial<SessionView> = {}): SessionView => ({
  persona: vague,
  turns: [],
  offerOnScreen: null,
  fittingKinds: ["pause"],
  ...over,
});
const turn = {
  messageIndex: 0,
  agentText: "Can I ask why?",
  offer: null,
  cardText: null,
  chips: false,
  fallback: null,
  latencyMs: 5,
};

describe("SimulatedSubscriber", () => {
  it("sends the scripted first message, then lets the model word the next one", async () => {
    const llm = new ByPurpose({ simulate: () => ({ message: "Honestly it's the price." }) });
    const sim = new SimulatedSubscriber(llm);
    expect(await sim.next(view())).toEqual({ type: "say", text: vague.messages[0] });
    expect(llm.calls).toHaveLength(0);

    const second = await sim.next(view({ turns: [{ ...turn, subscriber: vague.messages[0] as string }] }));
    expect(second).toEqual({ type: "say", text: "Honestly it's the price." });
    expect(llm.calls[0]?.purpose).toBe("simulate");
    expect(llm.calls[0]?.input).toContain(vague.brief);
    expect(llm.calls[0]?.input).toContain(vague.messages[1]);
  });

  it("never asks the model to decide: clicks stay scripted", async () => {
    const llm = new ByPurpose({});
    const sim = new SimulatedSubscriber(llm);
    const offer = { id: "o1", kind: "pause", cycles: 1, resumesOn: NOW.toISOString() } as const;
    const move = await sim.next(view({ turns: [{ ...turn, subscriber: "x", offer }], offerOnScreen: offer }));
    expect(["accept", "cancel"]).toContain(move.type);
    expect(llm.calls).toHaveLength(0);
  });
});

describe("judge", () => {
  const record = (turns: SessionRecord["turns"]): SessionRecord => ({
    personaId: vague.id,
    sessionId: "s",
    startLevel: "L0",
    turns,
    outcome: "cancelled",
    observation: null,
    judgement: null,
  });

  it("maps the verdict and checks the language against the persona's", async () => {
    const verdict = {
      darkPatternScore: 1,
      replyLanguage: `${vague.language}-XX`,
      inventedFeature: false,
      notes: "Fine.",
    };
    const llm = new ByPurpose({ judge: () => verdict });
    const j = await judge(llm, vague, record([{ ...turn, subscriber: "hi" }]));
    expect(j).toEqual({ darkPatternScore: 1, languageMatches: true, inventedFeature: false, notes: "Fine." });
    expect(llm.calls[0]?.input).toContain("Can I ask why?");
  });

  it("skips an empty session", async () => {
    expect(await judge(new ByPurpose({}), vague, record([]))).toBeNull();
  });
});

describe("runEvals in real mode, with a stand-in model", () => {
  const classify = () => ({ reason: "price", intent: "explaining", language: "en", flags: [] });
  const converse = () => ({
    action: "no_offer",
    offerId: null,
    message: "Thanks for telling me. Cancel is below.",
  });

  it("judges every session and fills in the judge's metrics", async () => {
    const llm = new ByPurpose({
      classify,
      converse,
      simulate: () => ({ message: "It's the price." }),
      judge: () => ({
        darkPatternScore: 0,
        replyLanguage: "en",
        inventedFeature: false,
        notes: "Respectful.",
      }),
    });
    const personas = normalPersonas(6);
    const r = await runEvals({
      mode: "real",
      personas,
      now: NOW,
      real: { llm, usage: new InMemoryLlmUsageStore() },
    });
    expect(r.mode).toBe("real");
    expect(r.metrics.darkPatternScore).toBe(0);
    expect(r.metrics.languageMatch).not.toBeNull();
    expect(r.metrics.costPerSessionUsd).toBe(0);
    expect(llm.calls.filter((c) => c.purpose === "judge")).toHaveLength(6);
  });

  it("leaves a session unjudged when the judge is unavailable", async () => {
    const llm = new ByPurpose({ classify, converse, simulate: () => ({ message: "Hm." }) });
    const r = await runEvals({
      mode: "real",
      personas: normalPersonas(3),
      now: NOW,
      real: { llm, usage: new InMemoryLlmUsageStore() },
    });
    expect(r.metrics.darkPatternScore).toBeNull();
    expect(r.gates.passed).toBe(true);
  });
});
