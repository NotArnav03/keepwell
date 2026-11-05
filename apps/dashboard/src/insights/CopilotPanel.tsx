import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  appendDelta,
  chatWire,
  failChat,
  finalizeChat,
  INITIAL_CHAT,
  noteTool,
  noteToolResult,
  prepareUserText,
  sendUser,
  stopChat,
  type ChatState,
  type ToolNote,
} from "./chat-model.js";
import type { InsightsClient } from "./client.js";
import { isAbortError, panelFailure } from "./errors.js";
import type { CopilotServerEvent } from "./schemas.js";

export function CopilotPanel({ client }: { client: InsightsClient }) {
  const [state, setState] = useState<ChatState>(INITIAL_CHAT);
  const [input, setInput] = useState("");
  const [composeError, setComposeError] = useState("");
  const stateRef = useRef(state);
  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      runRef.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  function apply(run: number, update: (current: ChatState) => ChatState) {
    if (run !== runRef.current) return;
    const next = update(stateRef.current);
    stateRef.current = next;
    setState(next);
  }

  function stop() {
    runRef.current += 1;
    abortRef.current?.abort();
    const next = stopChat(stateRef.current);
    stateRef.current = next;
    setState(next);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prepared = prepareUserText(input);
    if (!prepared.ok) {
      setComposeError(
        prepared.reason === "empty" ? "Enter a message." : "Messages are limited to 2,000 characters.",
      );
      return;
    }
    setComposeError("");
    setInput("");
    runRef.current += 1;
    const run = runRef.current;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const next = sendUser(stateRef.current, prepared.text);
    stateRef.current = next;
    setState(next);
    void read(run, ctrl);
  }

  async function read(run: number, ctrl: AbortController) {
    try {
      for await (const event of client.copilot(chatWire(stateRef.current.messages), ctrl.signal)) {
        if (run !== runRef.current) return;
        if (event.type === "error") {
          apply(run, (current) => failChat(current, { code: event.code, message: event.message }));
          return;
        }
        apply(run, (current) => applyEvent(current, event));
      }
      apply(run, (current) => (current.streaming ? { ...current, streaming: false } : current));
    } catch (cause) {
      if (run !== runRef.current || isAbortError(cause)) return;
      const failure = panelFailure(cause);
      apply(run, (current) => failChat(current, { code: failure.kind, message: failure.message }));
    }
  }

  const showDraft =
    state.draft !== null &&
    (state.streaming || state.stopped || state.draft.text.length > 0 || state.draft.tools.length > 0);

  return (
    <section className="panel" aria-busy={state.streaming}>
      <h2>Copilot</h2>
      {state.trimmed && (
        <p className="muted" role="status">
          Older messages were removed to stay within the 20-message limit.
        </p>
      )}
      <ol className="transcript" aria-live="polite">
        {state.messages.map((message) => (
          <li key={message.id}>
            <strong>{message.role === "user" ? "You" : "Copilot"}</strong>
            <ToolList tools={message.tools} />
            <p className="ins-plain">{message.text}</p>
            {message.flagged && (
              <p className="notice" role="status">
                Some figures in this reply could not be verified.
              </p>
            )}
            {message.clipped && (
              <p className="muted">
                This reply was shortened to 2,000 characters before it can be sent back.
              </p>
            )}
          </li>
        ))}
        {showDraft && state.draft && (
          <li>
            <strong>Copilot</strong>
            <ToolList tools={state.draft.tools} />
            {state.draft.text ? <p className="ins-plain">{state.draft.text}</p> : null}
            {state.streaming && state.draft.text.length === 0 && (
              <p className="muted">Waiting for the reply…</p>
            )}
            {state.stopped && <p className="muted">Stopped before the reply finished.</p>}
          </li>
        )}
      </ol>
      {state.messages.length === 0 && !state.draft && (
        <p className="muted">Ask about retention. Numbers come from the assistant's tools.</p>
      )}
      {state.error && (
        <p className="notice notice-error" role="alert">
          {state.error.code}: {state.error.message}
        </p>
      )}
      <form
        className="policy-form"
        onSubmit={(event) => {
          onSubmit(event);
        }}
      >
        <label htmlFor="ins-copilot-message">Message</label>
        <textarea
          id="ins-copilot-message"
          className="ins-composer"
          value={input}
          aria-invalid={composeError ? true : undefined}
          onChange={(event) => setInput(event.currentTarget.value)}
        />
        {composeError && (
          <p className="notice notice-error" role="alert">
            {composeError}
          </p>
        )}
        <div className="button-row">
          <button type="submit">Send</button>
          <button type="button" className="secondary" disabled={!state.streaming} onClick={stop}>
            Stop
          </button>
        </div>
      </form>
    </section>
  );
}

function ToolList({ tools }: { tools: ToolNote[] }) {
  if (tools.length === 0) return null;
  return (
    <ul className="muted">
      {tools.map((tool, index) => (
        <li key={`${tool.tool}-${index}`}>
          Looked at: {tool.tool}
          {tool.ok === false ? ". It did not succeed." : ""}
          {tool.proposed ? " A proposal was added to the action queue." : ""}
        </li>
      ))}
    </ul>
  );
}

function applyEvent(state: ChatState, event: Exclude<CopilotServerEvent, { type: "error" }>): ChatState {
  switch (event.type) {
    case "delta":
      return appendDelta(state, event.text);
    case "tool_call":
      return noteTool(state, event.tool);
    case "tool_result":
      return noteToolResult(state, event.tool, event.ok, event.insightActionId !== undefined);
    case "done":
      return finalizeChat(state, event.flagged);
  }
}
