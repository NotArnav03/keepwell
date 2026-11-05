import { COPILOT_MAX_MESSAGES, COPILOT_MAX_TEXT } from "./schemas.js";

export interface ToolNote {
  tool: string;
  ok: boolean | null;
  proposed: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** Full text shown on screen. The copy sent back to the server may be shorter. */
  text: string;
  tools: ToolNote[];
  flagged: boolean;
  clipped: boolean;
}

export interface ChatState {
  messages: ChatMessage[];
  /** Reply in progress. It is not part of `messages`, and not sent back, until the server says done. */
  draft: { text: string; tools: ToolNote[] } | null;
  trimmed: boolean;
  error: { code: string; message: string } | null;
  streaming: boolean;
  stopped: boolean;
}

export const INITIAL_CHAT: ChatState = {
  messages: [],
  draft: null,
  trimmed: false,
  error: null,
  streaming: false,
  stopped: false,
};

export function prepareUserText(
  raw: string,
): { ok: true; text: string } | { ok: false; reason: "empty" | "too_long" } {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > COPILOT_MAX_TEXT) return { ok: false, reason: "too_long" };
  return { ok: true, text };
}

export function clipText(text: string): { text: string; clipped: boolean } {
  if (text.length <= COPILOT_MAX_TEXT) return { text, clipped: false };
  return { text: text.slice(0, COPILOT_MAX_TEXT), clipped: true };
}

/** Drop oldest user/assistant pairs until the list fits the route's 20-message cap. */
export function trimMessages<T extends { role: "user" | "assistant" }>(
  messages: readonly T[],
): { messages: T[]; trimmed: boolean } {
  if (messages.length <= COPILOT_MAX_MESSAGES) return { messages: [...messages], trimmed: false };
  let start = 0;
  let trimmed = false;
  while (messages.length - start > COPILOT_MAX_MESSAGES) {
    const first = messages[start];
    const second = messages[start + 1];
    if (first?.role === "user" && second?.role === "assistant") start += 2;
    else start += 1;
    trimmed = true;
  }
  return { messages: messages.slice(start), trimmed };
}

export function chatWire(messages: readonly ChatMessage[]): { role: "user" | "assistant"; text: string }[] {
  const lines: { role: "user" | "assistant"; text: string }[] = [];
  for (const message of messages) {
    const text = clipText(message.text).text.trim();
    if (!text) continue;
    lines.push({ role: message.role, text });
  }
  return trimMessages(lines).messages;
}

export function sendUser(state: ChatState, text: string): ChatState {
  const messages = [
    ...state.messages,
    { id: crypto.randomUUID(), role: "user" as const, text, tools: [], flagged: false, clipped: false },
  ];
  const trimmed = trimMessages(messages);
  return {
    messages: trimmed.messages,
    draft: { text: "", tools: [] },
    trimmed: state.trimmed || trimmed.trimmed,
    error: null,
    streaming: true,
    stopped: false,
  };
}

export function appendDelta(state: ChatState, text: string): ChatState {
  if (!state.draft) return state;
  return { ...state, draft: { text: state.draft.text + text, tools: state.draft.tools } };
}

export function noteTool(state: ChatState, tool: string): ChatState {
  if (!state.draft) return state;
  return {
    ...state,
    draft: { ...state.draft, tools: [...state.draft.tools, { tool, ok: null, proposed: false }] },
  };
}

export function noteToolResult(state: ChatState, tool: string, ok: boolean, proposed: boolean): ChatState {
  if (!state.draft) return state;
  const tools = state.draft.tools.slice();
  let index = -1;
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const current = tools[i];
    if (current && current.tool === tool && current.ok === null) {
      index = i;
      break;
    }
  }
  if (index >= 0) {
    const current = tools[index];
    if (current) tools[index] = { tool, ok, proposed: current.proposed || proposed };
  } else {
    tools.push({ tool, ok, proposed });
  }
  return { ...state, draft: { ...state.draft, tools } };
}

export function finalizeChat(state: ChatState, flagged: boolean): ChatState {
  const draft = state.draft;
  if (!draft) return { ...state, streaming: false, stopped: false };
  const visible = draft.text;
  const messages =
    visible.trim().length === 0
      ? state.messages
      : [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant" as const,
            text: visible,
            tools: draft.tools,
            flagged,
            clipped: clipText(visible).clipped,
          },
        ];
  const trimmed = trimMessages(messages);
  return {
    messages: trimmed.messages,
    draft: null,
    trimmed: state.trimmed || trimmed.trimmed,
    error: null,
    streaming: false,
    stopped: false,
  };
}

/** Keep the partial reply on screen, but do not add it to the transcript that will be sent back. */
export function failChat(state: ChatState, error: { code: string; message: string }): ChatState {
  return { ...state, error, streaming: false };
}

export function stopChat(state: ChatState): ChatState {
  return { ...state, streaming: false, stopped: true };
}
