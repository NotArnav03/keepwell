import { formatPercent } from "./format.js";

const SAVED_OUTCOMES: ReadonlySet<string> = new Set([
  "saved_pause",
  "saved_downgrade",
  "saved_annual",
  "saved_discount",
  "saved_refund",
]);

export interface SavedShare {
  saved: number;
  compared: number;
  percent: string;
}

/**
 * Share of sessions the API marked saved, over saved + cancelled.
 * Null when that pair of counts is empty, so the UI does not show a made-up 0%.
 */
export function savedShare(rows: readonly { outcome: string; count: number }[]): SavedShare | null {
  let saved = 0;
  let cancelled = 0;
  for (const row of rows) {
    if (SAVED_OUTCOMES.has(row.outcome)) saved += row.count;
    else if (row.outcome === "cancelled") cancelled += row.count;
  }
  const compared = saved + cancelled;
  if (compared === 0) return null;
  return { saved, compared, percent: formatPercent(saved, compared) };
}

/** First row with the highest count. Ties keep the API's order. */
export function topByCount<T extends { count: number }>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (best === null || row.count > best.count) best = row;
  }
  return best;
}
