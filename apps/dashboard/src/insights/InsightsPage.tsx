import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { MerchantApi } from "../api.js";
import { AtRiskPanel } from "./AtRiskPanel.js";
import { ActionQueuePanel } from "./ActionQueuePanel.js";
import { CopilotPanel } from "./CopilotPanel.js";
import { InboxPanel } from "./InboxPanel.js";
import { InsightsClient } from "./client.js";
import { OverviewPanel } from "./OverviewPanel.js";

const TABS = [
  ["overview", "Overview"],
  ["risk", "At risk"],
  ["copilot", "Copilot"],
  ["actions", "Action queue"],
  ["inbox", "Demo Inbox"],
] as const;

type TabId = (typeof TABS)[number][0];

export function InsightsPage({ api }: { api: MerchantApi }) {
  const client = useMemo(() => new InsightsClient(api), [api]);
  const [tab, setTab] = useState<TabId>("overview");
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const next = moveTab(
      TABS.findIndex((item) => item[0] === event.currentTarget.dataset.tab),
      event.key,
    );
    if (next === null) return;
    event.preventDefault();
    const id = TABS[next]?.[0];
    if (!id) return;
    setTab(id);
    buttons.current[next]?.focus();
  }

  return (
    <>
      <header className="page-heading">
        <h1>Insights</h1>
        <p>Retention figures from your Keepwell API. Nothing here is estimated in the browser.</p>
      </header>
      <div className="ins-tabs" role="tablist" aria-label="Insights sections">
        {TABS.map(([id, label], index) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`ins-tab-${id}`}
            data-tab={id}
            aria-selected={tab === id}
            aria-controls={`ins-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? undefined : "secondary"}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            onClick={() => setTab(id)}
            onKeyDown={onKeyDown}
          >
            {label}
          </button>
        ))}
      </div>
      <TabPanel id="overview" tab={tab}>
        <OverviewPanel client={client} />
      </TabPanel>
      <TabPanel id="risk" tab={tab}>
        <AtRiskPanel api={api} />
      </TabPanel>
      <TabPanel id="copilot" tab={tab}>
        <CopilotPanel client={client} />
      </TabPanel>
      <TabPanel id="actions" tab={tab}>
        <ActionQueuePanel client={client} />
      </TabPanel>
      <TabPanel id="inbox" tab={tab}>
        <InboxPanel client={client} />
      </TabPanel>
    </>
  );
}

function TabPanel({ id, tab, children }: { id: TabId; tab: TabId; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`ins-panel-${id}`} aria-labelledby={`ins-tab-${id}`} hidden={tab !== id}>
      {children}
    </div>
  );
}

function moveTab(index: number, key: string): number | null {
  if (index < 0) return null;
  if (key === "ArrowRight") return (index + 1) % TABS.length;
  if (key === "ArrowLeft") return (index - 1 + TABS.length) % TABS.length;
  if (key === "Home") return 0;
  if (key === "End") return TABS.length - 1;
  return null;
}
