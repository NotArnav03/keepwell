import { describe, expect, it } from "vitest";
import {
  actionTone,
  summariseOffers,
  formatMoney,
  formatPercent,
  formatRelative,
  humanize,
  kindInfo,
  OFFER_LABELS,
  REASON_LABELS,
  riskTone,
  statusInfo,
} from "./fmt.js";
import { OfferKind, ReasonCategory } from "@keepwell/contracts";

describe("formatting", () => {
  it("formats money as currency, dropping empty cents", () => {
    expect(formatMoney({ value: "16.50", currency: "USD" })).toBe("$16.50");
    expect(formatMoney({ value: "120.00", currency: "USD" })).toBe("$120");
    expect(formatMoney({ value: "0.00", currency: "USD" })).toBe("$0");
  });

  it("falls back to the raw value for something that isn't money", () => {
    expect(formatMoney({ value: "n/a", currency: "USD" })).toBe("n/a USD");
    expect(formatMoney({ value: "5.00", currency: "??" })).toBe("5.00 ??");
  });

  it("formats a rate as a percentage, and a missing rate as a dash", () => {
    expect(formatPercent(0.6667)).toBe("67%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(null)).toBe("–");
  });

  it("says how long ago something happened", () => {
    const now = new Date("2026-11-09T12:00:00.000Z");
    expect(formatRelative("2026-11-09T11:59:40.000Z", now)).toBe("just now");
    expect(formatRelative("2026-11-09T11:55:00.000Z", now)).toBe("5 min ago");
    expect(formatRelative("2026-11-09T09:00:00.000Z", now)).toBe("3 h ago");
    expect(formatRelative("2026-11-07T12:00:00.000Z", now)).toBe("2 d ago");
    expect(formatRelative("not a date", now)).toBe("not a date");
  });
});

describe("labels", () => {
  it("has a plain label for every reason and offer the contracts define", () => {
    for (const reason of ReasonCategory.options) expect(REASON_LABELS[reason]).toBeTruthy();
    for (const offer of OfferKind.options) expect(OFFER_LABELS[offer]).toBeTruthy();
  });

  it("labels subscription statuses, with a tone that never relies on colour alone", () => {
    expect(statusInfo("ACTIVE")).toEqual({ label: "Active", tone: "good" });
    expect(statusInfo("SUSPENDED").label).toBe("Paused");
    expect(statusInfo("SOMETHING_NEW")).toEqual({ label: "Something new", tone: "neutral" });
  });

  it("labels audit and domain events, and makes unknown ones readable", () => {
    expect(kindInfo("session.cancel_requested").label).toBe("Cancel requested");
    expect(kindInfo("subscription.payment_failed").tone).toBe("bad");
    expect(kindInfo("brand.new_thing")).toEqual({ label: "New thing", tone: "neutral" });
  });

  it("humanizes snake and dotted names", () => {
    expect(humanize("low_usage")).toBe("Low usage");
    expect(humanize("a.b-c")).toBe("A b c");
  });

  it("maps risk bands to tones", () => {
    expect(riskTone("high")).toBe("bad");
    expect(riskTone("medium")).toBe("warn");
    expect(riskTone("low")).toBe("good");
  });
});

describe("action states", () => {
  it("reads done, failed, waiting and in-progress states", () => {
    expect(actionTone("CONFIRMED")).toBe("good");
    expect(actionTone("FAILED")).toBe("bad");
    expect(actionTone("AWAITING_BUYER")).toBe("warn");
    expect(actionTone("SUPERSEDED")).toBe("neutral");
    expect(actionTone("EXECUTING")).toBe("info");
  });
});

describe("summariseOffers", () => {
  it("names each kind once and counts the repeats", () => {
    expect(summariseOffers(["pause", "pause", "pause", "downgrade", "discount"])).toBe(
      "Pause ×3 · Cheaper plan · Discount",
    );
    expect(summariseOffers([])).toBe("");
  });
});
