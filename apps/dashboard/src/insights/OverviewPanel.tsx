import { useEffect, useState } from "react";
import type { InsightsClient } from "./client.js";
import { barWidth, formatUtcDate, maxCount, outcomeLabel, reasonLabel, utcDateRange } from "./format.js";
import { savedShare, topByCount } from "./overview-model.js";
import type { InsightsResponse } from "./schemas.js";
import { PanelEmpty, PanelLoading, PanelNotice } from "./status.js";
import { usePanelQuery } from "./usePanelQuery.js";

const PRESETS = [7, 30, 90] as const;

export function OverviewPanel({ client }: { client: InsightsClient }) {
  const [range, setRange] = useState(() => utcDateRange(30));
  const [preset, setPreset] = useState<7 | 30 | 90 | "custom">(30);
  const [draftFrom, setDraftFrom] = useState(range.from);
  const [draftTo, setDraftTo] = useState(range.to);
  const [formError, setFormError] = useState("");
  const [reload, setReload] = useState(0);
  const query = usePanelQuery(`${range.from}|${range.to}|${reload}`, (signal) =>
    client.insights(range, signal),
  );

  useEffect(() => {
    setDraftFrom(range.from);
    setDraftTo(range.to);
  }, [range.from, range.to]);

  function applyPreset(days: 7 | 30 | 90) {
    setPreset(days);
    setFormError("");
    setRange(utcDateRange(days));
  }

  function applyCustom() {
    if (!draftFrom || !draftTo) {
      setFormError("Choose both dates.");
      return;
    }
    if (draftFrom > draftTo) {
      setFormError("The start date must be on or before the end date.");
      return;
    }
    setFormError("");
    setPreset("custom");
    setRange({ from: draftFrom, to: draftTo });
  }

  return (
    <section aria-busy={query.status === "loading"}>
      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault();
          applyCustom();
        }}
      >
        <fieldset className="ins-tabs">
          <legend>Date range</legend>
          {PRESETS.map((days) => (
            <button
              key={days}
              type="button"
              className={preset === days ? undefined : "secondary"}
              aria-pressed={preset === days}
              onClick={() => applyPreset(days)}
            >
              Last {days} days
            </button>
          ))}
        </fieldset>
        <label>
          From
          <input
            type="date"
            value={draftFrom}
            onChange={(event) => setDraftFrom(event.currentTarget.value)}
          />
        </label>
        <label>
          To
          <input type="date" value={draftTo} onChange={(event) => setDraftTo(event.currentTarget.value)} />
        </label>
        <button type="submit">Apply dates</button>
      </form>
      {formError && (
        <p className="notice notice-error" role="alert">
          {formError}
        </p>
      )}
      {query.status === "loading" && <PanelLoading label="Loading insights…" />}
      {query.status === "failed" && (
        <>
          <PanelNotice failure={query.failure} />
          <button type="button" className="secondary" onClick={() => setReload((n) => n + 1)}>
            Try again
          </button>
        </>
      )}
      {query.status === "ready" && <OverviewBody data={query.data} />}
    </section>
  );
}

function OverviewBody({ data }: { data: InsightsResponse }) {
  const topReason = topByCount(data.byReason);
  const topPlan = topByCount(data.byPlan);
  const share = savedShare(data.byOutcome);
  const empty = data.total === 0 && data.topQuotes.length === 0;
  return (
    <>
      <p role="status" aria-live="polite">
        {data.total} insights from {formatUtcDate(data.range.from)} to {formatUtcDate(data.range.to)}.
      </p>
      {empty && <PanelEmpty message="No insights in this range." />}
      <div className="kpi-grid">
        <Metric title="Total insights" value={String(data.total)} />
        <Metric
          title="Top reason"
          value={topReason ? `${reasonLabel(topReason.reason)} (${topReason.count})` : "None"}
        />
        <Metric title="Top plan" value={topPlan ? `${topPlan.plan} (${topPlan.count})` : "None"} />
        <Metric
          title="Saved share"
          value={share ? `${share.percent} (${share.saved} of ${share.compared})` : "Not enough outcome data"}
        />
      </div>
      <div className="two-column">
        <section className="panel">
          <h2>By week</h2>
          <CountTable
            caption="Insights by week"
            rows={data.byWeek.map((row) => ({ key: formatUtcDate(row.week), count: row.count }))}
          />
        </section>
        <section className="panel">
          <h2>By reason</h2>
          <CountTable
            caption="Insights by reason"
            rows={data.byReason.map((row) => ({ key: reasonLabel(row.reason), count: row.count }))}
          />
        </section>
        <section className="panel">
          <h2>By plan</h2>
          <CountTable
            caption="Insights by plan"
            rows={data.byPlan.map((row) => ({ key: row.plan, count: row.count }))}
          />
        </section>
        <section className="panel">
          <h2>By outcome</h2>
          <CountTable
            caption="Insights by outcome"
            rows={data.byOutcome.map((row) => ({ key: outcomeLabel(row.outcome), count: row.count }))}
          />
        </section>
      </div>
      <section className="panel">
        <h2>Quotes</h2>
        {data.topQuotes.length === 0 ? (
          <PanelEmpty message="No quotes in this range." />
        ) : (
          <ul className="audit-list">
            {data.topQuotes.map((quote) => (
              <li key={`${quote.createdAt}-${quote.quote}`}>
                <p className="ins-plain">{quote.quote}</p>
                <p className="muted">
                  {reasonLabel(quote.reason)} · {quote.sentiment ?? "No sentiment"} ·{" "}
                  <time dateTime={quote.createdAt}>{formatUtcDate(quote.createdAt)}</time>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <section className="panel metric">
      <h2>{title}</h2>
      <p>{value}</p>
    </section>
  );
}

function CountTable({ rows, caption }: { rows: { key: string; count: number }[]; caption: string }) {
  if (rows.length === 0) return <PanelEmpty message="None in this range." />;
  const max = maxCount(rows);
  return (
    <div className="table-wrap">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th>Name</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.key}-${index}`}>
              <th scope="row">{row.key}</th>
              <td>
                {row.count}
                <svg aria-hidden="true" width="120" height="8" viewBox="0 0 100 8">
                  <rect width="100" height="8" fill="var(--kw-border)" />
                  <rect width={barWidth(row.count, max)} height="8" fill="var(--kw-primary)" />
                </svg>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
