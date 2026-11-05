import { useEffect, useRef, useState } from "react";
import type { InsightsClient } from "./client.js";
import { isAbortError, panelFailure, type PanelFailure } from "./errors.js";
import {
  formatUtcDate,
  intervalLabel,
  kindLabel,
  moneyFromUnknown,
  moneyLabel,
  stringParam,
} from "./format.js";
import {
  confirmationCopy,
  executionErrorText,
  idList,
  needsApprovalConfirm,
  orderActions,
  replaceAction,
} from "./queue-model.js";
import type { InsightActionView } from "./schemas.js";
import { PanelEmpty, PanelLoading, PanelNotice } from "./status.js";
import { usePanelQuery } from "./usePanelQuery.js";

export function ActionQueuePanel({ client }: { client: InsightsClient }) {
  const [reload, setReload] = useState(0);
  const query = usePanelQuery(String(reload), (signal) => client.actions(signal));
  const [items, setItems] = useState<InsightActionView[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [failure, setFailure] = useState<PanelFailure | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (query.status === "ready") setItems(orderActions(query.data.items));
  }, [query]);

  async function decide(item: InsightActionView, decision: "approve" | "reject") {
    setBusyId(item.id);
    setFailure(null);
    try {
      const next = await client.decide(item.id, decision);
      setItems((current) => replaceAction(current ?? [], next));
      setConfirmId(null);
      setNotice(`${kindLabel(next.kind)} is ${next.state}.`);
    } catch (cause) {
      if (!isAbortError(cause)) setFailure(panelFailure(cause));
    } finally {
      setBusyId(null);
    }
  }

  const shown = items ?? (query.status === "ready" ? orderActions(query.data.items) : null);
  if (shown === null && query.status === "loading") return <PanelLoading label="Loading action queue…" />;
  if (shown === null && query.status === "failed") {
    return (
      <>
        <PanelNotice failure={query.failure} />
        <button type="button" className="secondary" onClick={() => setReload((n) => n + 1)}>
          Try again
        </button>
      </>
    );
  }
  if (!shown) return null;

  return (
    <section aria-busy={query.status === "loading"}>
      <h2>Action queue</h2>
      {notice && (
        <p className="notice" role="status" aria-live="polite">
          {notice}
        </p>
      )}
      {query.status === "failed" && <PanelNotice failure={query.failure} />}
      {failure && <PanelNotice failure={failure} />}
      {shown.length === 0 ? (
        <PanelEmpty message="No proposed actions." />
      ) : (
        <ul className="audit-list">
          {shown.map((item) => (
            <ActionCard
              key={item.id}
              item={item}
              busy={busyId === item.id}
              confirming={confirmId === item.id}
              onAsk={() => setConfirmId(item.id)}
              onCancel={() => setConfirmId(null)}
              onDecide={(decision) => void decide(item, decision)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ActionCard({
  item,
  busy,
  confirming,
  onAsk,
  onCancel,
  onDecide,
}: {
  item: InsightActionView;
  busy: boolean;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onDecide: (decision: "approve" | "reject") => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const executionError = executionErrorText(item.execution.error);
  const locked = busy || item.state !== "proposed";
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  return (
    <li>
      <article aria-labelledby={`action-${item.id}`}>
        <h3 id={`action-${item.id}`}>
          {kindLabel(item.kind)}
          {item.simulated && <span className="badge">SIMULATED</span>}
        </h3>
        <p className="muted">
          <time dateTime={item.createdAt}>{formatUtcDate(item.createdAt)}</time>
          {" · "}
          {item.state}
          {" · "}
          {item.proposedBy === "copilot" ? "copilot" : "merchant MCP"}
        </p>
        <p className="ins-plain">{item.rationale}</p>
        {item.estimate ? (
          <p>
            Estimate {moneyLabel(item.estimate.monthlyRevenueImpact)}. {item.estimate.basis}
          </p>
        ) : (
          <p className="muted">No estimate was returned.</p>
        )}
        <ActionParams item={item} />
        <p>Execution: {item.execution.status.replaceAll("_", " ")}</p>
        {executionError && <p className="notice notice-error">{executionError}</p>}
        {item.error && <p className="notice notice-error">{item.error}</p>}
        {item.actionId && <a href={`#audit?subject=${encodeURIComponent(item.actionId)}`}>Audit entry</a>}
        {confirming ? (
          <div className="notice" role="region" aria-label="Confirm this approval">
            <p>{confirmationCopy(item)}</p>
            <div className="button-row">
              <button ref={confirmRef} type="button" disabled={busy} onClick={() => onDecide("approve")}>
                {busy ? "Approving…" : "Confirm approval"}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
                Back
              </button>
            </div>
          </div>
        ) : (
          <div className="button-row">
            <button
              type="button"
              disabled={locked}
              onClick={() => (needsApprovalConfirm(item.kind) ? onAsk() : onDecide("approve"))}
            >
              {busy ? "Working…" : "Approve"}
            </button>
            <button type="button" className="secondary" disabled={locked} onClick={() => onDecide("reject")}>
              Reject
            </button>
          </div>
        )}
      </article>
    </li>
  );
}

function ActionParams({ item }: { item: InsightActionView }) {
  if (item.kind === "create_plan") {
    return (
      <dl className="details-grid">
        <Detail term="Name" value={stringParam(item.params, "name")} />
        <Detail term="Price" value={moneyFromUnknown(item.params.price)} />
        <Detail term="Interval" value={intervalLabel(item.params.interval)} />
        <Detail term="Based on plan" value={stringParam(item.params, "basedOnPaypalPlanId")} />
      </dl>
    );
  }
  if (item.kind === "send_winback_batch") {
    const ids = idList(item.params.subscriptionIds);
    return (
      <>
        <DetailLine term="Reason" value={stringParam(item.params, "reason")} />
        {ids.length > 0 && (
          <details>
            <summary>Subscription ids</summary>
            <ul>
              {ids.map((id, index) => (
                <li key={`${id}-${index}`}>
                  <code>{id}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
      </>
    );
  }
  return <DetailLine term="Summary" value={stringParam(item.params, "summary")} />;
}

function Detail({ term, value }: { term: string; value: string | null }) {
  if (!value) return null;
  return (
    <>
      <dt>{term}</dt>
      <dd>{value}</dd>
    </>
  );
}

function DetailLine({ term, value }: { term: string; value: string | null }) {
  if (!value) return null;
  return (
    <p>
      {term}: {value}
    </p>
  );
}
