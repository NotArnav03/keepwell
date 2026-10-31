import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { TextCheck } from "./checks.js";
import { runSession, ScriptedSubscriber } from "./harness.js";
import { EvalResults, percentile, summarise } from "./metrics.js";
import { normalPersonas, redTeamPersonas, type Persona } from "./personas.js";
import { loadResults, resultsUrl } from "./results.js";
import { TestAgent, type Misbehaviour } from "./testing/test-agent.js";

const NOW = new Date("2026-11-03T10:00:00.000Z");
const clock = () => NOW;
const textCheck: TextCheck = (text) => [...text.matchAll(/[\d$%]/g)].map((m) => m[0]);

async function results(personas: Persona[], misbehave: Misbehaviour = {}) {
  const runs = [];
  let n = 0;
  for (const persona of personas) {
    const sessionId = `0199a1b2-c3d4-7e5f-8a6b-${String(++n).padStart(12, "0")}`;
    const record = await runSession(persona, {
      agent: new TestAgent(clock, misbehave),
      subscriber: new ScriptedSubscriber(),
      sessionId,
      clock,
    });
    record.observation = {
      classification: { reason: persona.reason, language: persona.language, intent: "explaining" },
      claimsCaught: 1,
      deniedPicks: 0,
      costNanoUsd: 2_000_000,
    };
    runs.push({ persona, record });
  }
  return summarise({
    mode: "adversarial",
    runAt: NOW,
    sessionNow: NOW,
    promptVersion: 1,
    models: { converse: "adversary" },
    textCheck,
    runs,
  });
}

const sample = [...normalPersonas(40), ...redTeamPersonas(13)];

describe("summarise", () => {
  it("passes the gates for a well-behaved agent and fills in every metric it can", async () => {
    const r = await results(sample);
    expect(EvalResults.parse(r)).toEqual(r);
    expect(r.gates).toEqual({ passed: true, policyViolations: 0, maxClicksToCancel: 1 });
    expect(r.personas).toEqual({ normal: 40, redTeam: 13 });
    expect(r.metrics.noMeansNo).toBe(1);
    expect(r.metrics.classificationAccuracy).toBe(1);
    expect(r.metrics.claimsCaught).toBe(53);
    expect(r.metrics.costPerSessionUsd).toBe(0.002);
    expect(r.metrics.darkPatternScore).toBeNull(); // no judge in this run
    expect(r.redTeam.map((a) => a.attack)).toHaveLength(12);
    expect(r.examples.length).toBeGreaterThanOrEqual(3);
  });

  it("fails the gates when the agent breaks a rule", async () => {
    const r = await results(sample, { ignoreCancel: true });
    expect(r.gates.passed).toBe(false);
    expect(r.gates.maxClicksToCancel).toBe(2);
    expect(r.metrics.violationsByKind.offer_after_cancel).toBeGreaterThan(0);
    expect(r.metrics.noMeansNo).toBeLessThan(1);
  });
});

describe("percentile", () => {
  it("uses the nearest rank", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([10, 1, 5], 50)).toBe(5);
  });
});

describe("loadResults", () => {
  it("returns null when no run is committed, and parses one that is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-"));
    const file = pathToFileURL(join(dir, "latest.json"));
    expect(await loadResults(file)).toBeNull();
    const r = await results(normalPersonas(5));
    await writeFile(file, JSON.stringify(r));
    expect(await loadResults(file)).toEqual(r);
    await writeFile(file, JSON.stringify({ ...r, mode: "nonsense" }));
    await expect(loadResults(file)).rejects.toThrow();
  });

  it("keeps one file per mode", () => {
    expect(resultsUrl("real").pathname).toMatch(/\/results\/real\.json$/);
    expect(resultsUrl("adversarial").pathname).toMatch(/\/results\/adversarial\.json$/);
  });
});
