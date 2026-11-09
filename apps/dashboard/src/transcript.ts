import type { SessionStreamEvent } from "@keepwell/contracts";
import { humanize, type Tone } from "./fmt.js";

// A session's stream is a log of small events: a reply arrives word by word. The folio shows it as
// minutes: what the assistant said, what was offered, what happened to the subscription.

export interface TranscriptLine {
  who: string;
  text: string;
  tone: Tone;
}

export function condenseTranscript(events: readonly SessionStreamEvent[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let reply = "";
  const flush = (): void => {
    const text = reply.replace(/\s+/g, " ").trim();
    if (text) lines.push({ who: "Assistant", text, tone: "neutral" });
    reply = "";
  };
  const seenActions = new Set<string>();
  for (const event of events) {
    switch (event.type) {
      case "agent.delta":
        reply += event.text;
        break;
      case "agent.done":
        flush();
        break;
      case "reason.chips":
        flush();
        lines.push({
          who: "Asked",
          text: "The subscriber was asked why they were leaving.",
          tone: "neutral",
        });
        break;
      case "offer.presented":
        flush();
        lines.push({ who: "Offer shown", text: event.cardText, tone: "info" });
        break;
      case "fallback.changed":
        flush();
        lines.push({
          who: "Fallback",
          text: `The conversation moved to fixed choices (${event.level}). Cancelling was unaffected.`,
          tone: "warn",
        });
        break;
      case "action.update": {
        flush();
        const key = `${event.actionId}:${event.state}`;
        if (seenActions.has(key)) break;
        seenActions.add(key);
        const failed = event.error ? ` (${event.error.message})` : "";
        lines.push({
          who: "PayPal",
          text: `${humanize(event.actionType)} · ${humanize(event.state)}${failed}`,
          tone: event.error
            ? "bad"
            : event.state === "CONFIRMED" || event.state === "APPLIED"
              ? "good"
              : "info",
        });
        break;
      }
      case "session.closed":
        flush();
        lines.push({
          who: "Outcome",
          text: event.summary,
          tone: event.outcome.startsWith("saved") ? "good" : "neutral",
        });
        break;
      case "error":
        flush();
        lines.push({ who: "Notice", text: `${event.code}: ${event.message}`, tone: "bad" });
        break;
    }
  }
  flush();
  return lines;
}
