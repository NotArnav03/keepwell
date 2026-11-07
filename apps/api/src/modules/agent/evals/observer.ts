import type { Observation } from "@keepwell/evals";
import type { AgentLogger } from "../llm.js";
import type { Classification } from "../prompts.js";

// Reads the agent's own log lines to fill in what the subscriber can't see: the classification,
// replies the claims checker sent back, and picks the policy denied.

interface Seen {
  classification: Classification | null;
  claimsCaught: number;
  deniedPicks: number;
}

export class Observer {
  private readonly seen = new Map<string, Seen>();

  /** `inner` gets every line too, so a real run's warnings and errors still reach the console. */
  constructor(private readonly inner: AgentLogger | null = null) {}

  readonly log: AgentLogger = {
    info: (obj: unknown, msg?: string) => {
      this.inner?.info(obj, msg);
      if (msg !== "agent classified") return;
      const { sessionId, classification } = obj as { sessionId: string; classification: Classification };
      this.for(sessionId).classification = classification;
    },
    warn: (obj: unknown, msg?: string) => {
      this.inner?.warn(obj, msg);
      if (msg !== "agent reply rejected") return;
      const { sessionId, pickOk, textOk } = obj as { sessionId: string; pickOk: boolean; textOk: boolean };
      const s = this.for(sessionId);
      if (!textOk) s.claimsCaught++;
      if (!pickOk) s.deniedPicks++;
    },
    error: (obj: unknown, msg?: string) => {
      this.inner?.error(obj, msg);
    },
  };

  observation(sessionId: string, costNanoUsd: number): Observation {
    const s = this.for(sessionId);
    return {
      classification: s.classification
        ? {
            reason: s.classification.reason,
            language: s.classification.language,
            intent: s.classification.intent,
          }
        : null,
      claimsCaught: s.claimsCaught,
      deniedPicks: s.deniedPicks,
      costNanoUsd,
    };
  }

  private for(sessionId: string): Seen {
    let s = this.seen.get(sessionId);
    if (!s) {
      s = { classification: null, claimsCaught: 0, deniedPicks: 0 };
      this.seen.set(sessionId, s);
    }
    return s;
  }
}
