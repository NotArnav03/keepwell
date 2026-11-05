import { useEffect, useState } from "react";
import type { OutboxItem } from "@keepwell/contracts";
import type { InsightsClient } from "./client.js";
import { isAbortError, panelFailure, type PanelFailure } from "./errors.js";
import { formatUtcDate } from "./format.js";
import { mergeOutbox } from "./outbox-model.js";
import { PanelEmpty, PanelLoading, PanelNotice } from "./status.js";

export function InboxPanel({ client }: { client: InsightsClient }) {
  const [items, setItems] = useState<OutboxItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [failure, setFailure] = useState<PanelFailure | null>(null);
  const [moreError, setMoreError] = useState<PanelFailure | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    let active = true;
    setPhase("loading");
    setFailure(null);
    setMoreError(null);
    client.outbox({}, ctrl.signal).then(
      (page) => {
        if (!active) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setPhase("ready");
      },
      (cause: unknown) => {
        if (!active || isAbortError(cause)) return;
        setFailure(panelFailure(cause));
        setPhase("failed");
      },
    );
    return () => {
      active = false;
      ctrl.abort();
    };
  }, [client, reload]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await client.outbox({ cursor });
      setItems((current) => mergeOutbox(current ?? [], page.items));
      setCursor(page.nextCursor);
    } catch (cause) {
      if (!isAbortError(cause)) setMoreError(panelFailure(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  if (items === null && phase === "loading") return <PanelLoading label="Loading demo inbox…" />;
  if (phase === "failed" && failure) {
    return (
      <>
        <PanelNotice failure={failure} />
        <button type="button" className="secondary" onClick={() => setReload((n) => n + 1)}>
          Try again
        </button>
      </>
    );
  }
  if (!items) return null;
  const selectedItem = items.find((item) => item.id === selected) ?? null;

  return (
    <section aria-busy={phase === "loading" || loadingMore}>
      <h2>Demo Inbox</h2>
      <p role="status" aria-live="polite">
        {items.length === 0 ? "No messages in the outbox." : "Outbox updated."}
      </p>
      {moreError && <PanelNotice failure={moreError} />}
      {items.length === 0 ? (
        <PanelEmpty message="No messages in the outbox." />
      ) : (
        <div className="table-wrap">
          <table>
            <caption>Outgoing messages, newest first</caption>
            <thead>
              <tr>
                <th>To</th>
                <th>Template</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Suppressed</th>
                <th>When</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.to}</td>
                  <td>{item.template}</td>
                  <td>
                    {item.subject}
                    {item.simulated && <span className="badge">SIMULATED</span>}
                  </td>
                  <td>{item.status}</td>
                  <td>{item.suppressedBecause ?? "None"}</td>
                  <td>
                    <time dateTime={item.sentAt ?? item.dueAt}>
                      {formatUtcDate(item.sentAt ?? item.dueAt)}
                    </time>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      aria-pressed={selected === item.id}
                      onClick={() => setSelected(item.id)}
                    >
                      View message
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <button type="button" className="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
      {selectedItem && <MessageBody item={selectedItem} />}
    </section>
  );
}

function MessageBody({ item }: { item: OutboxItem }) {
  return (
    <section className="panel" aria-live="polite">
      <h3>{item.subject}</h3>
      <p className="muted">
        To {item.to}
        {item.simulated && <span className="badge">SIMULATED</span>}
      </p>
      <pre className="ins-plain">{item.bodyText}</pre>
    </section>
  );
}
