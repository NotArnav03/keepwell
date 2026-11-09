import { describe, expect, it } from "vitest";
import { PolicyDraft, type PolicyContext } from "@keepwell/contracts";
import { PANTRY_PLAN, pantryPlanSubscription } from "@keepwell/contracts/fakes";
import {
  parsePolicyDraft,
  previewPolicyDraft,
  renderPolicyEditor,
  samePolicy,
  setIn,
} from "./policy-editor.js";

const draft = PolicyDraft.parse({
  offers: PANTRY_PLAN.policy.offers,
  eligibility: PANTRY_PLAN.policy.eligibility,
  reasonPreferences: PANTRY_PLAN.policy.reasonPreferences,
  tone: PANTRY_PLAN.policy.tone,
  supportContact: PANTRY_PLAN.policy.supportContact,
});

function context(cancelIntent: boolean): PolicyContext {
  const now = "2026-11-03T12:00:00Z";
  return {
    now,
    channel: "widget",
    reason: "price",
    cancelIntent,
    offersPresentedThisSession: 0,
    subscription: pantryPlanSubscription(new Date(now)),
    history: {
      savesLast365d: 0,
      pausesLast365d: 0,
      lastPauseEndedAt: null,
      refundedLast30d: { value: "0.00", currency: "USD" },
    },
    plans: PANTRY_PLAN.plans,
  };
}

describe("dashboard policy editor", () => {
  it("validates policy JSON with the shared contract", () => {
    expect(parsePolicyDraft(JSON.stringify(draft))).toEqual(draft);
    expect(() => parsePolicyDraft('{"unknown":true}')).toThrow();
    expect(() => parsePolicyDraft("not json")).toThrow();
  });

  it("previews via the shared policy engine and keeps cancel intent offer-free", () => {
    const menus = previewPolicyDraft(draft, [context(false), context(true)]);

    expect(menus[0]?.offers.length).toBeGreaterThan(0);
    expect(menus[1]?.offers).toEqual([]);
  });

  it("escapes JSON in the editor textarea", () => {
    const altered = PolicyDraft.parse({ ...draft, supportContact: "<script>alert(1)</script>" });
    const html = renderPolicyEditor(altered);

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('aria-live="polite"');
  });
});

describe("setIn and samePolicy", () => {
  it("updates one path without touching the original or its siblings", () => {
    const original = { offers: { pause: { maxCycles: 2, cooldownDays: 90 }, discount: { maxCycles: 3 } } };
    const next = setIn(original, ["offers", "discount", "maxCycles"], 6);
    expect(next.offers.discount.maxCycles).toBe(6);
    expect(next.offers.pause).toBe(original.offers.pause);
    expect(original.offers.discount.maxCycles).toBe(3);
  });

  it("keeps the other fields of the same object (the bug it replaces dropped them)", () => {
    const next = setIn(
      { offers: { discount: { enabled: true, maxPercent: 20, maxCycles: 3 } } },
      ["offers", "discount", "maxCycles"],
      4,
    );
    expect(next.offers.discount).toEqual({ enabled: true, maxPercent: 20, maxCycles: 4 });
  });

  it("compares policies regardless of key order", () => {
    expect(samePolicy({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(samePolicy({ a: 1 }, { a: 2 })).toBe(false);
  });
});
