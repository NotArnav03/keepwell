import type { MerchantTimelineResponse } from "@keepwell/contracts";
import { kindInfo, type Tone } from "./fmt.js";

// Pure layout for the subscriber timeline: where each mark goes. The chart component only draws it.

export type TimelineEvent = MerchantTimelineResponse["events"][number];

export interface Mark {
  event: TimelineEvent;
  tone: Tone;
  label: string;
  x: number;
  y: number;
}

export interface Lane {
  resourceId: string;
  name: string;
  subscriptionId: string;
  y: number;
  marks: Mark[];
}

export interface Tick {
  x: number;
  label: string;
}

export interface TimelineLayout {
  from: number;
  to: number;
  width: number;
  height: number;
  lanes: Lane[];
  ticks: Tick[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TICK_STEPS = [
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
];

/** Marks closer than this on one lane are nudged apart so none hides another. */
export const MIN_MARK_GAP = 14;

export const LANE_HEIGHT = 40;
export const AXIS_HEIGHT = 34;
export const LABEL_WIDTH = 150;

function tickLabel(time: number, step: number): string {
  const date = new Date(time);
  if (step >= DAY) return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function layoutTimeline(
  data: MerchantTimelineResponse,
  options: { width: number; laneHeight?: number } = { width: 900 },
): TimelineLayout {
  const laneHeight = options.laneHeight ?? LANE_HEIGHT;
  const plotLeft = LABEL_WIDTH;
  const plotWidth = Math.max(options.width - plotLeft - 24, 200);

  const times = data.events.map((event) => new Date(event.startDate).getTime()).filter(Number.isFinite);
  const earliest = times.length ? Math.min(...times) : Date.now() - DAY;
  const latest = times.length ? Math.max(...times) : Date.now();
  // Pad the range, and never let it collapse to nothing: a chart of one instant says nothing.
  const span = Math.max(latest - earliest, 2 * HOUR);
  const pad = span * 0.04;
  const from = earliest - pad;
  const to = from + span + pad * 2;
  const xOf = (time: number): number => plotLeft + ((time - from) / (to - from)) * plotWidth;

  const step = TICK_STEPS.find((candidate) => (to - from) / candidate <= 9) ?? 90 * DAY;
  const ticks: Tick[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    ticks.push({ x: xOf(t), label: tickLabel(t, step) });
  }

  // Busiest subscribers first, then by name, so the lanes people care about are at the top.
  const counts = new Map<string, number>();
  for (const event of data.events) counts.set(event.resourceId, (counts.get(event.resourceId) ?? 0) + 1);
  const resources = [...data.resources].sort(
    (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.name.localeCompare(b.name),
  );

  const lanes: Lane[] = resources.map((resource, index) => {
    const y = AXIS_HEIGHT + index * laneHeight;
    const own = data.events
      .filter((event) => event.resourceId === resource.id)
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || (a.auditSeq ?? 0) - (b.auditSeq ?? 0));
    let lastX = -Infinity;
    const marks: Mark[] = own.map((event) => {
      let x = xOf(new Date(event.startDate).getTime());
      if (x - lastX < MIN_MARK_GAP) x = lastX + MIN_MARK_GAP;
      lastX = x;
      const info = kindInfo(event.kind);
      return { event, tone: info.tone, label: info.label, x, y: y + laneHeight / 2 };
    });
    return {
      resourceId: resource.id,
      name: resource.name,
      subscriptionId: resource.subscriptionId,
      y,
      marks,
    };
  });

  const rightmost = Math.max(
    plotLeft + plotWidth,
    ...lanes.flatMap((lane) => lane.marks.map((m) => m.x + 12)),
  );
  return {
    from,
    to,
    width: rightmost + 24,
    height: AXIS_HEIGHT + Math.max(lanes.length, 1) * laneHeight + 8,
    lanes,
    ticks,
  };
}
