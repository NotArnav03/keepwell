import { describe, expect, it } from "vitest";
import { CopilotServerEvent, InsightActionView, InsightsResponse } from "./schemas.js";

/** Sample shaped like InsightsResponse.parse in apps/api/src/modules/insights/queries.ts. */
const insights = {
  range: { from: "2026-10-01", to: "2026-10-31" },
  total: 4,
  byWeek: [{ week: "2026-09-28", count: 4 }],
  byPlan: [{ plan: "Pantry Plan", count: 4 }],
  byReason: [
    { reason: "price", count: 3 },
    { reason: "low_usage", count: 1 },
  ],
  byOutcome: [
    { outcome: "saved_pause", count: 1 },
    { outcome: "cancelled", count: 2 },
    { outcome: "winback_reply", count: 1 },
    { outcome: "none", count: 0 },
  ],
  topQuotes: [
    {
      quote: "The weekly box is more than I use.",
      reason: "low_usage",
      sentiment: "negative",
      createdAt: "2026-10-02T00:00:00.000Z",
    },
  ],
};

/** Sample shaped like View.parse in apps/api/src/modules/insights/actions/routes.ts. */
const action = {
  id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
  merchantId: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c",
  kind: "create_plan",
  params: {
    name: "Basics",
    description: null,
    price: { value: "4.00", currency: "USD" },
    interval: { unit: "MONTH", count: 1 },
    basedOnPaypalPlanId: "P-1",
  },
  rationale: "Subscribers cite price.",
  estimate: {
    monthlyRevenueImpact: { value: "12.00", currency: "USD" },
    basis: "4 subscribers at the cited price",
  },
  state: "proposed",
  proposedBy: "copilot",
  actionId: null,
  createdAt: "2026-10-02T00:00:00.000Z",
  decidedAt: null,
  error: null,
  execution: { status: "not_applicable", error: null },
};

describe("insights schemas", () => {
  it("accepts an insights payload and rejects a bad reason", () => {
    expect(InsightsResponse.parse(insights).total).toBe(4);
    expect(
      InsightsResponse.safeParse({ ...insights, byReason: [{ reason: "nope", count: 1 }] }).success,
    ).toBe(false);
  });

  it("accepts an insight action and an ActionError execution, and rejects a bad status", () => {
    expect(InsightActionView.parse(action).state).toBe("proposed");
    expect(
      InsightActionView.parse({
        ...action,
        execution: { status: "failed", error: { code: "PLAN_REJECTED", message: "PayPal refused the plan" } },
      }).execution.status,
    ).toBe("failed");
    expect(
      InsightActionView.safeParse({ ...action, execution: { status: "done", error: null } }).success,
    ).toBe(false);
  });

  it("accepts a copilot delta and rejects one with no text", () => {
    expect(CopilotServerEvent.parse({ type: "delta", text: "Hello" })).toEqual({
      type: "delta",
      text: "Hello",
    });
    expect(CopilotServerEvent.parse({ type: "error", code: "over_budget", message: "Try later" })).toEqual({
      type: "error",
      code: "over_budget",
      message: "Try later",
    });
    expect(CopilotServerEvent.safeParse({ type: "delta" }).success).toBe(false);
  });
});
