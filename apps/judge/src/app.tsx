import { useEffect, useRef, useState } from "preact/hooks";
import { JudgeApiError, JudgeUnreachable, type Health, type JudgeApi, type Lease } from "./api.js";

// Judge Mode (ARCHITECTURE.md §6.17, #39): a stranger with no context tries Keepwell in two
// minutes. Lease a pooled, already-approved sandbox subscription, run one of three scenarios in
// the real widget, use the time machine, and hand it back. If the pool is empty or the API is
// down, the page says so and shows the fully real path (Pantry Plan) instead of a blank page.

export interface JudgeConfig {
  storeUrl: string;
  dashboardUrl: string | null;
  evalsUrl: string | null;
  buyerEmail: string | null;
  buyerPassword: string | null;
}

export interface AppProps {
  api: JudgeApi;
  config: JudgeConfig;
  /** Opens the widget for the leased subscription. Returns a function that closes it. */
  openWidget: (lease: Lease, onClosed: () => void) => () => void;
  locale: string;
}

type ScenarioId = "pause" | "downgrade" | "cancel";

const SCENARIOS: { id: ScenarioId; title: string; say: string; expect: string }[] = [
  {
    id: "pause",
    title: "Pause instead of cancelling",
    say: "I'm travelling for the next two months.",
    expect:
      "Keepwell offers a pause. Accept it and PayPal suspends the subscription. Then use Resume now (a TIME SHIFT) to bring billing back without waiting.",
  },
  {
    id: "downgrade",
    title: "Switch to a cheaper plan",
    say: "It's a bit too expensive for me.",
    expect:
      "Keepwell offers the Lite plan. PayPal asks you to approve the change on its own page: log in with the sandbox buyer below.",
  },
  {
    id: "cancel",
    title: "Honest cancel",
    say: "Just cancel it, please.",
    expect: "No pressure and no second offer. Cancel now is one click, and PayPal cancels the subscription.",
  },
];

type Fallback = "pool_empty" | "unreachable" | null;

