import { describe, expect, it } from "vitest";
import { pantryPlanSubscription } from "@keepwell/contracts/fakes";
import { MerchantApiError } from "../api.js";
import {
  appendDelta,
  chatWire,
  failChat,
  finalizeChat,
  INITIAL_CHAT,
  noteTool,
  noteToolResult,
  prepareUserText,
  sendUser,
  stopChat,
} from "./chat-model.js";
import { InsightsError, isAbortError, panelFailure } from "./errors.js";
import { barWidth, formatPercent, formatUtcDate, moneyLabel, reasonLabel, utcDateRange } from "./format.js";
import { mergeOutbox } from "./outbox-model.js";
import { savedShare, topByCount } from "./overview-model.js";
import { confirmationCopy, orderActions, replaceAction } from "./queue-model.js";
import { riskFactors, riskLevel } from "./risk-model.js";

const now = new Date("2026-11-05T22:30:00Z");

describe("format helpers", () => {
  it("builds an inclusive UTC range and formats the calendar day without a zone shift", () => {
    expect(utcDateRange(30, now)).toEqual({ from: "2026-10-07", to: "2026-11-05" });
    expect(utcDateRange(7, now).from).toBe("2026-10-30");
    expect(formatUtcDate("2026-10-02T00:00:00.000Z")).toBe("2 Oct 2026");
  });

  it("formats percentages and bars from counts, and money only when it is a decimal string", () => {
    expect(formatPercent(1, 3)).toBe("33.3%");
    expect(formatPercent(4, 10)).toBe("40%");
    expect(barWidth(0, 10)).toBe(0);
    expect(barWidth(1, 100)).toBe(1);
    expect(barWidth(10, 10)).toBe(100);
    expect(moneyLabel({ value: "12.00", currency: "USD" })).toBe("12.00 USD");
    expect(moneyLabel({ value: "12", currency: "USD" })).toBeNull();
    expect(reasonLabel("low_usage")).toBe("Low usage");
  });
});

describe("overview model", () => {
  it("derives a saved share from saved and cancelled counts, and leaves other mixes alone", () => {
    expect(
      savedShare([
        { outcome: "saved_pause", count: 1 },
        { outcome: "cancelled", count: 2 },
        { outcome: "winback_reply", count: 9 },
      ]),
    ).toEqual({ saved: 1, compared: 3, percent: "33.3%" });
    expect(savedShare([{ outcome: "winback_reply", count: 4 }])).toBeNull();
    expect(savedShare([{ outcome: "cancelled", count: 2 }])).toEqual({
      saved: 0,
      compared: 2,
      percent: "0%",
    });
  });

  it("picks the first row when counts tie", () => {
    expect(
      topByCount([
        { count: 2, name: "a" },
        { count: 2, name: "b" },
        { count: 1, name: "c" },
      ])?.name,
    ).toBe("a");
  });
});

describe("action queue model", () => {
  it("keeps proposed rows first and replaces a row with the server object", () => {
    const proposed = { id: "a", state: "proposed" };
    const other = { id: "b", state: "approved" };
    expect(orderActions([other, proposed]).map((item) => item.id)).toEqual(["a", "b"]);
    const approved = { id: "a", state: "approved" };
    const next = replaceAction([proposed, { id: "b", state: "proposed" }], approved);
    expect(next.map((item) => item.state)).toEqual(["proposed", "approved"]);
    expect(next[1]).toBe(approved);
    expect(proposed.state).toBe("proposed");
  });

  it("restates plan text from the payload and does not count win-back ids", () => {
    const planParams: Record<string, unknown> = {
      name: "Basics",
      price: { value: "4.00", currency: "USD" },
      interval: { unit: "MONTH", count: 1 },
    };
    const plan = confirmationCopy({
      kind: "create_plan",
      rationale: "Subscribers cite price.",
      params: planParams,
      estimate: null,
    });
    expect(plan).toContain("Subscribers cite price.");
    expect(plan).toContain("4.00 USD");
    expect(plan).toContain("Basics");
    const winbackParams: Record<string, unknown> = {
      reason: "price",
      subscriptionIds: ["0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b"],
    };
    const winback = confirmationCopy({
      kind: "send_winback_batch",
      rationale: "Send the note they asked for.",
      params: winbackParams,
      estimate: null,
    });
    expect(winback).toBe("Send the note they asked for. Price");
    expect(winback).not.toMatch(/\d/);
  });
});

