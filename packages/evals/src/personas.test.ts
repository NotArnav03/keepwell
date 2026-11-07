import { describe, expect, it } from "vitest";
import {
  allPersonas,
  Attack,
  EVAL_LANGUAGES,
  normalPersonas,
  prSubset,
  redTeamPersonas,
  Scenario,
  Temperament,
} from "./personas.js";

describe("personas", () => {
  const normal = normalPersonas();
  const red = redTeamPersonas();

  it("has about 300 normal and about 100 red-team personas, with unique ids", () => {
    expect(normal).toHaveLength(300);
    expect(red.length).toBeGreaterThanOrEqual(100);
    const ids = allPersonas().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is the same on every run", () => {
    expect(normalPersonas()).toEqual(normal);
    expect(redTeamPersonas()).toEqual(red);
  });

  it("covers every reason in every language, every temperament and every scenario", () => {
    const reasons = new Set(normal.map((p) => p.reason));
    for (const reason of reasons) {
      for (const language of EVAL_LANGUAGES) {
        expect(
          normal.some((p) => p.reason === reason && p.language === language),
          `${reason}/${language}`,
        ).toBe(true);
      }
    }
    expect(reasons.size).toBe(8);
    expect(new Set(normal.map((p) => p.temperament))).toEqual(new Set(Temperament.options));
    expect(new Set(normal.map((p) => p.scenario))).toEqual(new Set(Scenario.options));
    expect(new Set(red.map((p) => p.scenario))).toEqual(new Set(Scenario.options));
  });

  it("mixes leavers, takers and vague openers", () => {
    const leavers = normal.filter((p) => p.cancelAt !== null);
    expect(leavers.length / normal.length).toBeGreaterThan(0.25);
    expect(leavers.length / normal.length).toBeLessThan(0.45);
    expect(normal.some((p) => p.acceptsFittingOffer)).toBe(true);
    expect(normal.some((p) => p.honesty === "vague" && p.messages.length === 2)).toBe(true);
    // Someone who asks to cancel never also takes an offer.
    expect(normal.filter((p) => p.cancelAt !== null && p.acceptsFittingOffer)).toEqual([]);
    for (const p of leavers) expect(p.cancelAt).toBe(p.messages.length - 1);
  });

  it("uses every attack, in more than one language, with injection in a name too", () => {
    expect(new Set(red.map((p) => p.attack))).toEqual(new Set(Attack.options));
    expect(new Set(red.map((p) => p.language))).toEqual(new Set(EVAL_LANGUAGES));
    expect(red.some((p) => p.firstName.includes("SYSTEM"))).toBe(true);
  });

  it("samples every attack and language for PR runs", () => {
    const subset = prSubset();
    expect(subset.length).toBeGreaterThan(40);
    expect(subset.length).toBeLessThan(60);
    expect(new Set(subset.filter((p) => p.attack).map((p) => p.attack)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(subset.map((p) => p.language))).toEqual(new Set(EVAL_LANGUAGES));
  });
});
