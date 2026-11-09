import { Fragment, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import {
  type AuditEntry,
  type MerchantFeedEvent,
  type MerchantMeResponse,
  type MerchantOverviewResponse,
  type MerchantSubscriptionDetailResponse,
  type MerchantSubscriptionListQuery,
  type MerchantTimelineResponse,
} from "@keepwell/contracts";
import { MerchantApi, MerchantApiError } from "./api.js";
import { explainAuditEntry } from "./views.js";
import { ApiKeys } from "./ApiKeys.js";
import { PolicyEditor } from "./PolicyEditor.js";
import { Seal } from "./Seal.js";
import { condenseTranscript } from "./transcript.js";
import { TimelineChart } from "./TimelineChart.js";
import { InsightsPage } from "./insights/InsightsPage.js";
import { preferredTheme, themeStyles, type Theme } from "@keepwell/ui";
import {
  actionTone,
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatRelative,
  humanize,
  kindInfo,
  OFFER_LABELS,
  REASON_LABELS,
  statusInfo,
} from "./fmt.js";
import {
  EmptyState,
  Icon,
  Mark,
  PageHeading,
  RankedBars,
  RiskStrip,
  SegmentedBar,
  StatusBadge,
  type IconName,
} from "./ui.js";

type Page =
  "overview" | "subscribers" | "timeline" | "audit" | "policies" | "onboarding" | "insights" | "api-keys";
const NAV: { id: Page; label: string; icon: IconName; group: string }[] = [
  { id: "overview", label: "Overview", icon: "overview", group: "Monitor" },
  { id: "insights", label: "Insights", icon: "insights", group: "Monitor" },
  { id: "subscribers", label: "Subscribers", icon: "subscribers", group: "Monitor" },
  { id: "timeline", label: "Timeline", icon: "timeline", group: "Monitor" },
  { id: "policies", label: "Policies", icon: "policies", group: "Control" },
  { id: "audit", label: "Audit log", icon: "audit", group: "Control" },
  { id: "api-keys", label: "API keys", icon: "keys", group: "Connect" },
  { id: "onboarding", label: "Onboarding", icon: "onboarding", group: "Connect" },
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
      const merchantSlug = values.get("merchantSlug");
      if (typeof email !== "string" || typeof password !== "string") {
        throw new TypeError("Enter an email and password.");
      }
      const identity = await api.login({
        email,
        password,
        ...(typeof merchantSlug === "string" && merchantSlug.trim() ? { merchantSlug } : {}),
      });
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
      <aside className="login-aside" aria-hidden="true">
        <span className="brand">
          <span className="brand-name">
            <Mark />
            Keepwell
          </span>
          <span className="brand-sub">Retention ledger</span>
        </span>
        <p className="statement-big">
          Cancelling should take <em>one click.</em>
        </p>
        <div className="receipt">
          <div className="receipt-title">
            <span>Audit chain · extract</span>
          </div>
          <div>
            <span>#0041 offer.presented</span>
            <span>a41f…9c02</span>
          </div>
          <div>
            <span>#0042 offer.declined</span>
            <span>77d0…b8e1</span>
          </div>
          <div>
            <span>#0043 session.cancel_requested</span>
            <span>1be6…44a7</span>
          </div>
          <div>
            <span>chain</span>
            <span>intact</span>
          </div>
        </div>
      </aside>
      <div className="login-main">
        <form
          className="login-form"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <div>
            <p className="eyebrow">Merchant workspace</p>
            <h1>Sign in to Keepwell</h1>
            <p className="muted">Use the account your administrator created for you.</p>
          </div>
          {error && <ErrorMessage message={error} />}
          <label htmlFor="merchantSlug">
            Merchant slug <span className="muted">(optional)</span>
          </label>
          <input id="merchantSlug" name="merchantSlug" autoComplete="organization" />
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
          <button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}

export function App() {
  const [identity, setIdentity] = useState<MerchantMeResponse | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [route, setRoute] = useState(pageFromHash);
  const [theme, setTheme] = useState<Theme>(() =>
    preferredTheme(
      localStorage.getItem("keepwell-theme"),
      window.matchMedia("(prefers-color-scheme: dark)").matches,
    ),
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
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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
          <a className="brand" href="#overview" aria-label="Keepwell home">
            <span className="brand-name">
              <Mark />
              Keepwell
            </span>
            <span className="brand-sub">Retention ledger</span>
          </a>
          <nav aria-label="Main navigation" className="nav">
            {NAV.map((item, index) => (
              <Fragment key={item.id}>
                {NAV[index - 1]?.group !== item.group && <p className="nav-group">{item.group}</p>}
                <a href={`#${item.id}`} aria-current={activePage === item.id ? "page" : undefined}>
                  <Icon name={item.icon} />
                  {item.label}
                </a>
              </Fragment>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button
              type="button"
              className="ghost"
              onClick={() => changeTheme(theme === "light" ? "dark" : "light")}
            >
              <Icon name={theme === "light" ? "moon" : "sun"} />
              {theme === "light" ? "Dark" : "Light"} theme
            </button>
          </div>
        </aside>
        <div className="main-column">
          <header className="topbar">
            <span className="dateline">
              <strong>{identity.merchant.name}</strong> ·{" "}
              {new Date().toLocaleDateString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </span>
            <div className="user-menu">
              <span>{identity.user.email}</span>
              <button className="secondary" onClick={() => void signOut()}>
                <Icon name="logout" size={16} />
                Sign out
              </button>
            </div>
          </header>
          <main className="content" id="main-content">
            {authError && <ErrorMessage message={authError} />}
            <>
              {activePage === "overview" && <Overview api={client} />}
              {activePage === "subscribers" && (
                <Subscribers
                  api={client}
                  {...(route.subscriptionId && { selectedId: route.subscriptionId })}
                />
              )}
              {activePage === "timeline" && <Timeline api={client} />}
              {activePage === "audit" && <AuditExplorer api={client} />}
              {activePage === "policies" && <PolicyEditor api={client} />}
              {activePage === "onboarding" && <Onboarding api={client} />}
              {activePage === "insights" && <InsightsPage api={client} />}
              {activePage === "api-keys" && <ApiKeys api={client} />}
            </>
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

  const rate =
    overview && overview.saveRate.eligibleSessions > 0
      ? overview.saveRate.savedSessions / overview.saveRate.eligibleSessions
      : null;
  const outcomeTotal = overview ? overview.outcomesByOffer.reduce((sum, row) => sum + row.count, 0) : 0;
  const reasonTotal = overview ? overview.outcomesByReason.reduce((sum, row) => sum + row.count, 0) : 0;
  const kept = overview && Number(overview.mrrSaved.value) > 0;
  return (
    <>
      <PageHeading title="Overview" subtitle="What Keepwell did for you in the last 30 days" />
      {loading && <Loading label="Loading overview…" />}
      {error && <ErrorMessage message={error} />}
      <div className="daybook">
        <div className="daybook-main">
          {overview && (
            <section className="statement reveal" aria-label="Statement of the period">
              <p className="eyebrow">Statement of the period</p>
              <p className="lede">
                {kept ? (
                  <>
                    Keepwell kept <em>{formatMoney(overview.mrrSaved)}</em> a month.
                  </>
                ) : (
                  <>Nothing to report yet.</>
                )}
              </p>
              <p className="lede-sub">
                {overview.saveRate.eligibleSessions === 0
                  ? "No cancel conversations have finished in this period. When a subscriber tries to leave, what happens next is recorded here."
                  : `${overview.saveRate.savedSessions} of ${overview.saveRate.eligibleSessions} subscribers who tried to leave stayed after an offer. Everyone who wanted to cancel could, in one click.`}
              </p>
              <ul className="account">
                <li className="account-hero">
                  <span>Monthly revenue kept</span>
                  <strong>{formatMoney(overview.mrrSaved)}</strong>
                </li>
                <li>
                  <span>Save rate</span>
                  {overview.saveRate.eligibleSessions > 0 && (
                    <small>
                      {overview.saveRate.savedSessions} of {overview.saveRate.eligibleSessions}
                    </small>
                  )}
                  <strong>{formatPercent(rate)}</strong>
                </li>
                <li>
                  <span>Recovered from failed payments</span>
                  <strong>{formatMoney(overview.recoveredRevenue)}</strong>
                </li>
              </ul>
            </section>
          )}
          {overview && (
            <section className="folio reveal" style={{ "--i": 1 } as CSSProperties}>
              <h2>
                How conversations ended <span className="folio-count">{outcomeTotal}</span>
              </h2>
              {outcomeTotal === 0 ? (
                <EmptyState title="No conversations finished in this period." />
              ) : (
                <SegmentedBar
                  label="How conversations ended"
                  parts={[...overview.outcomesByOffer]
                    .sort(
                      (a, b) => Number(a.offer === "none") - Number(b.offer === "none") || b.count - a.count,
                    )
                    .map((row) => ({
                      key: row.offer,
                      label: OFFER_LABELS[row.offer] ?? row.offer,
                      value: row.count,
                      kind: row.offer === "none" ? "left" : "saved",
                    }))}
                />
              )}
            </section>
          )}
          {overview && (
            <section className="folio reveal" style={{ "--i": 2 } as CSSProperties}>
              <h2>
                Why people leave <span className="folio-count">{reasonTotal}</span>
              </h2>
              <RankedBars
                unit="subscribers"
                empty="No reasons recorded in this period."
                rows={overview.outcomesByReason.map((row) => ({
                  key: row.reason,
                  label: REASON_LABELS[row.reason] ?? row.reason,
                  value: row.count,
                }))}
              />
            </section>
          )}
        </div>
        <aside className="daybook-margin" aria-label="Day book">
          <div className="reveal" style={{ "--i": 1 } as CSSProperties}>
            <ChainSeal api={client} />
          </div>
          <section className="reveal" style={{ "--i": 2 } as CSSProperties}>
            <h2 className="margin-title">Day book</h2>
            {events.length === 0 ? (
              <p className="muted margin-empty">Quiet so far. Events appear here the moment they happen.</p>
            ) : (
              <ol className="daybook-feed" aria-live="polite">
                {events.map((event) => {
                  const info = kindInfo(event.type);
                  return (
                    <li key={event.id} data-tone={info.tone}>
                      <time dateTime={event.occurredAt} title={event.occurredAt}>
                        {formatRelative(event.occurredAt)}
                      </time>
                      <span>
                        <StatusBadge tone={info.tone}>{info.label}</StatusBadge>
                        {event.simulated && <Badge>SIMULATED</Badge>}
                      </span>
                      <a href={`#audit?event=${encodeURIComponent(event.id)}`}>Audit trail</a>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "ACTIVE", label: "Active" },
  { value: "SUSPENDED", label: "Paused" },
  { value: "CANCELLED", label: "Cancelled" },
];
const RISK_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "Any risk" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

/** The register: everyone PayPal bills through the merchant, with one subscriber's folio beside it. */
function Subscribers({ api: client, selectedId }: { api: MerchantApi; selectedId?: string }) {
  const [items, setItems] = useState<Awaited<ReturnType<MerchantApi["listSubscriptions"]>> | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [risk, setRisk] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(nextCursor?: string) {
    setLoading(true);
    setError("");
    try {
      const result = await client.listSubscriptions({
        query,
        ...(status && { status: status as MerchantSubscriptionListQuery["status"] }),
        ...(risk && { risk: risk as MerchantSubscriptionListQuery["risk"] }),
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

  // Filters apply as you choose them; typing waits a moment so each keystroke isn't a request.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [client, query, status, risk]);

  return (
    <>
      <PageHeading
        title="Subscribers"
        subtitle="Everyone PayPal bills through you, and what happened with each"
      />
      <div className="register">
        <section className="roll-wrap" aria-label="Subscriber register">
          <label className="find">
            <span className="sr-only">Search subscribers</span>
            <Icon name="subscribers" size={16} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Find by name or PayPal ID"
            />
          </label>
          <div className="toggles" role="group" aria-label="Filter by status">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.label}
                type="button"
                className="toggle"
                aria-pressed={status === filter.value}
                onClick={() => setStatus(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <div className="toggles" role="group" aria-label="Filter by risk">
            {RISK_FILTERS.map((filter) => (
              <button
                key={filter.label}
                type="button"
                className="toggle"
                aria-pressed={risk === filter.value}
                onClick={() => setRisk(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          {error && <ErrorMessage message={error} />}
          {loading && !items && <Loading label="Loading subscribers…" />}
          {items && (
            <ol className="roll" aria-label="Subscribers">
              {items.subscriptions.length === 0 ? (
                <li>
                  <EmptyState title="No subscribers match these filters" />
                </li>
              ) : (
                items.subscriptions.map(({ subscription, risk: score }, index) => (
                  <li
                    key={subscription.id}
                    className="reveal"
                    style={{ "--i": Math.min(index, 8) } as CSSProperties}
                  >
                    <a
                      className="roll-row"
                      href={`#subscribers/${encodeURIComponent(subscription.id)}`}
                      aria-current={selectedId === subscription.id ? "true" : undefined}
                    >
                      <span className="roll-name">{subscription.subscriberFirstName ?? "Subscriber"}</span>
                      <span className="roll-plan">
                        {subscription.planName} ·{" "}
                        {formatMoney(subscription.priceOverride ?? subscription.price)}
                      </span>
                      <span className="roll-status">
                        <StatusBadge tone={statusInfo(subscription.status).tone}>
                          {statusInfo(subscription.status).label}
                        </StatusBadge>
                      </span>
                      <span className="roll-risk">
                        {score ? (
                          <RiskStrip score={score.score} band={score.band} />
                        ) : (
                          <span className="muted">Not scored</span>
                        )}
                      </span>
                    </a>
                  </li>
                ))
              )}
            </ol>
          )}
          <div className="button-row">
            {cursor && (
              <button className="secondary" onClick={() => void load()}>
                First page
              </button>
            )}
            {items?.nextCursor && (
              <button className="secondary" onClick={() => void load(items.nextCursor ?? undefined)}>
                Next page
              </button>
            )}
          </div>
        </section>
        <section className="folio-pane" aria-label="Subscriber folio">
          {selectedId ? (
            <SubscriberFolio key={selectedId} api={client} id={selectedId} />
          ) : (
            <EmptyState title="Open a folio">
              Choose a subscriber from the register to see their plan, every action on their subscription and
              their cancel conversations.
            </EmptyState>
          )}
        </section>
      </div>
    </>
  );
}

/** One subscriber's folio: the account, the actions taken on it, and the conversations held. */
function SubscriberFolio({ api: client, id }: { api: MerchantApi; id: string }) {
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
  if (!detail) return <Loading label="Opening the folio…" />;
  const { subscription } = detail;
  const status = statusInfo(subscription.status);
  return (
    <article className="folio-sheet reveal">
      <header className="folio-head">
        <p className="eyebrow">Folio · {subscription.paypalSubscriptionId}</p>
        <h2 className="folio-name">{subscription.subscriberFirstName ?? "Subscriber"}</h2>
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      </header>
      <ul className="account">
        <li>
          <span>Plan</span>
          <strong>{subscription.planName}</strong>
        </li>
        <li>
          <span>Price</span>
          <strong>{formatMoney(subscription.priceOverride ?? subscription.price)}</strong>
        </li>
        <li>
          <span>Next billing</span>
          <strong>
            {subscription.nextBillingTime ? formatDate(subscription.nextBillingTime) : "Not scheduled"}
          </strong>
        </li>
      </ul>
      <h3 className="folio-section">Actions on the subscription</h3>
      {detail.actions.length === 0 ? (
        <p className="muted">Nothing has been changed on this subscription yet.</p>
      ) : (
        <ul className="minutes">
          {detail.actions.map((action) => (
            <li key={action.id}>
              <span>
                {humanize(action.type)}
                {action.simulated && <Badge>SIMULATED</Badge>}
              </span>
              <StatusBadge tone={actionTone(action.state)}>{humanize(action.state)}</StatusBadge>
              <a href={`#audit?subject=${encodeURIComponent(action.id)}`}>Audit</a>
            </li>
          ))}
        </ul>
      )}
      <h3 className="folio-section">Conversations</h3>
      {detail.sessions.length === 0 ? (
        <p className="muted">This subscriber hasn't opened the cancel conversation.</p>
      ) : (
        detail.sessions.map((session) => (
          <section key={session.id} className="minute-book">
            <p className="minute-head">
              <span>{humanize(session.channel)}</span>
              <StatusBadge
                tone={
                  session.outcome?.startsWith("saved")
                    ? "good"
                    : session.outcome === "cancelled"
                      ? "bad"
                      : "neutral"
                }
              >
                {session.outcome ? humanize(session.outcome) : "In progress"}
              </StatusBadge>
              {session.simulated && <Badge>SIMULATED</Badge>}
            </p>
            <ol className="transcript">
              {condenseTranscript(session.events).map((line, index) => (
                <li key={`${session.id}-${index}`} data-tone={line.tone}>
                  <b>{line.who}</b>
                  <span>{line.text}</span>
                </li>
              ))}
            </ol>
          </section>
        ))
      )}
    </article>
  );
}
type ChainState = {
  head: string | null;
  checked: number | null;
  ok: boolean | null;
  brokenAt: number | null;
};

/** The audit chain's seal: drawn from its head hash, and re-checked on demand. */
function useChain(client: MerchantApi) {
  const [chain, setChain] = useState<ChainState>({ head: null, checked: null, ok: null, brokenAt: null });
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    client
      .audit({})
      .then((page) => {
        if (active) setChain((c) => ({ ...c, head: page.entries[0]?.hash ?? null }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client]);
  async function verify() {
    setVerifying(true);
    setError("");
    try {
      const result = await client.verifyAudit();
      setChain((c) => ({ ...c, ok: result.ok, checked: result.checked, brokenAt: result.brokenAtSeq }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not verify the audit chain.");
    } finally {
      setVerifying(false);
    }
  }
  return { chain, verifying, error, verify };
}

function ChainVerdict({ chain }: { chain: ChainState }) {
  if (chain.ok === null) return <StatusBadge tone="neutral">Not checked this visit</StatusBadge>;
  if (chain.ok) return <StatusBadge tone="good">Chain intact · {chain.checked} entries checked</StatusBadge>;
  return <StatusBadge tone="bad">Broken at entry {chain.brokenAt}</StatusBadge>;
}

/** On the overview: the seal and a link to the record behind it. */
function ChainSeal({ api: client }: { api: MerchantApi }) {
  const { chain, verifying, error, verify } = useChain(client);
  if (!chain.head) return null;
  return (
    <aside className="chain-seal" aria-label="Audit chain">
      <Seal
        root={chain.head}
        caption={`Audit chain${chain.checked ? ` · ${chain.checked} entries` : ""}`}
        broken={chain.ok === false}
        size={190}
      />
      <ChainVerdict chain={chain} />
      <button className="secondary" onClick={() => void verify()} disabled={verifying}>
        {verifying ? "Checking…" : "Verify the chain"}
      </button>
      {error && <p className="muted">{error}</p>}
    </aside>
  );
}

function AuditExplorer({ api: client }: { api: MerchantApi }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [kind, setKind] = useState("");
  const [subject, setSubject] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { chain, verifying, error: verifyError, verify } = useChain(client);
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
  return (
    <>
      <PageHeading title="Audit log" subtitle="Every decision, in an order nobody can quietly rewrite" />
      <section className="panel chain-status">
        {chain.head ? (
          <Seal
            root={chain.head}
            caption={`Audit chain${chain.checked ? ` · ${chain.checked} entries` : ""}`}
            broken={chain.ok === false}
            size={168}
          />
        ) : (
          <div />
        )}
        <div>
          <h2>The record is a chain</h2>
          <p>
            Each entry carries the hash of the one before it. Change or remove any past entry and every later
            hash stops matching, which is what verifying checks. The seal is drawn from the newest hash.
          </p>
          <div className="button-row">
            <button onClick={() => void verify()} disabled={verifying}>
              {verifying ? "Checking the chain…" : "Verify chain"}
            </button>
            <ChainVerdict chain={chain} />
          </div>
          {verifyError && <ErrorMessage message={verifyError} />}
        </div>
      </section>
      <form
        className="filter-bar panel"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label>
          Event kind
          <input
            value={kind}
            onChange={(event) => setKind(event.currentTarget.value)}
            placeholder="offer.accepted"
          />
        </label>
        <label>
          Subject ID
          <input value={subject} onChange={(event) => setSubject(event.currentTarget.value)} />
        </label>
        <button>Filter</button>
      </form>
      {loading && <Loading label="Loading audit entries…" />}
      {error && <ErrorMessage message={error} />}
      {!loading && entries.length === 0 && !error && (
        <EmptyState title="Nothing recorded yet">Decisions appear here as they happen.</EmptyState>
      )}
      <ol className="chain">
        {entries.map((entry) => {
          const info = kindInfo(entry.kind);
          return (
            <li key={`${entry.merchantId}-${entry.seq}`} className="chain-link" data-tone={info.tone}>
              <div className="chain-seq">
                <strong>#{entry.seq}</strong>
                <time dateTime={entry.at} title={entry.at}>
                  {formatDateTime(entry.at)}
                </time>
              </div>
              <div className="chain-body">
                <h3>
                  {info.label}
                  {entry.simulated && <Badge>SIMULATED</Badge>}
                </h3>
                <p>{explainAuditEntry(entry)}</p>
                {typeof entry.payload.policyVersion === "number" && (
                  <p>Policy version {entry.payload.policyVersion}</p>
                )}
                <div className="chain-subjects">
                  {Object.entries(entry.subjectIds).map(([label, value]) => (
                    <span key={label} className="subject-link">
                      {label}: <a href={`#audit?subject=${encodeURIComponent(value)}`}>{value}</a>
                    </span>
                  ))}
                </div>
                <div className="chain-hash" title="Each entry holds the hash of the one before it">
                  <span>
                    <b>prev</b> {entry.prevHash.slice(0, 10)}…
                  </span>
                  <span>
                    <b>hash</b> {entry.hash.slice(0, 10)}…
                  </span>
                  <span>{entry.kind}</span>
                </div>
              </div>
            </li>
          );
        })}
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
  const events = [...(data?.events ?? [])].sort((a, b) => b.startDate.localeCompare(a.startDate));
  return (
    <>
      <PageHeading title="Timeline" subtitle="Each subscriber's story, in order · the last 90 days" />
      {error && <ErrorMessage message={error} />}
      {!data && !error && <Loading label="Loading timeline…" />}
      {data && (
        <section className="panel">
          <TimelineChart data={data} />
        </section>
      )}
      {data && events.length > 0 && (
        <details className="panel">
          <summary>Show as a list ({events.length} events)</summary>
          <ol className="timeline-list">
            {events.map((event) => {
              const info = kindInfo(event.kind);
              return (
                <li key={event.id}>
                  <StatusBadge tone={info.tone}>{info.label}</StatusBadge>
                  <span>
                    {names.get(event.resourceId) ?? "Subscriber"}
                    {event.simulated && <Badge>SIMULATED</Badge>}
                  </span>
                  <time dateTime={event.startDate}>{formatDateTime(event.startDate)}</time>
                  {event.auditSeq ? (
                    <a href={`#audit?seq=${event.auditSeq}`}>Audit #{event.auditSeq}</a>
                  ) : (
                    <span />
                  )}
                </li>
              );
            })}
          </ol>
        </details>
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
      <ol className="entries">
        <li className="entry" data-state={verified ? "done" : "current"}>
          <span className="entry-num" aria-hidden="true">
            1
          </span>
          <div className="entry-body">
            <div className="entry-head">
              <h2>Verify credentials</h2>
              <StatusBadge tone={verified ? "good" : "info"}>{verified ? "Done" : "Next"}</StatusBadge>
            </div>
            <p className="muted">
              Paste the sandbox app's client ID and secret. Keepwell checks them with PayPal and stores them
              encrypted; the secret is never shown again.
            </p>
            <form
              className="onboarding-form"
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
              <div className="button-row">
                <button disabled={busy}>{busy ? "Verifying…" : "Verify and store"}</button>
              </div>
            </form>
          </div>
        </li>
        <li className="entry" data-state={webhook ? "done" : verified ? "current" : "locked"}>
          <span className="entry-num" aria-hidden="true">
            2
          </span>
          <div className="entry-body">
            <div className="entry-head">
              <h2>Register the PayPal webhook</h2>
              <StatusBadge tone={webhook ? "good" : verified ? "info" : "neutral"}>
                {webhook ? "Done" : verified ? "Next" : "Locked"}
              </StatusBadge>
            </div>
            <p className="muted">
              So PayPal tells Keepwell the moment a payment fails or a subscription changes, instead of
              Keepwell having to ask.
            </p>
            <div className="button-row">
              <button
                type="button"
                disabled={!verified || busy || webhook}
                onClick={() => void registerWebhook()}
              >
                {webhook ? "Webhook registered" : "Register webhook"}
              </button>
            </div>
          </div>
        </li>
        <li className="entry" data-state={backfillDone ? "done" : webhook ? "current" : "locked"}>
          <span className="entry-num" aria-hidden="true">
            3
          </span>
          <div className="entry-body">
            <div className="entry-head">
              <h2>Import plans and subscriptions</h2>
              <StatusBadge tone={backfillDone ? "good" : webhook ? "info" : "neutral"}>
                {backfillDone ? "Done" : webhook ? "Next" : "Locked"}
              </StatusBadge>
            </div>
            <p className="muted">
              Pull in your existing plans and subscribers so they appear in the register.
            </p>
            <div className="button-row">
              <button
                type="button"
                disabled={!webhook || busy || backfillDone}
                onClick={() => void backfill()}
              >
                {backfillDone ? "Backfill queued" : "Start backfill"}
              </button>
            </div>
          </div>
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

function Badge({ children }: { children: string }) {
  return <span className="badge">{children}</span>;
}
