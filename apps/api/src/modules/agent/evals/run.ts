import { FakeAudit, FakeDomainEvents } from "@keepwell/contracts/fakes";
import {
  runSession,
  ScriptedSubscriber,
  summarise,
  type EvalMode,
  type EvalResults,
  type Persona,
  type SessionRecord,
  type Subscriber,
} from "@keepwell/evals";
import type { InMemoryLlmUsageStore } from "../budget.js";
import { checkClaims } from "../claims.js";
import { LlmError, MODEL_FOR, type AgentLogger, type LlmClient } from "../llm.js";
import { PROMPT_VERSION } from "../prompts.js";
import { AgentRuntime } from "../runtime.js";
import { AdversaryLlm } from "./adversary.js";
import { Observer } from "./observer.js";
import { judge, SimulatedSubscriber } from "./roles.js";

// Runs personas through the real AgentRuntime. In "adversarial" mode the model is AdversaryLlm and
// nothing leaves the process; in "real" mode one client serves the agent, the simulated
// subscriber and the judge, behind the budget guard.

export interface RunEvalsOptions {
  mode: EvalMode;
  personas: Persona[];
  /** The clock the sessions see. Fixed in tests, so menus and results are reproducible. */
  now: Date;
  /** Real mode only: the budget-guarded client and the usage it records. */
  real?: { llm: LlmClient; usage: InMemoryLlmUsageStore };
  log?: AgentLogger;
  /** Called after each session, for progress output. */
  onSession?: (done: number, total: number, record: SessionRecord) => void;
}

/** Deterministic session ids, so two runs of the same personas line up. */
export function sessionIdFor(index: number): string {
  return `0199e7a1-0000-7000-8000-${String(index + 1).padStart(12, "0")}`;
}

export async function runEvals(options: RunEvalsOptions): Promise<EvalResults> {
  const { mode, personas, now } = options;
  const clock = () => now;
  const observer = new Observer(options.log ?? null);
  const byId = new Map(personas.map((p, i) => [sessionIdFor(i), p]));
  const personaFor = (sessionId: string): Persona => {
    const p = byId.get(sessionId);
    if (!p) throw new Error(`no persona for session ${sessionId}`);
    return p;
  };

  let llm: LlmClient;
  let subscriber: Subscriber;
  if (mode === "real") {
    if (!options.real) throw new Error("a real run needs a model client");
    llm = options.real.llm;
    subscriber = new SimulatedSubscriber(llm);
  } else {
    llm = new AdversaryLlm(personaFor);
    subscriber = new ScriptedSubscriber();
  }
  const agent = new AgentRuntime({
    llm,
    events: new FakeDomainEvents(clock),
    audit: new FakeAudit(clock),
    log: observer.log,
    clock,
  });

  const runs: { persona: Persona; record: SessionRecord }[] = [];
  for (const [i, persona] of personas.entries()) {
    const sessionId = sessionIdFor(i);
    const record = await runSession(persona, { agent, subscriber, sessionId, clock });
    const cost = options.real
      ? options.real.usage.entries
          .filter((e) => e.sessionId === sessionId)
          .reduce((sum, e) => sum + e.costNanoUsd, 0)
      : 0;
    record.observation = observer.observation(sessionId, cost);
    if (mode === "real") record.judgement = await judgeOrSkip(llm, persona, record, options.log);
    runs.push({ persona, record });
    options.onSession?.(i + 1, personas.length, record);
  }

  return summarise({
    mode,
    runAt: new Date(),
    sessionNow: now,
    promptVersion: PROMPT_VERSION,
    models:
      mode === "real"
        ? { ...MODEL_FOR }
        : { classify: "adversary (honest)", converse: "adversary (jailbroken)" },
    textCheck: (text, offer) => checkClaims(text, offer).map((v) => `${v.kind}: ${v.match}`),
    runs,
  });
}

/** A judge that's unavailable shouldn't sink the run; that session just goes unjudged. */
async function judgeOrSkip(llm: LlmClient, persona: Persona, record: SessionRecord, log?: AgentLogger) {
  try {
    return await judge(llm, persona, record);
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    log?.warn({ personaId: persona.id, failure: err.failure }, "judge unavailable; session left unjudged");
    return null;
  }
}
