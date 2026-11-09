import { describe, expect, it } from "vitest";
import type { MerchantTimelineResponse } from "@keepwell/contracts";
import { layoutTimeline, MIN_MARK_GAP } from "./timeline-layout.js";

const A = "0199a1b2-0000-7000-8000-00000000000a";
const B = "0199a1b2-0000-7000-8000-00000000000b";

const event = (
  id: string,
  resourceId: string,
  startDate: string,
  kind: string,
  auditSeq: number | null = 1,
): MerchantTimelineResponse["events"][number] => ({
  id,
  resourceId,
  startDate,
  endDate: null,
  name: kind,
  kind,
  auditSeq,
  paypalSubscriptionId: "I-TEST",
  simulated: false,
});

const data = (events: MerchantTimelineResponse["events"]): MerchantTimelineResponse => ({
  resources: [
    { id: A, name: "Maya", subscriptionId: A },
    { id: B, name: "Raj", subscriptionId: B },
  ],
  events,
});

describe("layoutTimeline", () => {
  it("puts events in time order along each subscriber's lane, left to right", () => {
    const layout = layoutTimeline(
      data([
        event("2", A, "2026-11-02T10:00:00.000Z", "offer.accepted", 2),
        event("1", A, "2026-11-01T10:00:00.000Z", "offer.presented", 1),
        event("3", A, "2026-11-05T10:00:00.000Z", "session.closed", 3),
      ]),
      { width: 1000 },
    );
    const lane = layout.lanes.find((l) => l.resourceId === A);
    expect(lane?.marks.map((m) => m.event.id)).toEqual(["1", "2", "3"]);
    const xs = lane?.marks.map((m) => m.x) ?? [];
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it("orders lanes busiest first, then by name", () => {
    const layout = layoutTimeline(
      data([
        event("1", B, "2026-11-01T10:00:00.000Z", "offer.presented"),
        event("2", B, "2026-11-01T11:00:00.000Z", "offer.accepted"),
        event("3", A, "2026-11-01T12:00:00.000Z", "offer.presented"),
      ]),
    );
    expect(layout.lanes.map((l) => l.name)).toEqual(["Raj", "Maya"]);
  });

  it("keeps marks that happen at the same moment from hiding each other", () => {
    const same = "2026-11-01T10:00:00.000Z";
    const layout = layoutTimeline(
      data([
        event("1", A, same, "offer.presented", 1),
        event("2", A, same, "offer.accepted", 2),
        event("3", A, same, "session.closed", 3),
      ]),
    );
    const xs = layout.lanes[0]?.marks.map((m) => m.x) ?? [];
    expect(xs).toHaveLength(3);
    for (let i = 1; i < xs.length; i++)
      expect((xs[i] ?? 0) - (xs[i - 1] ?? 0)).toBeGreaterThanOrEqual(MIN_MARK_GAP);
  });

  it("gives every mark a tone and a plain label, and the plot room for nudged marks", () => {
    const layout = layoutTimeline(
      data([event("1", A, "2026-11-01T10:00:00.000Z", "subscription.payment_failed")]),
    );
    expect(layout.lanes[0]?.marks[0]).toMatchObject({ tone: "bad", label: "Payment failed" });
    expect(layout.width).toBeGreaterThan(layout.lanes[0]?.marks[0]?.x ?? 0);
  });

  it("never collapses a short history to a point: the range is at least two hours", () => {
    const layout = layoutTimeline(data([event("1", A, "2026-11-01T10:00:00.000Z", "offer.presented")]));
    expect(layout.to - layout.from).toBeGreaterThanOrEqual(2 * 3600_000);
    expect(layout.ticks.length).toBeGreaterThan(1);
  });

  it("handles no events at all", () => {
    const layout = layoutTimeline({ resources: [], events: [] });
    expect(layout.lanes).toEqual([]);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("uses days on the axis for a long history", () => {
    const layout = layoutTimeline(
      data([
        event("1", A, "2026-08-01T10:00:00.000Z", "offer.presented"),
        event("2", A, "2026-11-01T10:00:00.000Z", "offer.accepted"),
      ]),
    );
    expect(layout.ticks.length).toBeLessThanOrEqual(10);
    expect(layout.ticks[0]?.label).toMatch(/\d/);
  });
});
