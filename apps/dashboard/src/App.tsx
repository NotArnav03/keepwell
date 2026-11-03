import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  type AuditEntry,
  type MerchantFeedEvent,
  type MerchantMeResponse,
  type MerchantOverviewResponse,
  type MerchantSubscriptionDetailResponse,
  type MerchantSubscriptionListQuery,
  type MerchantTimelineResponse,
  type PolicyDryRunResponse,
  type PolicyVersionResponse,
} from "@keepwell/contracts";
import { MerchantApi, MerchantApiError } from "./api.js";
import { explainAuditEntry } from "./views.js";
import { parsePolicyDraft, previewPolicyDraft } from "./policy-editor.js";
import { themeStyles, type Theme } from "@keepwell/ui";

type Page = "overview" | "subscribers" | "timeline" | "audit" | "policies" | "onboarding";
const NAV: { id: Page; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "subscribers", label: "Subscribers" },
  { id: "timeline", label: "Timeline" },
  { id: "audit", label: "Audit log" },
  { id: "policies", label: "Policies" },
  { id: "onboarding", label: "Onboarding" },
];

const api = new MerchantApi();

function pageFromHash(): { page: Page; subscriptionId?: string } {
  const [path] = window.location.hash.replace(/^#/, "").split("?");
  const segments = (path ?? "overview").split("/").filter(Boolean);
  const page = segments[0] as Page | undefined;
  if (page === "subscribers" && segments[1]) {
    return { page, subscriptionId: decodeURIComponent(segments[1]) };
  }
  return { page: NAV.find((item) => item.id === page)?.id ?? "overview" };
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <p className="notice notice-error" role="alert">
      {message}
    </p>
  );
}

function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" aria-live="polite">
      {label}
    </p>
  );
}

