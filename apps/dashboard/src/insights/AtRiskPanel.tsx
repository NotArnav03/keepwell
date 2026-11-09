import { useEffect, useState } from "react";
import type { MerchantSubscriptionListResponse } from "@keepwell/contracts";
import type { MerchantApi } from "../api.js";
import { isAbortError, panelFailure, type PanelFailure } from "./errors.js";
import { riskFactors, riskLevel } from "./risk-model.js";
import { PanelEmpty, PanelLoading, PanelNotice } from "./status.js";

type Band = "" | "low" | "medium" | "high";

function asBand(value: string): Band {
  if (value === "low" || value === "medium" || value === "high" || value === "") return value;
  return "high";
}

export function AtRiskPanel({ api }: { api: MerchantApi }) {
  const [band, setBand] = useState<Band>("high");
  const [cursor, setCursor] = useState<string | undefined>();
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState<MerchantSubscriptionListResponse | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [failure, setFailure] = useState<PanelFailure | null>(null);

  useEffect(() => {
    let active = true;
    setPhase("loading");
    setFailure(null);
    api
      .listSubscriptions({
        ...(band ? { risk: band } : {}),
        ...(cursor ? { cursor } : {}),
      })
      .then((result) => {
        if (!active) return;
        setPage(result);
        setPhase("ready");
      })
      .catch((cause: unknown) => {
        if (!active || isAbortError(cause)) return;
        setFailure(panelFailure(cause));
        setPhase("failed");
      });
    return () => {
      active = false;
    };
  }, [api, band, cursor, reload]);

  return (
    <section aria-busy={phase === "loading"}>
      <h2>At-risk subscribers</h2>
      <form className="filter-bar" onSubmit={(event) => event.preventDefault()}>
        <label>
          Risk band
          <select
            value={band}
            onChange={(event) => {
              setCursor(undefined);
              setBand(asBand(event.currentTarget.value));
            }}
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
            <option value="">Any band</option>
          </select>
        </label>
      </form>
      {phase === "loading" && <PanelLoading label="Loading at-risk subscribers…" />}
      {phase === "failed" && failure && (
        <>
          <PanelNotice failure={failure} />
          <button type="button" className="secondary" onClick={() => setReload((n) => n + 1)}>
            Try again
          </button>
        </>
      )}
      {phase === "ready" && page && (
        <>
          <p role="status" aria-live="polite">
            {page.subscriptions.length === 0
              ? "No subscribers in this risk band."
              : "At-risk subscribers loaded."}
          </p>
          {page.subscriptions.length === 0 ? (
            <PanelEmpty message="No subscribers in this risk band." />
          ) : (
            <div className="table-wrap">
              <table>
                <caption>Subscribers by the risk band from the subscribers API</caption>
                <thead>
                  <tr>
                    <th>Subscriber</th>
                    <th>Plan</th>
                    <th>Status</th>
                    <th>Risk</th>
                    <th>Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {page.subscriptions.map(({ subscription, risk }) => {
                    const factors = riskFactors({ subscription, risk });
                    return (
                      <tr key={subscription.id}>
                        <td>
                          <a href={`#subscribers/${encodeURIComponent(subscription.id)}`}>
                            {subscription.subscriberFirstName ?? "Subscriber"}
                          </a>
                        </td>
                        <td>{subscription.planName}</td>
                        <td>{subscription.status}</td>
                        <td>{riskLevel(risk)}</td>
                        <td>
                          {factors.length === 0 ? (
                            "No extra signals on this subscription."
                          ) : (
                            <ul>
                              {factors.map((factor, index) => (
                                <li key={`${factor}-${index}`}>{factor}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="button-row">
            {page.nextCursor && (
              <button
                type="button"
                className="secondary"
                onClick={() => setCursor(page.nextCursor ?? undefined)}
              >
                Next page
              </button>
            )}
            {cursor && (
              <button type="button" className="secondary" onClick={() => setCursor(undefined)}>
                Back to first page
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