describe("outbox paging", () => {
  it("appends a page without duplicating ids", () => {
    expect(mergeOutbox([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }])).toEqual([
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ]);
  });
});

describe("chat model", () => {
  it("appends deltas, records a tool, and finalizes a flagged reply", () => {
    let state = sendUser(INITIAL_CHAT, "Why are people leaving?");
    state = appendDelta(state, "Price ");
    state = appendDelta(state, "came up.");
    state = noteTool(state, "search_quotes");
    state = noteToolResult(state, "search_quotes", true, false);
    state = finalizeChat(state, true);
    const reply = state.messages.at(-1);
    expect(state.draft).toBeNull();
    expect(reply?.text).toBe("Price came up.");
    expect(reply?.flagged).toBe(true);
    expect(reply?.tools[0]).toMatchObject({ tool: "search_quotes", ok: true, proposed: false });
  });

  it("keeps an error and a stopped draft out of the transcript sent back", () => {
    let failed = appendDelta(sendUser(INITIAL_CHAT, "Hello"), "Partial");
    failed = failChat(failed, { code: "over_budget", message: "Try later" });
    expect(failed.error?.code).toBe("over_budget");
    expect(chatWire(failed.messages)).toEqual([{ role: "user", text: "Hello" }]);
    const stopped = stopChat(appendDelta(sendUser(INITIAL_CHAT, "Hello"), "Wait"));
    expect(stopped.stopped).toBe(true);
    expect(stopped.streaming).toBe(false);
    expect(chatWire(stopped.messages)).toEqual([{ role: "user", text: "Hello" }]);
  });

  it("drops the oldest user/assistant pair once the transcript passes 20 messages", () => {
    let state = INITIAL_CHAT;
    for (let i = 0; i < 10; i += 1) {
      state = finalizeChat(appendDelta(sendUser(state, `q${i}`), `a${i}`), false);
    }
    expect(state.messages).toHaveLength(20);
    state = sendUser(state, "last");
    expect(state.trimmed).toBe(true);
    expect(state.messages.length).toBeLessThanOrEqual(20);
    expect(state.messages.at(-1)?.text).toBe("last");
    expect(state.messages.some((message) => message.text === "q0" || message.text === "a0")).toBe(false);
  });

  it("clips an assistant reply at the 2,000 character wire limit and rejects a long draft", () => {
    const state = finalizeChat(appendDelta(sendUser(INITIAL_CHAT, "Hello"), "x".repeat(2001)), false);
    expect(state.messages.at(-1)?.clipped).toBe(true);
    expect(state.messages.at(-1)?.text).toHaveLength(2001);
    expect(chatWire(state.messages).at(-1)?.text).toHaveLength(2000);
    expect(prepareUserText("  ")).toEqual({ ok: false, reason: "empty" });
    expect(prepareUserText("y".repeat(2001))).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("risk model", () => {
  it("shows the band and only the signals present on the subscription", () => {
    const calm = pantryPlanSubscription(now);
    expect(riskLevel(null)).toBe("Not scored");
    expect(riskLevel({ score: 58, band: "high" })).toBe("high (58/100)");
    expect(riskFactors({ subscription: calm, risk: { score: 58, band: "high" } })).toEqual([]);
    const risky = pantryPlanSubscription(now, {
      failedPaymentsCount: 2,
      outstandingBalance: { value: "12.00", currency: "USD" },
      lastFailure: {
        reasonCode: "INSTRUMENT_DECLINED",
        time: "2026-11-01T00:00:00.000Z",
        nextRetryTime: null,
      },
    });
    expect(riskFactors({ subscription: risky, risk: { score: 58, band: "high" } })).toEqual([
      "2 failed payments",
      "Outstanding 12.00 USD",
      "Last failure INSTRUMENT_DECLINED",
    ]);
  });
});

describe("panel failures", () => {
  it("maps 401 to the envelope message, 404 to unavailable, and leaves aborts alone", () => {
    expect(panelFailure(new MerchantApiError("Sign in required", 401, "unauthorized"))).toEqual({
      kind: "unauthorized",
      message: "Sign in required",
    });
    expect(panelFailure(new InsightsError("Not found", 404, "not_found")).kind).toBe("unavailable");
    expect(panelFailure(new InsightsError("Something went wrong on our side", 500, "internal"))).toEqual({
      kind: "error",
      message: "Something went wrong on our side",
    });
    expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
    expect(isAbortError(new InsightsError("nope", 500, "internal"))).toBe(false);
  });
});
