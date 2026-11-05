import { useEffect, useRef, useState } from "preact/hooks";
import type { DelegationScope, DelegationSummary, PortalMe, PortalSubscription } from "@keepwell/contracts";
import { PortalApiError, PortalUnreachable, type PortalApi } from "./api.js";
import { text } from "./strings.js";

export interface AppProps {
  api: PortalApi;
  merchantName: string;
  locale: string;
  /** From the verify redirect: `link_expired` when the emailed link was stale. */
  initialError: string | null;
  /** PayPal's own autopay page: the way to cancel that never depends on us. */
  autopayUrl: string;
  /**
   * Opens the widget, full page, in `container` for one subscription. Returns a function that
   * removes it. `onClosed` runs when the subscriber closes it.
   */
  openWidget: (subscriptionId: string, container: HTMLElement, onClosed: () => void) => () => void;
}

type View = { kind: "loading" } | { kind: "signed_out" } | { kind: "signed_in"; me: PortalMe };

export function App(props: AppProps) {
  const { api } = props;
  const [view, setView] = useState<View>({ kind: "loading" });
  const [unreachable, setUnreachable] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const widgetBox = useRef<HTMLDivElement>(null);

  const load = () =>
    api.me().then(
      (me) => {
        setUnreachable(false);
        setView(me === null ? { kind: "signed_out" } : { kind: "signed_in", me });
      },
      (err: unknown) => {
        if (err instanceof PortalUnreachable) setUnreachable(true);
        setView({ kind: "signed_out" });
      },
    );

  useEffect(() => {
    void load();
  }, []);

  // The widget is the page's own conversation, in place; closing it brings the list back up to date.
  useEffect(() => {
    if (managing === null || widgetBox.current === null) return;
    let live = true;
    const close = props.openWidget(managing, widgetBox.current, () => {
      if (!live) return;
      setManaging(null);
      void load();
    });
    return () => {
      live = false;
      close();
    };
  }, [managing]);

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    setManaging(null);
    setView({ kind: "signed_out" });
  };

  return (
    <main>
      {view.kind === "loading" && <p role="status">{text.loading}</p>}
      {view.kind === "signed_out" && (
        <SignIn
          api={api}
          merchantName={props.merchantName}
          initialError={props.initialError}
          unreachable={unreachable}
          autopayUrl={props.autopayUrl}
        />
      )}
      {view.kind === "signed_in" && (
        <>
          <header class="top">
            <h1>{text.signedInTitle}</h1>
            <button type="button" onClick={() => void signOut()}>
              {text.signOut}
            </button>
          </header>
          {view.me.subscriptions.length === 0 && <p>{text.none}</p>}
          {view.me.subscriptions.map((subscription) => (
            <section class="card" key={subscription.id} aria-labelledby={`sub-${subscription.id}`}>
              <h2 id={`sub-${subscription.id}`}>{subscription.planName}</h2>
              <p>
                {priceLine(subscription, props.locale)}
                {subscription.nextBillingTime !== null && (
                  <>
                    {" · "}
                    {text.nextPayment} {formatDate(subscription.nextBillingTime, props.locale)}
                  </>
                )}
                {subscription.status !== "ACTIVE" && <> · {statusLabel(subscription.status)}</>}
              </p>
              <button
                type="button"
                class="primary"
                disabled={managing !== null}
                onClick={() => setManaging(subscription.id)}
              >
                {managing === subscription.id ? text.managing : text.manage}
              </button>
              {managing === subscription.id && <div ref={widgetBox} class="widget-box" />}
              <AssistantAccess
                api={api}
                subscription={subscription}
                delegations={view.me.delegations.filter((d) => d.subscriptionId === subscription.id)}
                locale={props.locale}
                onChanged={() => void load()}
              />
            </section>
          ))}
        </>
      )}
    </main>
  );
}

function SignIn(props: {
  api: PortalApi;
  merchantName: string;
  initialError: string | null;
  unreachable: boolean;
  autopayUrl: string;
}) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(
    props.initialError === "link_expired" ? text.linkExpired : null,
  );

  const submit = (event: Event) => {
    event.preventDefault();
    if (state === "sending" || email.trim() === "") return;
    setState("sending");
    setError(null);
    props.api.requestLink(email.trim()).then(
      // The same words whether or not the address matched: the API doesn't say, so neither do we.
      () => setState("sent"),
      (err: unknown) => {
        setState("idle");
        setError(
          err instanceof PortalApiError && err.status === 429
            ? text.tooMany
            : err instanceof PortalUnreachable
              ? text.unreachable
              : text.error,
        );
      },
    );
  };

  return (
    <>
      <h1>
        {props.merchantName} · {text.signInTitle}
      </h1>
      <p>{text.signInIntro}</p>
      <form onSubmit={submit}>
        <label for="email">{text.emailLabel}</label>
        <input
          id="email"
          type="email"
          autocomplete="email"
          required
          value={email}
          onInput={(e) => setEmail(e.currentTarget.value)}
        />
        <button type="submit" class="primary" disabled={state === "sending"}>
          {state === "sending" ? text.sending : text.sendLink}
        </button>
      </form>
      {state === "sent" && <p role="status">{text.linkSent}</p>}
      {error !== null && <p role="alert">{error}</p>}
      {(props.unreachable || error === text.unreachable) && (
        <p>
          <a href={props.autopayUrl} target="_blank" rel="noopener noreferrer">
            {text.cancelInPayPal}
            <span class="sr"> (opens in a new tab)</span>
          </a>
        </p>
      )}
    </>
  );
}