function Login({ onSignedIn }: { onSignedIn: (identity: MerchantMeResponse) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setError("");
    setBusy(true);
    const values = new FormData(event.currentTarget);
    try {
      const email = values.get("email");
      const password = values.get("password");
      if (typeof email !== "string" || typeof password !== "string") {
        throw new TypeError("Enter an email and password.");
      }
      const identity = await api.login({ email, password });
      form.reset();
      onSignedIn(identity);
    } catch (cause) {
      setError(cause instanceof MerchantApiError ? cause.message : "Sign-in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-wrap">
      <form
        className="panel login-form"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <p className="eyebrow">MERCHANT WORKSPACE</p>
        <h1>Sign in to Keepwell</h1>
        {error && <ErrorMessage message={error} />}
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

export function App() {
  const [identity, setIdentity] = useState<MerchantMeResponse | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [route, setRoute] = useState(pageFromHash);
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem("keepwell-theme") === "dark" ? "dark" : "light",
  );
  const client = useMemo(() => api, []);

  useEffect(() => {
    let active = true;
    client
      .me()
      .then((result) => {
        if (active) setIdentity(result);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof MerchantApiError && cause.status === 401) setIdentity(null);
        else setAuthError(cause instanceof Error ? cause.message : "Could not connect to Keepwell.");
      })
      .finally(() => {
        if (active) setAuthLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    const update = () => setRoute(pageFromHash());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  function changeTheme(next: Theme) {
    setTheme(next);
    localStorage.setItem("keepwell-theme", next);
  }

  async function signOut() {
    try {
      await client.logout();
      setIdentity(null);
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Sign out failed.");
    }
  }

  if (authLoading)
    return (
      <>
        <style>{themeStyles(theme)}</style>
        <Loading label="Checking merchant session…" />
      </>
    );
  if (!identity) {
    return (
      <>
        <style>{themeStyles(theme)}</style>
        {authError && <ErrorMessage message={authError} />}
        <Login
          onSignedIn={(user) => {
            setAuthError("");
            setIdentity(user);
          }}
        />
      </>
    );
  }

  const activePage = route.subscriptionId ? "subscribers" : route.page;
  return (
    <>
      <style>{themeStyles(theme)}</style>
      <div className="layout">
        <aside className="sidebar">
          <a className="brand" href="#overview">
            Keepwell
          </a>
          <nav aria-label="Main navigation" className="nav">
            {NAV.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                aria-current={activePage === item.id ? "page" : undefined}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <span className="muted">Merchant workspace</span>
            <button
              type="button"
              className="secondary"
              onClick={() => changeTheme(theme === "light" ? "dark" : "light")}
            >
              Use {theme === "light" ? "dark" : "light"} theme
            </button>
          </div>
        </aside>
        <div className="main-column">
          <header className="topbar">
            <strong>{identity.merchant.name}</strong>
            <div className="user-menu">
              <span>{identity.user.email}</span>
              <button className="secondary" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </header>
          <main className="content" id="main-content">
            {authError && <ErrorMessage message={authError} />}
            {route.subscriptionId ? (
              <SubscriberDetail api={client} id={route.subscriptionId} />
            ) : (
              <>
                {activePage === "overview" && <Overview api={client} />}
                {activePage === "subscribers" && <Subscribers api={client} />}
                {activePage === "timeline" && <Timeline api={client} />}
                {activePage === "audit" && <AuditExplorer api={client} />}
                {activePage === "policies" && <PolicyEditor api={client} />}
                {activePage === "onboarding" && <Onboarding api={client} />}
              </>
            )}
          </main>
        </div>
      </div>
    </>
  );
}

function Overview({ api: client }: { api: MerchantApi }) {
  const [overview, setOverview] = useState<MerchantOverviewResponse | null>(null);
  const [events, setEvents] = useState<MerchantFeedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86_400_000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  useEffect(() => {
    let active = true;
    client
      .overview(range)
      .then((value) => {
        if (active) setOverview(value);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Overview unavailable.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const stop = client.subscribeToFeed(
      (event) => setEvents((current) => [event, ...current].slice(0, 20)),
      () => setError("Live activity connection interrupted; reconnecting…"),
    );
    return () => {
      active = false;
      stop();
    };
  }, [client, range]);

  return (
    <>
      <PageHeading title="Overview" subtitle="The last 30 days · figures from your Keepwell API" />
      {loading && <Loading label="Loading overview…" />}
      {error && <ErrorMessage message={error} />}
      {overview && (
        <>
          <div className="kpi-grid">
            <Metric title="MRR saved" value={`${overview.mrrSaved.value} ${overview.mrrSaved.currency}`} />
            <Metric
              title="Save rate"
              value={`${overview.saveRate.savedSessions} / ${overview.saveRate.eligibleSessions} sessions`}
            />
            <Metric
              title="Recovered revenue"
              value={`${overview.recoveredRevenue.value} ${overview.recoveredRevenue.currency}`}
            />
          </div>
          <div className="two-column">
            <section className="panel">
              <h2>Outcomes by offer</h2>
              <OutcomeTable labels={overview.outcomesByOffer.map((row) => [row.offer, row.count])} />
            </section>
            <section className="panel">
              <h2>Outcomes by reason</h2>
              <OutcomeTable labels={overview.outcomesByReason.map((row) => [row.reason, row.count])} />
            </section>
          </div>
        </>
      )}
      <section className="panel feed-panel">
        <h2>Live activity</h2>
        {events.length === 0 ? (
          <p className="muted">Waiting for domain events…</p>
        ) : (
          <ol className="feed-list">
            {events.map((event) => (
              <li key={event.id}>
                <time dateTime={event.occurredAt}>{event.occurredAt}</time>
                <strong>{event.type}</strong>
                {event.simulated && <Badge>SIMULATED</Badge>}
                <a href={`#audit?event=${encodeURIComponent(event.id)}`}>Audit trail</a>
              </li>
            ))}
          </ol>
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

function OutcomeTable({ labels }: { labels: [string, number][] }) {
  if (labels.length === 0) return <p className="muted">No outcomes for this period.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Category</th>
          <th>Count</th>
        </tr>
      </thead>
      <tbody>
        {labels.map(([label, count]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Subscribers({ api: client }: { api: MerchantApi }) {
  const [items, setItems] = useState<Awaited<ReturnType<MerchantApi["listSubscriptions"]>> | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<MerchantSubscriptionListQuery["status"] | "">("");
  const [risk, setRisk] = useState<MerchantSubscriptionListQuery["risk"] | "">("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(nextCursor?: string) {
    setLoading(true);
    setError("");
    try {
      const result = await client.listSubscriptions({
        query,
        ...(status && { status }),
        ...(risk && { risk }),
        ...(nextCursor && { cursor: nextCursor }),
      });
      setItems(result);
      setCursor(nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Subscribers could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(); /* initial query */
  }, [client]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void load();
  }
  return (
    <>
      <PageHeading title="Subscribers" subtitle="Search and filter PayPal subscriptions" />
      <form className="filter-bar" onSubmit={search}>
        <label>
          Search
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Name or PayPal ID"
          />
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.currentTarget.value as typeof status)}>
            <option value="">Any status</option>
            {["ACTIVE", "SUSPENDED", "CANCELLED", "EXPIRED", "APPROVED", "APPROVAL_PENDING"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Risk
          <select value={risk} onChange={(event) => setRisk(event.currentTarget.value as typeof risk)}>
            <option value="">Any risk</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <button type="submit">Apply filters</button>
      </form>
      {loading && <Loading label="Loading subscribers…" />}
      {error && <ErrorMessage message={error} />}
      {items && (
        <>
          <div className="table-wrap">
            <table>
              <caption>PayPal subscriptions managed by Keepwell</caption>
              <thead>
                <tr>
                  <th>Subscriber</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Risk</th>
                  <th>Price</th>
                  <th>PayPal subscription</th>
                </tr>
              </thead>
              <tbody>
                {items.subscriptions.length === 0 ? (
                  <tr>
                    <td colSpan={6}>No subscribers match these filters.</td>
                  </tr>
                ) : (
                  items.subscriptions.map(({ subscription, risk: score }) => (
                    <tr key={subscription.id}>
                      <td>
                        <a href={`#subscribers/${encodeURIComponent(subscription.id)}`}>
                          {subscription.subscriberFirstName ?? "Subscriber"}
                        </a>
                      </td>
                      <td>{subscription.planName}</td>
                      <td>{subscription.status}</td>
                      <td>{score ? `${score.band} (${score.score}/100)` : "Not scored"}</td>
                      <td>
                        {(subscription.priceOverride ?? subscription.price).value}{" "}
                        {(subscription.priceOverride ?? subscription.price).currency}
                      </td>
                      <td>
                        <code>{subscription.paypalSubscriptionId}</code>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {items.nextCursor && (
            <button className="secondary" onClick={() => void load(items.nextCursor ?? undefined)}>
              Next page
            </button>
          )}
          {cursor && (
            <button className="secondary" onClick={() => void load()}>
              Back to first page
            </button>
          )}
        </>
      )}
    </>
  );
}

function SubscriberDetail({ api: client, id }: { api: MerchantApi; id: string }) {
  const [detail, setDetail] = useState<MerchantSubscriptionDetailResponse | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    client
      .subscription(id)
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Subscriber details unavailable.");
      });
    return () => {
      active = false;
    };
  }, [client, id]);
  if (error) return <ErrorMessage message={error} />;
  if (!detail) return <Loading label="Loading subscriber…" />;
  const { subscription } = detail;
  return (
    <>
      <a href="#subscribers">← Back to subscribers</a>
      <PageHeading
        title={subscription.subscriberFirstName ?? "Subscriber"}
        subtitle={subscription.paypalSubscriptionId}
      />
      <section className="panel">
        <dl className="details-grid">
          <dt>Plan</dt>
          <dd>{subscription.planName}</dd>
          <dt>Status</dt>
          <dd>{subscription.status}</dd>
          <dt>Price</dt>
          <dd>
            {(subscription.priceOverride ?? subscription.price).value}{" "}
            {(subscription.priceOverride ?? subscription.price).currency}
          </dd>
          <dt>Next billing</dt>
          <dd>{subscription.nextBillingTime ?? "Not scheduled"}</dd>
        </dl>
      </section>
      <section className="panel">
        <h2>Actions</h2>
        {detail.actions.length === 0 ? (
          <p>No actions recorded.</p>
        ) : (
          <ul>
            {detail.actions.map((action) => (
              <li key={action.id}>
                {action.type} · {action.state} {action.simulated && <Badge>SIMULATED</Badge>} ·{" "}
                <a href={`#audit?subject=${encodeURIComponent(action.id)}`}>Audit entry</a> ·{" "}
                <a href={`#paypal/${encodeURIComponent(subscription.paypalSubscriptionId)}`}>
                  {subscription.paypalSubscriptionId}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <h2>Conversations</h2>
        {detail.sessions.length === 0 ? (
          <p>No sessions recorded.</p>
        ) : (
          <ul>
            {detail.sessions.map((session) => (
              <li key={session.id}>
                {session.channel} · {session.state} · {session.outcome ?? "in progress"}{" "}
                {session.simulated && <Badge>SIMULATED</Badge>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function AuditExplorer({ api: client }: { api: MerchantApi }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [kind, setKind] = useState("");
  const [subject, setSubject] = useState("");
  const [verification, setVerification] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try {
      setEntries((await client.audit({ ...(kind && { kind }), ...(subject && { subject }) })).entries);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Audit entries unavailable.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load(); /* initial audit query */
  }, [client]);
  async function verify() {
    setVerification("Verifying the full chain…");
    try {
      const result = await client.verifyAudit();
      setVerification(
        result.ok ? `Verified ${result.checked} entries.` : `Chain break at sequence ${result.brokenAtSeq}.`,
      );
    } catch (cause) {
      setVerification(cause instanceof Error ? cause.message : "Could not verify audit chain.");
    }
  }
  return (
    <>
      <PageHeading title="Audit log" subtitle="Trace decisions to actions and PayPal subscriptions" />
      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label>
          Event kind
          <input value={kind} onChange={(event) => setKind(event.currentTarget.value)} />
        </label>
        <label>
          Subject ID
          <input value={subject} onChange={(event) => setSubject(event.currentTarget.value)} />
        </label>
        <button>Filter</button>
        <button className="secondary" type="button" onClick={() => void verify()}>
          Verify chain
        </button>
      </form>
      {verification && (
        <p role="status" className="notice">
          {verification}
        </p>
      )}
      {loading && <Loading label="Loading audit entries…" />}
      {error && <ErrorMessage message={error} />}
      <ol className="audit-list">
        {entries.map((entry) => (
          <li key={`${entry.merchantId}-${entry.seq}`} className="panel">
            <h2>
              {entry.kind} {entry.simulated && <Badge>SIMULATED</Badge>}
            </h2>
            <time dateTime={entry.at}>{entry.at}</time>
            <p>{explainAuditEntry(entry)}</p>
            <p>
              {Object.entries(entry.subjectIds).map(([label, value]) => (
                <span key={label} className="subject-link">
                  {label}: <a href={`#audit?subject=${encodeURIComponent(value)}`}>{value}</a>
                </span>
              ))}
            </p>
            <details>
              <summary>Hash chain proof</summary>
              <p>Sequence {entry.seq}</p>
              <code>{entry.prevHash}</code>
              <br />
              <code>{entry.hash}</code>
            </details>
          </li>
        ))}
      </ol>
    </>
  );
}

function Timeline({ api: client }: { api: MerchantApi }) {
  const [data, setData] = useState<MerchantTimelineResponse | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 90 * 86_400_000);
    client
      .timeline({ from: from.toISOString(), to: to.toISOString() })
      .then(setData)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Timeline unavailable."));
  }, [client]);
  const names = new Map((data?.resources ?? []).map((resource) => [resource.id, resource.name]));
  const events = [...(data?.events ?? [])].sort((a, b) => a.startDate.localeCompare(b.startDate));
  return (
    <>
      <PageHeading title="Subscriber timeline" subtitle="Billing and retention events · 90 days" />
      <p className="notice">
        Bryntum Scheduler is not enabled until the team confirms a licence. This accessible event list is the
        current fallback.
      </p>
      {error && <ErrorMessage message={error} />}
      {!data && !error && <Loading label="Loading timeline…" />}
      {data &&
        (events.length ? (
          <ol className="timeline-list">
            {events.map((event) => (
              <li key={event.id}>
                <time dateTime={event.startDate}>{event.startDate}</time>
                <strong>
                  {names.get(event.resourceId) ?? "Subscriber"}: {event.name}
                </strong>
                <span>
                  {event.kind} {event.simulated && <Badge>SIMULATED</Badge>}
                </span>
                {event.auditSeq && <a href={`#audit?seq=${event.auditSeq}`}>Audit #{event.auditSeq}</a>}
                <a
                  href={`#subscribers/${encodeURIComponent(data.resources.find((resource) => resource.id === event.resourceId)?.subscriptionId ?? event.resourceId)}`}
                >
                  Subscriber
                </a>
                <a href={`#paypal/${encodeURIComponent(event.paypalSubscriptionId)}`}>
                  {event.paypalSubscriptionId}
                </a>
              </li>
            ))}
          </ol>
        ) : (
          <p>No timeline events in this range.</p>
        ))}
    </>
  );
}

function PolicyEditor({ api: client }: { api: MerchantApi }) {
  const [stored, setStored] = useState<PolicyVersionResponse | null>(null);
  const [source, setSource] = useState("");
  const [sampleIds, setSampleIds] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [dryRun, setDryRun] = useState<PolicyDryRunResponse | null>(null);
  const [preview, setPreview] = useState<ReturnType<typeof previewPolicyDraft>>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    client
      .policies()
      .then(async (list) => {
        if (list.currentVersion === null) return;
        const version = await client.policy(list.currentVersion);
        if (!active) return;
        setStored(version);
        const { version: _version, ...draft } = version.document;
        setSource(JSON.stringify(draft, null, 2));
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Policy unavailable.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client]);
  async function runDryRun() {
    setError("");
    setMessage("");
    setDryRun(null);
    setPreview([]);
    try {
      const draft = parsePolicyDraft(source);
      const ids = sampleIds
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter(Boolean);
      const result = await client.dryRun({ document: draft, sampleSubscriptionIds: ids });
      setDryRun(result);
      setPreview(
        previewPolicyDraft(
          draft,
          result.samples.map((sample) => sample.context),
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Policy dry-run failed.");
    }
  }
  async function publish() {
    setError("");
    setMessage("");
    try {
      const document = parsePolicyDraft(source);
      const result = await client.publishPolicy({
        baseVersion: stored?.version ?? null,
        document,
        ...(changeNote && { changeNote }),
      });
      setStored(result);
      setMessage(`Published policy version ${result.version}.`);
      setDryRun(null);
      setPreview([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Policy could not be published.");
    }
  }
  if (loading)
    return (
      <>
        <PageHeading title="Policy editor" />
        <Loading label="Loading policy…" />
      </>
    );
  return (
    <>
      <PageHeading
        title="Policy editor"
        subtitle={
          stored ? `Editing from immutable version ${stored.version}` : "Create the first policy version"
        }
      />
      {error && <ErrorMessage message={error} />}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <section className="panel policy-form">
        <label htmlFor="policy-json">Policy document (JSON)</label>
        <textarea
          id="policy-json"
          rows={22}
          spellCheck={false}
          value={source}
          onChange={(event) => setSource(event.currentTarget.value)}
        />
        <label htmlFor="sample-ids">Sample subscriber IDs (comma or space separated)</label>
        <input
          id="sample-ids"
          value={sampleIds}
          onChange={(event) => setSampleIds(event.currentTarget.value)}
        />
        <label htmlFor="change-note">Change note</label>
        <input
          id="change-note"
          value={changeNote}
          onChange={(event) => setChangeNote(event.currentTarget.value)}
          maxLength={280}
        />
        <div className="button-row">
          <button type="button" onClick={() => void runDryRun()}>
            Dry-run in browser
          </button>
          <button type="button" className="secondary" onClick={() => void publish()}>
            Publish version
          </button>
        </div>
      </section>
      {dryRun && (
        <section className="panel">
          <h2>Dry-run results</h2>
          {dryRun.problems.length > 0 && (
            <ErrorMessage
              message={dryRun.problems.map((problem) => `${problem.path}: ${problem.message}`).join(" · ")}
            />
          )}
          {dryRun.missingSubscriptionIds.length > 0 && (
            <p>Unknown subscriber IDs: {dryRun.missingSubscriptionIds.join(", ")}</p>
          )}
          {preview.map((menu, index) => (
            <article key={dryRun.samples[index]?.subscriptionId}>
              <h3>
                {dryRun.samples[index]?.subscriberFirstName ?? "Subscriber"} ·{" "}
                {dryRun.samples[index]?.planName}
              </h3>
              <p>
                {menu.offers.length
                  ? menu.offers.map((offer) => offer.kind).join(", ")
                  : "No offer; cancel remains available."}
              </p>
            </article>
          ))}
        </section>
      )}
    </>
  );
}

function Onboarding({ api: client }: { api: MerchantApi }) {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [verified, setVerified] = useState(false);
  const [webhook, setWebhook] = useState(false);
  const [backfillDone, setBackfillDone] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function saveCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await client.saveOnboardingCredentials({ clientId, clientSecret: secret });
      setVerified(result.verified);
      setSecret("");
      setMessage(`Sandbox credentials verified and stored (client ID ending ${result.clientIdSuffix}).`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Credential verification failed.");
    } finally {
      setBusy(false);
    }
  }
  async function registerWebhook() {
    setBusy(true);
    setError("");
    try {
      await client.registerWebhook();
      setWebhook(true);
      setMessage("PayPal webhook registered.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Webhook registration failed.");
    } finally {
      setBusy(false);
    }
  }
  async function backfill() {
    setBusy(true);
    setError("");
    try {
      const result = await client.backfill();
      setBackfillDone(true);
      setMessage(`Backfill queued (${result.jobIds.length} jobs).`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Backfill could not start.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading title="Onboarding" subtitle="Connect a PayPal sandbox app" />
      <p className="notice">
        Use sandbox credentials only. The client secret is sent directly to Keepwell over HTTPS, cleared from
        this form after verification, and must never be shared or logged.
      </p>
      {error && <ErrorMessage message={error} />}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <ol className="steps">
        <li aria-current={!verified ? "step" : undefined}>
          <h2>1. Verify credentials</h2>
          <form
            className="panel onboarding-form"
            onSubmit={(event) => {
              void saveCredentials(event);
            }}
          >
            <label htmlFor="paypal-client-id">Sandbox client ID</label>
            <input
              id="paypal-client-id"
              value={clientId}
              onChange={(event) => setClientId(event.currentTarget.value)}
              autoComplete="off"
              required
            />
            <label htmlFor="paypal-client-secret">Sandbox secret</label>
            <input
              id="paypal-client-secret"
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.currentTarget.value)}
              autoComplete="new-password"
              required
            />
            <button disabled={busy}>{busy ? "Verifying…" : "Verify and store"}</button>
          </form>
        </li>
        <li aria-current={verified && !webhook ? "step" : undefined}>
          <h2>2. Register PayPal webhook</h2>
          <button
            type="button"
            disabled={!verified || busy || webhook}
            onClick={() => void registerWebhook()}
          >
            {webhook ? "Webhook registered" : "Register webhook"}
          </button>
        </li>
        <li aria-current={webhook && !backfillDone ? "step" : undefined}>
          <h2>3. Import plans and subscriptions</h2>
          <button type="button" disabled={!webhook || busy || backfillDone} onClick={() => void backfill()}>
            {backfillDone ? "Backfill queued" : "Start backfill"}
          </button>
        </li>
      </ol>
      {backfillDone && (
        <section className="panel">
          <h2>You’re live</h2>
          <p>Your sandbox data is being imported. You can monitor progress from Subscribers.</p>
          <a href="#subscribers">Open subscribers</a>
        </section>
      )}
    </>
  );
}

function PageHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="page-heading">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </header>
  );
}

function Badge({ children }: { children: string }) {
  return <span className="badge">{children}</span>;
}
