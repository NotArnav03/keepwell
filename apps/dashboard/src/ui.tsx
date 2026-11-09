import type { ReactNode } from "react";
import type { Tone } from "./fmt.js";

// Small presentational pieces shared by every dashboard page. No data fetching here.

const PATHS: Record<string, string> = {
  overview: "M3 13h4v8H3zM10 3h4v18h-4zM17 9h4v12h-4z",
  subscribers: "M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21c0-3.5 3.6-6 8-6s8 2.5 8 6",
  timeline: "M3 6h12M3 12h18M3 18h8M15 4v4M19 10v4M11 16v4",
  audit: "M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5",
  policies: "M5 4h14v16H5zM9 9h6M9 13h6M9 17h3",
  onboarding: "M12 3v12M7 10l5 5 5-5M4 20h16",
  insights: "M4 19V5M4 19h16M8 15l3-4 3 2 5-7",
  keys: "M14 10a4 4 0 1 0-3.9 4L4 20v-3h3v-3h3l2.1-2.1M17 7h.01",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  logout: "M10 4H5v16h5M15 8l4 4-4 4M19 12H9",
  check: "M5 12.5l4.5 4.5L19 7",
  alert: "M12 4l9 16H3zM12 10v4M12 17h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01",
  cross: "M6 6l12 12M18 6L6 18",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

const TONE_ICON: Record<Tone, IconName> = {
  good: "check",
  warn: "alert",
  bad: "cross",
  info: "info",
  neutral: "pulse",
};

/** A status chip. The icon and the words carry the meaning; the colour only reinforces them. */
export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`chip chip-${tone}`}>
      <Icon name={TONE_ICON[tone]} size={13} />
      {children}
    </span>
  );
}

export function PageHeading({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div className="page-heading-row">
        <div>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      <div className="guilloche" aria-hidden="true" />
      <div className="microprint" aria-hidden="true" />
    </header>
  );
}

/** The Keepwell mark: a check inside a ring, the thing kept. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="16" cy="16" r="13" />
      <circle cx="16" cy="16" r="9.5" strokeWidth="0.8" />
      <path d="M10.5 16.5l3.8 3.8 7.2-8" />
    </svg>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

/** One headline figure with a label and an optional line of context. */
export function StatTile({
  label,
  value,
  hint,
  hero = false,
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  hero?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className={hero ? "tile tile-hero" : "tile"} aria-label={label}>
      <p className="tile-label">{label}</p>
      <p className="tile-value">{value}</p>
      {hint && <p className="tile-hint">{hint}</p>}
      {children}
    </section>
  );
}

/** A ratio against a limit. The fill and the label both say the number. */
export function Meter({ ratio, label }: { ratio: number | null; label: string }) {
  const percent = ratio === null ? 0 : Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div
      className="meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
    >
      <div className="meter-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

export interface BarRow {
  key: string;
  label: string;
  value: number;
}

/**
 * Ranked horizontal bars: one hue, one baseline, the value at the tip. Rows are sorted largest
 * first by the caller. The list reads as a table to a screen reader.
 */
export function RankedBars({ rows, unit, empty }: { rows: BarRow[]; unit: string; empty: string }) {
  if (rows.length === 0) return <EmptyState title={empty} />;
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <ul className="bars">
      {rows.map((row) => (
        <li key={row.key} className="bar-row">
          <span className="bar-label">{row.label}</span>
          <span className="bar-track" aria-hidden="true">
            <span className="bar-fill" style={{ width: `${Math.max((row.value / max) * 100, 2)}%` }} />
          </span>
          <span className="bar-value">
            {row.value}
            <span className="sr-only"> {unit}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface SegmentPart {
  key: string;
  label: string;
  value: number;
  /** "saved" parts are blue steps (one hue, light to dark); "left" is ink grey. */
  kind: "saved" | "left";
}

/**
 * One whole split into parts, widths proportional. The saved outcomes are steps of one blue; the
 * subscribers who left are grey, so the eye reads "kept vs left" first and "which offer" second. A
 * part too narrow to carry its share prints none; the legend names every part with its count.
 */
export function SegmentedBar({ parts, label }: { parts: SegmentPart[]; label: string }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (total === 0) return null;
  const saved = parts.filter((part) => part.kind === "saved");
  const strengthOf = (part: SegmentPart): number =>
    part.kind === "left" ? 100 : 100 - (saved.indexOf(part) * 55) / Math.max(saved.length - 1, 1);
  const shade = (part: SegmentPart): string =>
    part.kind === "left"
      ? "var(--kw-subtle)"
      : `color-mix(in srgb, var(--kw-series1) ${Math.round(strengthOf(part))}%, var(--kw-surface))`;
  return (
    <figure className="seg" aria-label={label}>
      <div className="seg-bar" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
        {parts.map((part) => {
          const share = Math.round((part.value / total) * 100);
          return (
            <span
              key={part.key}
              className={`seg-part seg-${part.kind}`}
              style={{
                flexGrow: part.value,
                background: shade(part),
                // Light steps carry dark ink, dark steps carry light ink.
                color: strengthOf(part) < 72 ? "var(--kw-text)" : "#fff",
              }}
              title={`${part.label}: ${part.value} (${share}%)`}
            >
              {share >= 12 ? `${share}%` : ""}
            </span>
          );
        })}
      </div>
      <figcaption className="seg-legend">
        {parts.map((part) => (
          <span key={part.key} className="seg-key">
            <i style={{ background: shade(part) }} aria-hidden="true" />
            {part.label}
            <b>{part.value}</b>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** A risk score as a thin gauge with the number and the word beside it, so colour is never alone. */
export function RiskStrip({ score, band }: { score: number; band: "low" | "medium" | "high" }) {
  return (
    <span className={`risk risk-${band}`} title={`${band} risk, ${score} out of 100`}>
      <span className="risk-track" aria-hidden="true">
        <span className="risk-fill" style={{ width: `${Math.max(score, 3)}%` }} />
      </span>
      <span className="risk-text">
        {band[0]?.toUpperCase()}
        {band.slice(1)} · {score}
      </span>
    </span>
  );
}
