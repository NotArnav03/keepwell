import type {
  ActionError,
  ActionState,
  ActionType,
  CreateSessionResponse,
  FallbackLevel,
  Offer,
  ReasonCategory,
  SessionOutcome,
  SessionStreamEvent,
} from "@keepwell/contracts";

// Everything the widget shows, derived from the session response and the stream. Pure, so the
// rules (one offer, streaming text, cancel always reachable) are tested without a DOM.

export type Phase = "starting" | "chat" | "closed" | "offline";

export interface ChatLine {
  role: "agent" | "subscriber";
  text: string;
}

export interface PresentedOffer {
  offer: Offer;
  cardText: string;
  shownTextHash: string;
  answer: "accepted" | "declined" | null;
}

export interface ActionView {
  type: ActionType;
  state: ActionState;
  approveUrl: string | null;
  error: ActionError | null;
}

export interface WidgetState {
  phase: Phase;
  session: CreateSessionResponse | null;
  fallbackLevel: FallbackLevel;
  lines: ChatLine[];
  /** The agent is mid-reply: its text keeps arriving in the last line. */
  streaming: boolean;
  /** The one offer this session shows. */
  offer: PresentedOffer | null;
  chips: ReasonCategory[];
  actions: Record<string, ActionView>;
  cancelActionId: string | null;
  closed: { outcome: SessionOutcome; summary: string } | null;
  /** Something the subscriber should know went wrong; cancel stays available regardless. */
  notice: string | null;
  /** The input is done: message limit reached, or the session can't take more. */
  inputClosed: boolean;
  lastSeq: number;
}

export type WidgetEvent =
  | { type: "started"; session: CreateSessionResponse }
  | { type: "offline" }
  | { type: "stream"; seq: number; event: SessionStreamEvent }
  | { type: "sent"; text: string }
  | { type: "answered"; answer: "accepted" | "declined" }
  | { type: "cancel_requested"; actionId: string }
  | { type: "notice"; text: string | null }
  | { type: "input_closed" };

export const initialState: WidgetState = {
  phase: "starting",
  session: null,
  fallbackLevel: "L0",
  lines: [],
  streaming: false,
  offer: null,
  chips: [],
  actions: {},
  cancelActionId: null,
  closed: null,
  notice: null,
  inputClosed: false,
  lastSeq: 0,
};

export function reduce(state: WidgetState, event: WidgetEvent): WidgetState {
  switch (event.type) {
    case "started":
      return {
        ...state,
        phase: "chat",
        session: event.session,
        fallbackLevel: event.session.fallbackLevel,
      };
    case "offline":
      // L2: our API is unreachable. The shell still shows a working way to cancel in PayPal.
      return { ...state, phase: "offline", fallbackLevel: "L2", streaming: false };
    case "sent":
      return { ...state, lines: [...state.lines, { role: "subscriber", text: event.text }], notice: null };
    case "answered":
      return state.offer ? { ...state, offer: { ...state.offer, answer: event.answer } } : state;
    case "cancel_requested":
      return { ...state, cancelActionId: event.actionId, notice: null };
    case "notice":
      return { ...state, notice: event.text };
    case "input_closed":
      return { ...state, inputClosed: true };
    case "stream":
      // A reconnect replays from Last-Event-ID; anything already seen is skipped.
      if (event.seq <= state.lastSeq) return state;
      return { ...onStream(state, event.event), lastSeq: event.seq };
  }
}

function onStream(state: WidgetState, event: SessionStreamEvent): WidgetState {
  switch (event.type) {
    case "agent.delta": {
      const last = state.lines.at(-1);
      if (state.streaming && last?.role === "agent") {
        return {
          ...state,
          lines: [...state.lines.slice(0, -1), { role: "agent", text: last.text + event.text }],
        };
      }
      return { ...state, streaming: true, lines: [...state.lines, { role: "agent", text: event.text }] };
    }
    case "agent.done":
      return { ...state, streaming: false };
    case "offer.presented":
      // One offer per session: a second one is never shown, whatever arrives.
      if (state.offer) return state;
      return {
        ...state,
        chips: [],
        offer: {
          offer: event.offer,
          cardText: event.cardText,
          shownTextHash: event.shownTextHash,
          answer: null,
        },
      };
    case "reason.chips":
      return { ...state, chips: event.reasons };
    case "fallback.changed":
      return { ...state, fallbackLevel: event.level };
    case "action.update":
      return {
        ...state,
        actions: {
          ...state.actions,
          [event.actionId]: {
            type: event.actionType,
            state: event.state,
            approveUrl: event.approveUrl,
            error: event.error,
          },
        },
      };
    case "session.closed":
      return {
        ...state,
        phase: "closed",
        streaming: false,
        closed: { outcome: event.outcome, summary: event.summary },
      };
    case "error":
      return { ...state, notice: event.message };
  }
}

/** The Action applying the accepted offer, if any. */
export function offerAction(state: WidgetState): (ActionView & { id: string }) | null {
  for (const [id, action] of Object.entries(state.actions)) {
    if (id !== state.cancelActionId && action.type !== "cancel") return { id, ...action };
  }
  return null;
}

/** The cancel is in PayPal's hands and hasn't finished. */
export function cancelling(state: WidgetState): boolean {
  if (state.cancelActionId === null) return false;
  const action = state.actions[state.cancelActionId];
  return action === undefined || !["APPLIED", "CONFIRMED", "FAILED", "SUPERSEDED"].includes(action.state);
}

/** The cancel failed in PayPal: the subscriber must get a guaranteed path (ARCHITECTURE.md §6.4). */
export function cancelFailed(state: WidgetState): boolean {
  return state.cancelActionId !== null && state.actions[state.cancelActionId]?.state === "FAILED";
}
