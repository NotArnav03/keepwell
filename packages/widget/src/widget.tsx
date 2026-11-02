import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import type { ReasonCategory, SessionStreamEvent } from "@keepwell/contracts";
import { acceptNote, offerHeadline, planLine } from "./format.js";
import { en } from "./strings.js";
import { ApiError, ApiUnreachable, type Transport } from "./transport.js";
import { cancelFailed, cancelling, initialState, offerAction, reduce } from "./state.js";

export interface WidgetProps {
  transport: Transport;
  /** PayPal's own autopay page: the way to cancel that never depends on us (design law 1). */
  autopayUrl: string;
  /** Shown in the L2 shell, when our API can't be reached. */
  supportContact: string | null;
  locale: string;
  onClose: () => void;
  /** Opens PayPal's approval page; returns null when the popup was blocked. */
  openPopup?: (url: string) => PopupHandle | null;
  /** The API's origin: the only one whose "keepwell.revise" message from the return page is believed. */
  apiOrigin?: string;
}

/** What the widget needs of the approval window: to notice the buyer closing it. */
export interface PopupHandle {
  readonly closed: boolean;
}

const FOCUSABLE = "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled])";
const POPUP_POLL_MS = 500;

function defaultPopup(url: string): PopupHandle | null {
  return window.open(url, "keepwell-paypal", "popup,width=480,height=720");
}