export function App(props: AppProps) {
  const { api, config } = props;
  const [health, setHealth] = useState<Health | null>(null);
  const [lease, setLease] = useState<Lease | null>(null);
  const [busy, setBusy] = useState(false);
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [fallback, setFallback] = useState<Fallback>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeWidget = useRef<(() => void) | null>(null);

  useEffect(() => {
    void api.status().then(setHealth);
  }, []);

  // A lease ends on its own; when it has, forget it so the next scenario leases afresh.
  useEffect(() => {
    if (lease === null) return;
    const left = new Date(lease.expiresAt).getTime() - Date.now();
    const timer = setTimeout(
      () => {
        closeWidget.current?.();
        setLease(null);
        setNotice(
          "Your 30 minutes are up; the subscription went back to the pool. Start another scenario any time.",
        );
      },
      Math.max(0, left),
    );
    return () => clearTimeout(timer);
  }, [lease]);

  const open = (current: Lease) => {
    closeWidget.current?.();
    setWidgetOpen(true);
    closeWidget.current = props.openWidget(current, () => {
      closeWidget.current = null;
      setWidgetOpen(false);
    });
  };

  const fail = (err: unknown) => {
    if (err instanceof JudgeUnreachable) setFallback("unreachable");
    else if (err instanceof JudgeApiError && err.status === 401) {
      // The lease ended (its 30 minutes, or it was returned): forget it, as on expiry.
      closeWidget.current?.();
      setLease(null);
      setNotice("That lease has ended. Start any scenario for a fresh subscription.");
    } else if (err instanceof JudgeApiError && err.code === "rate_limited") setError(err.message);
    else setError("Something went wrong. Try again, or use the Pantry Plan store below.");
  };

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // A scenario runs on a fresh subscription: the last one may be cancelled or on another plan.
      if (lease !== null) await api.release(lease).catch(() => undefined);
      const leased = await api.lease();
      if (leased === "pool_empty") {
        setLease(null);
        setFallback("pool_empty");
        return;
      }
      setFallback(null);
      setLease(leased);
      open(leased);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const resumeNow = async () => {
    if (lease === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.resumeNow(lease);
      setNotice(result.note);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const giveBack = async () => {
    if (lease === null || busy) return;
    setBusy(true);
    try {
      closeWidget.current?.();
      const result = await api.release(lease);
      setLease(null);
      setNotice(
        result === "consumed"
          ? "Thanks. That subscription was cancelled or changed plan, so it stays out of the pool."
          : "Thanks. The subscription is back in the pool for the next judge.",
      );
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const until = lease
    ? new Intl.DateTimeFormat(props.locale, { timeStyle: "short" }).format(new Date(lease.expiresAt))
    : null;

  return (
    <main>
      <header class="top">
        <h1>Keepwell · Judge Mode</h1>
        <p class={`health health-${health ?? "unknown"}`} role="status">
          {healthText(health)}
        </p>
      </header>
      <p class="intro">
        Keepwell is an honest retention agent for PayPal Subscriptions. When a subscriber wants to cancel, it
        listens, makes at most one fair offer from the merchant's policy, and cancelling is always one click.
        Everything here runs on PayPal's sandbox with test money.
      </p>

      {fallback !== null && (
        <section class="card fallback" role="alert" aria-labelledby="fallback-title">
          <h2 id="fallback-title">
            {fallback === "pool_empty"
              ? "Every demo subscription is in use right now"
              : "We can't reach the Keepwell API right now"}
          </h2>
          <p>You can still try the fully real path, start to finish:</p>
          <ol>
            <li>
              Open the <a href={config.storeUrl}>Pantry Plan demo store</a> and subscribe with the sandbox
              buyer below.
            </li>
            <li>On the account page, press Cancel subscription and talk to Keepwell.</li>
          </ol>
          {fallback === "pool_empty" && <p>Or try again in a few minutes: leases last 30 minutes.</p>}
        </section>
      )}

      <section aria-labelledby="scenarios-title">
        <h2 id="scenarios-title">Try it in two minutes</h2>
        <p>
          Each scenario gives you your own sandbox subscription for 30 minutes and opens the same widget a
          merchant's customers see.
        </p>
        <div class="scenarios">
          {SCENARIOS.map((s) => (
            <article class="card" key={s.id} aria-labelledby={`s-${s.id}`}>
              <h3 id={`s-${s.id}`}>{s.title}</h3>
              <p>
                <strong>Say:</strong> “{s.say}”
              </p>
              <p>{s.expect}</p>
              <button
                type="button"
                class="primary"
                disabled={busy || widgetOpen}
                onClick={() => void start()}
              >
                Try: {s.title}
              </button>
            </article>
          ))}
        </div>
      </section>

      {lease !== null && (
        <section class="card lease" aria-labelledby="lease-title">
          <h2 id="lease-title">Your demo subscription</h2>
          <p>Yours until {until}. Then it goes back to the pool on its own.</p>
          <div class="row">
            <button type="button" disabled={busy || widgetOpen} onClick={() => open(lease)}>
              Open the widget again
            </button>
            <button type="button" disabled={busy} onClick={() => void resumeNow()}>
              Resume now <span class="badge">TIME SHIFT</span>
            </button>
            <button type="button" disabled={busy} onClick={() => void giveBack()}>
              I'm done: return it
            </button>
          </div>
          <p class="small">
            Resume now runs a paused subscription's scheduled resume today instead of on its date. The
            reactivation is a real PayPal call; the shift in time is ours, so the merchant's audit log marks
            it TIME SHIFT and SIMULATED.
          </p>
        </section>
      )}

      {notice !== null && (
        <p class="notice" role="status">
          {notice}
        </p>
      )}
      {error !== null && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      <section aria-labelledby="creds-title">
        <h2 id="creds-title">Test credentials</h2>
        {config.buyerEmail && config.buyerPassword ? (
          <dl class="creds">
            <dt>PayPal sandbox buyer</dt>
            <dd>
              <code>{config.buyerEmail}</code>
            </dd>
            <dt>Password</dt>
            <dd>
              <code>{config.buyerPassword}</code>
            </dd>
          </dl>
        ) : (
          <p>The sandbox buyer's login is in the submission's testing instructions.</p>
        )}
        <p class="small">Sandbox only: test money, no real accounts or payments.</p>
      </section>

      <section aria-labelledby="more-title">
        <h2 id="more-title">See more</h2>
        <ul>
          <li>
            <a href={config.storeUrl}>Pantry Plan, the demo store</a>: subscribe for real in the sandbox, then
            cancel.
          </li>
          {config.dashboardUrl && (
            <li>
              <a href={config.dashboardUrl}>The merchant's dashboard</a>: every session, offer, consent record
              and audit entry.
            </li>
          )}
          {config.evalsUrl && (
            <li>
              <a href={config.evalsUrl}>The agent's eval scoreboard</a>: how often it stays honest under
              pressure.
            </li>
          )}
        </ul>
      </section>
    </main>
  );
}

function healthText(health: Health | null): string {
  switch (health) {
    case null:
      return "Checking status…";
    case "operational":
      return "All systems operational";
    case "degraded":
      return "Running, some parts slow";
    case "down":
      return "Having trouble right now";
    case "unknown":
      return "Status unavailable";
  }
}
