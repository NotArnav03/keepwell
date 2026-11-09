import { useMemo, useState } from "react";
import type { MerchantTimelineResponse } from "@keepwell/contracts";
import { formatDateTime, type Tone } from "./fmt.js";
import { AXIS_HEIGHT, LABEL_WIDTH, LANE_HEIGHT, layoutTimeline, type Mark } from "./timeline-layout.js";
import { EmptyState } from "./ui.js";

// One lane per subscriber, time left to right, a mark per recorded event. Shape and colour both say
// what kind of event it is, so colour is never the only channel. Click or focus a mark for its
// details and the audit entry behind it.

const SHAPES: Record<Tone, (x: number, y: number) => string> = {
  good: (x, y) => `M${x - 5},${y}a5,5 0 1,0 10,0a5,5 0 1,0 -10,0`,
  bad: (x, y) => `M${x - 5},${y - 5}h10v10h-10z`,
  warn: (x, y) => `M${x},${y - 6}l6,11h-12z`,
  info: (x, y) => `M${x},${y - 6}l6,6l-6,6l-6,-6z`,
  neutral: (x, y) => `M${x - 3},${y}a3,3 0 1,0 6,0a3,3 0 1,0 -6,0`,
};

const TONE_MEANING: Record<Tone, string> = {
  good: "Kept or paid",
  info: "Offer or change",
  warn: "Declined or held back",
  bad: "Cancelled or failed",
  neutral: "Housekeeping",
};

const ORDER: Tone[] = ["good", "info", "warn", "bad", "neutral"];

export function TimelineChart({ data }: { data: MerchantTimelineResponse }) {
  const layout = useMemo(() => layoutTimeline(data, { width: 980 }), [data]);
  const [selected, setSelected] = useState<Mark | null>(null);
  if (layout.lanes.length === 0) {
    return (
      <EmptyState title="No events in this range">
        Conversations, offers and payments appear here as they are recorded.
      </EmptyState>
    );
  }
  return (
    <div>
      <ul className="tl-legend" aria-label="Legend">
        {ORDER.map((tone) => (
          <li key={tone}>
            <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
              <path className={`tl-${tone}`} d={SHAPES[tone](0, 0)} />
            </svg>
            {TONE_MEANING[tone]}
          </li>
        ))}
      </ul>
      <div className="tl">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
          height={layout.height}
          role="group"
          aria-label="Subscriber timeline"
        >
          {layout.ticks.map((tick) => (
            <g key={tick.x}>
              <line className="tl-grid" x1={tick.x} x2={tick.x} y1={AXIS_HEIGHT - 6} y2={layout.height} />
              <text className="tl-text" x={tick.x} y={AXIS_HEIGHT - 12} textAnchor="middle">
                {tick.label}
              </text>
            </g>
          ))}
          <line
            className="tl-axis"
            x1={LABEL_WIDTH}
            x2={layout.width - 24}
            y1={AXIS_HEIGHT - 6}
            y2={AXIS_HEIGHT - 6}
          />
          {layout.lanes.map((lane) => (
            <g key={lane.resourceId} className="tl-row">
              <rect className="tl-lane" x="0" y={lane.y} width={layout.width} height={LANE_HEIGHT} />
              <text className="tl-name" x="4" y={lane.y + LANE_HEIGHT / 2 + 5}>
                <a href={`#subscribers/${encodeURIComponent(lane.subscriptionId)}`}>{lane.name}</a>
              </text>
              <line
                className="tl-track"
                x1={LABEL_WIDTH}
                x2={layout.width - 24}
                y1={lane.y + LANE_HEIGHT / 2}
                y2={lane.y + LANE_HEIGHT / 2}
              />
              {lane.marks.map((mark) => (
                <path
                  key={mark.event.id}
                  className={`tl-mark tl-${mark.tone}`}
                  d={SHAPES[mark.tone](mark.x, mark.y)}
                  tabIndex={0}
                  role="button"
                  aria-label={`${lane.name}: ${mark.label}, ${formatDateTime(mark.event.startDate)}`}
                  aria-pressed={selected?.event.id === mark.event.id}
                  onClick={() => setSelected(mark)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelected(mark);
                    }
                  }}
                >
                  <title>{`${mark.label} · ${formatDateTime(mark.event.startDate)}`}</title>
                </path>
              ))}
            </g>
          ))}
        </svg>
      </div>
      {selected ? (
        <div className="tl-detail" role="status">
          <p>
            <strong>{selected.label}</strong> · {formatDateTime(selected.event.startDate)}
            {selected.event.simulated && <span className="badge">SIMULATED</span>}
          </p>
          <p className="muted">
            <code>{selected.event.kind}</code> · <code>{selected.event.paypalSubscriptionId}</code>
            {selected.event.auditSeq !== null && (
              <>
                {" "}
                · <a href={`#audit?seq=${selected.event.auditSeq}`}>Audit entry #{selected.event.auditSeq}</a>
              </>
            )}
          </p>
        </div>
      ) : (
        <p className="muted">Select a mark to see what happened and the audit entry behind it.</p>
      )}
    </div>
  );
}