export function Widget(props: WidgetProps) {
  const { transport, locale } = props;
  const [state, dispatch] = useReducer(reduce, initialState);
  const [draft, setDraft] = useState("");
  const [cancelError, setCancelError] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [popupClosed, setPopupClosed] = useState(false);
  /** What /v1/revise/return told us when PayPal sent the buyer back ("confirmed", "abandoned", …). */
  const [returned, setReturned] = useState<string | null>(null);
  const popup = useRef<PopupHandle | null>(null);
  const closeStream = useRef<(() => void) | null>(null);
  const opened = useRef(new Set<string>());
  const dialog = useRef<HTMLDivElement>(null);
  const lastSeq = useRef(0);
  lastSeq.current = state.lastSeq;

  const onEvent = (seq: number, event: SessionStreamEvent) => dispatch({ type: "stream", seq, event });

  useEffect(() => {
    let live = true;
    transport.createSession().then(
      (session) => {
        if (!live) return;
        dispatch({ type: "started", session });
        closeStream.current = transport.stream(session.streamUrl, 0, onEvent);
      },
      // Whatever the reason (API down, bad token), the shell still offers PayPal's cancel.
      () => live && dispatch({ type: "offline" }),
    );
    return () => {
      live = false;
      closeStream.current?.();
    };
    // Runs once per open; the transport is fixed for the widget's life.
  }, []);

  // Focus the dialog on open, so keyboard and screen-reader users start inside it.
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, []);

  // A downgrade waits on PayPal's approval page: open it once, in a popup if the browser allows.
  const pending = offerAction(state);
  const approveUrl = pending?.state === "AWAITING_BUYER" ? pending.approveUrl : null;
  useEffect(() => {
    if (approveUrl === null || opened.current.has(approveUrl)) return;
    opened.current.add(approveUrl);
    popup.current = (props.openPopup ?? defaultPopup)(approveUrl);
    setPopupBlocked(popup.current === null);
    setPopupClosed(false);
    setReturned(null);
  }, [approveUrl]);

  // The buyer closing PayPal's window without approving sends us nothing, so watch for it.
  useEffect(() => {
    if (approveUrl === null || popup.current === null) return;
    const timer = setInterval(() => {
      if (popup.current?.closed) {
        setPopupClosed(true);
        clearInterval(timer);
      }
    }, POPUP_POLL_MS);
    return () => clearInterval(timer);
  }, [approveUrl]);

  // The return page tells its opener how PayPal's approval went. The stream stays the source of
  // truth; this only makes the widget react at once.
  const pendingId = useRef<string | null>(null);
  pendingId.current = pending?.id ?? null;
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (props.apiOrigin === undefined || event.origin !== props.apiOrigin) return;
      if (typeof data !== "object" || data === null) return;
      const message = data as { type?: unknown; actionId?: unknown; outcome?: unknown };
      if (message.type !== "keepwell.revise" || message.actionId !== pendingId.current) return;
      if (typeof message.outcome === "string") setReturned(message.outcome);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const session = state.session;
  const sessionId = session?.sessionId ?? null;

  const report = (err: unknown) => {
    if (
      err instanceof ApiError &&
      ["limit_reached", "session_closed", "action_in_progress"].includes(err.code)
    ) {
      dispatch({ type: "input_closed" });
      dispatch({ type: "notice", text: err.code === "limit_reached" ? en.limitReached : null });
    } else if (err instanceof ApiUnreachable || err instanceof ApiError) {
      dispatch({ type: "notice", text: en.error });
    } else {
      throw err;
    }
  };

  const send = (event: Event) => {
    event.preventDefault();
    const text = draft.trim();
    if (sessionId === null || text === "") return;
    setDraft("");
    dispatch({ type: "sent", text });
    transport.message(sessionId, text).catch(report);
  };

  const pickReason = (reason: ReasonCategory) => {
    if (sessionId === null) return;
    dispatch({ type: "sent", text: en.reasons[reason] });
    transport.reason(sessionId, reason).catch(report);
  };

  const accept = () => {
    if (sessionId === null || !state.offer) return;
    dispatch({ type: "answered", answer: "accepted" });
    transport.accept(sessionId, state.offer.offer.id, state.offer.shownTextHash).catch(report);
  };

  const decline = () => {
    if (sessionId === null || !state.offer) return;
    dispatch({ type: "answered", answer: "declined" });
    transport.decline(sessionId, state.offer.offer.id).catch(report);
  };

  const keep = () => {
    if (sessionId !== null) transport.keep(sessionId).catch(report);
  };

  // One click, no confirmation and no AI. After a save the stream had ended, so it is reopened
  // from the last event seen to follow the cancel.
  const cancel = () => {
    if (session === null) return;
    setCancelError(false);
    transport.cancel(session.sessionId).then(
      ({ actionId }) => {
        dispatch({ type: "cancel_requested", actionId });
        if (state.phase === "closed") {
          closeStream.current?.();
          closeStream.current = transport.stream(session.streamUrl, lastSeq.current, onEvent);
        }
      },
      () => setCancelError(true),
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      props.onClose();
      return;
    }
    if (event.key !== "Tab" || !dialog.current) return;
    // Focus trap: Tab and Shift+Tab cycle inside the dialog.
    const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    const active = (dialog.current.getRootNode() as Document | ShadowRoot).activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const cancelled = state.closed?.outcome === "cancelled";
  const showPayPalCancel = state.phase === "offline" || cancelError || cancelFailed(state);
  const offer = state.offer;
  const busy =
    pending !== null &&
    !["APPLIED", "CONFIRMED", "FAILED", "ABANDONED", "SUPERSEDED"].includes(pending.state);
  const offerFailed = pending !== null && ["FAILED", "ABANDONED"].includes(pending.state);
  // While PayPal's approval is pending, say what is known: it came back, was closed, or is open.
  const waitingText =
    pending?.state !== "AWAITING_BUYER"
      ? en.applying
      : returned === "abandoned"
        ? en.approvalAbandoned
        : returned !== null
          ? en.applying
          : popupClosed
            ? `${en.awaitingPayPal} ${en.approvalClosed}`
            : en.awaitingPayPal;
  const canType =
    state.phase === "chat" &&
    !state.inputClosed &&
    state.fallbackLevel === "L0" &&
    offer?.answer !== "accepted";
  const note = offer ? acceptNote(offer.offer) : null;

  return (
    <div class="kw-backdrop">
      <div
        class="kw-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kw-title"
        ref={dialog}
        onKeyDown={onKeyDown}
      >
        <header class="kw-header">
          <div>
            <h2 id="kw-title">{session ? `${session.merchant.name} · ${en.title}` : en.title}</h2>
            {session && <p class="kw-plan">{planLine(session.subscription, locale)}</p>}
          </div>
          <div class="kw-header-actions">
            {!cancelled &&
              (session === null ? (
                <a class="kw-cancel" href={props.autopayUrl} target="_blank" rel="noopener noreferrer">
                  {en.cancelNow}
                </a>
              ) : (
                <button type="button" class="kw-cancel" onClick={cancel} disabled={cancelling(state)}>
                  {cancelling(state) ? en.cancelling : en.cancelNow}
                </button>
              ))}
            <button type="button" class="kw-close" aria-label={en.close} onClick={props.onClose}>
              ×
            </button>
          </div>
        </header>

        {state.phase === "offline" ? (
          <section class="kw-body">
            <p>{en.offline}</p>
            {props.supportContact && (
              <p>
                {en.offlineSupport} {props.supportContact}.
              </p>
            )}
          </section>
        ) : (
          <section class="kw-body">
            <div class="kw-log" role="log" aria-live="polite">
              <p class="kw-line kw-agent">{en.greeting}</p>
              {state.lines.map((line, i) => (
                <p key={i} class={`kw-line kw-${line.role}`}>
                  {line.text}
                </p>
              ))}
            </div>

            {state.chips.length > 0 && !offer && (
              <div class="kw-chips" role="group" aria-label={en.chipsPrompt}>
                {state.chips.map((reason) => (
                  <button type="button" key={reason} onClick={() => pickReason(reason)}>
                    {en.reasons[reason]}
                  </button>
                ))}
              </div>
            )}

            {offer && (
              <div class="kw-offer" aria-label={offerHeadline(offer.offer, locale)}>
                <p class="kw-offer-title">{offerHeadline(offer.offer, locale)}</p>
                <p>{offer.cardText}</p>
                {note && <p class="kw-small">{note}</p>}
                {offer.answer === null && state.phase === "chat" && (
                  <div class="kw-row">
                    <button type="button" class="kw-primary" onClick={accept}>
                      {en.accept}
                    </button>
                    <button type="button" onClick={decline}>
                      {en.decline}
                    </button>
                  </div>
                )}
              </div>
            )}

            {busy && (
              <p class="kw-status" role="status">
                {waitingText}
                {pending.state === "AWAITING_BUYER" &&
                  returned === null &&
                  (popupBlocked || popupClosed) &&
                  pending.approveUrl && (
                    <>
                      {" "}
                      <a href={pending.approveUrl} target="_blank" rel="noopener noreferrer">
                        {popupClosed ? en.openPayPalAgain : en.openPayPal}
                      </a>
                    </>
                  )}
              </p>
            )}
            {offerFailed && state.phase === "chat" && (
              <p role="status">{pending.state === "ABANDONED" ? en.approvalAbandoned : en.offerFailed}</p>
            )}

            {state.closed && (
              <p class="kw-done" role="status">
                {state.closed.summary}
              </p>
            )}

            {canType && (
              <form class="kw-row" onSubmit={send}>
                <label class="kw-sr" for="kw-input">
                  {en.placeholder}
                </label>
                <textarea
                  id="kw-input"
                  maxLength={1000}
                  rows={2}
                  placeholder={en.placeholder}
                  value={draft}
                  onInput={(e) => setDraft(e.currentTarget.value)}
                />
                <button type="submit" disabled={draft.trim() === ""}>
                  {en.send}
                </button>
              </form>
            )}

            {state.phase === "chat" &&
              !busy &&
              (offer?.answer === "declined" || offerFailed || state.inputClosed) && (
                <div class="kw-row">
                  <button type="button" onClick={keep}>
                    {en.keep}
                  </button>
                </div>
              )}
            {state.phase === "closed" && (
              <div class="kw-row">
                <button type="button" onClick={props.onClose}>
                  {en.close}
                </button>
              </div>
            )}
          </section>
        )}

        {state.notice && <p class="kw-notice">{state.notice}</p>}
        {showPayPalCancel && !cancelled && (
          <p class="kw-notice">
            {state.phase === "offline" ? null : en.cancelFailed}{" "}
            <a href={props.autopayUrl} target="_blank" rel="noopener noreferrer">
              {en.cancelInPayPal}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