const SCOPES: DelegationScope[] = ["read", "cancel", "accept_offer"];

function AssistantAccess(props: {
  api: PortalApi;
  subscription: PortalSubscription;
  delegations: DelegationSummary[];
  locale: string;
  onChanged: () => void;
}) {
  const { api, subscription } = props;
  const [chosen, setChosen] = useState<DelegationScope[]>(["read"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Shown once, held only here: leaving the page or pressing "I've saved it" drops it. */
  const [created, setCreated] = useState<{ token: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);

  const toggle = (scope: DelegationScope) =>
    setChosen((now) => (now.includes(scope) ? now.filter((s) => s !== scope) : [...now, scope]));

  const create = (event: Event) => {
    event.preventDefault();
    if (busy || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setCopied(null);
    // In the order the contract lists them, whatever order they were ticked in.
    api
      .createDelegation(
        subscription.id,
        SCOPES.filter((s) => chosen.includes(s)),
      )
      .then(
        (made) => {
          setCreated({ token: made.token, expiresAt: made.expiresAt });
          props.onChanged();
        },
        (err: unknown) =>
          setError(err instanceof PortalApiError && err.status === 429 ? text.tooMany : text.error),
      )
      .finally(() => setBusy(false));
  };

  const revoke = (id: string) => {
    setError(null);
    api.revokeDelegation(id).then(
      () => {
        setNotice(text.revoked);
        props.onChanged();
      },
      () => setError(text.error),
    );
  };

  const copy = (token: string) =>
    navigator.clipboard.writeText(token).then(
      () => setCopied("yes"),
      () => setCopied("failed"),
    );

  return (
    <section class="assistant" aria-labelledby={`assist-${subscription.id}`}>
      <h3 id={`assist-${subscription.id}`}>{text.assistantTitle}</h3>
      <p>{text.assistantIntro}</p>

      {created === null ? (
        <form onSubmit={create}>
          <fieldset>
            <legend>{text.scopesLegend}</legend>
            {SCOPES.map((scope) => (
              <label class="check" key={scope}>
                <input type="checkbox" checked={chosen.includes(scope)} onChange={() => toggle(scope)} />
                {text.scopes[scope]}
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={busy || chosen.length === 0}>
            {busy ? text.creating : text.create}
          </button>
        </form>
      ) : (
        <div class="token" role="group" aria-labelledby={`token-${subscription.id}`}>
          <h4 id={`token-${subscription.id}`}>{text.tokenTitle}</h4>
          <p>{text.tokenWarning}</p>
          <label for={`tok-${subscription.id}`} class="sr">
            {text.tokenLabel}
          </label>
          <input id={`tok-${subscription.id}`} readOnly value={created.token} />
          <p>
            {text.expires} {formatDate(created.expiresAt, props.locale)}
          </p>
          <button type="button" onClick={() => void copy(created.token)}>
            {text.copy}
          </button>
          <button type="button" class="primary" onClick={() => setCreated(null)}>
            {text.saved}
          </button>
          {copied === "yes" && <p role="status">{text.copied}</p>}
          {copied === "failed" && <p role="status">{text.copyFailed}</p>}
        </div>
      )}

      <h4>{text.existingTitle}</h4>
      {props.delegations.length === 0 ? (
        <p>{text.noneActive}</p>
      ) : (
        <ul>
          {props.delegations.map((d) => (
            <li key={d.id}>
              {text.canDo} {d.scopes.map((s) => text.scopes[s].toLowerCase()).join(", ")} · {text.expires}{" "}
              {formatDate(d.expiresAt, props.locale)}{" "}
              <button type="button" onClick={() => revoke(d.id)}>
                {text.revoke}
                <span class="sr"> {d.scopes.join(", ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice !== null && <p role="status">{notice}</p>}
      {error !== null && <p role="alert">{error}</p>}
    </section>
  );
}

function priceLine(subscription: PortalSubscription, locale: string): string {
  const amount = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: subscription.price.currency,
  }).format(Number(subscription.price.value));
  const { unit, count } = subscription.interval;
  const unitName = unit.toLowerCase();
  return count === 1 ? `${amount} / ${unitName}` : `${amount} every ${count} ${unitName}s`;
}

function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
}

function statusLabel(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase().replaceAll("_", " ");
}
