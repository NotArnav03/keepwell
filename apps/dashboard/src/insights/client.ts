import { ErrorEnvelope, OutboxResponse } from "@keepwell/contracts";
import type { ZodType } from "zod";
import { InsightsError, isAbortError } from "./errors.js";
import {
  CopilotRequest,
  CopilotServerEvent,
  INSIGHT_QUOTE_LIMIT,
  InsightActionList,
  InsightActionView,
  InsightsQuery,
  InsightsResponse,
  OUTBOX_PAGE_SIZE,
} from "./schemas.js";
import { createSseParser } from "./sse.js";
import type { SseItem } from "./sse.js";

export interface InsightsTransport {
  fetchRaw(path: string, init: RequestInit): Promise<Response>;
}

const KNOWN_EVENTS = new Set(["tool_call", "tool_result", "delta", "done", "error"]);

const UNREADABLE = "The assistant's reply could not be read.";

export class InsightsClient {
  constructor(private readonly transport: InsightsTransport) {}

  insights(range: { from: string; to: string }, signal?: AbortSignal): Promise<InsightsResponse> {
    const parsed = InsightsQuery.safeParse({ ...range, quotes: INSIGHT_QUOTE_LIMIT });
    if (!parsed.success) {
      return Promise.reject(
        new InsightsError("Choose a start date on or before the end date.", 400, "invalid_request"),
      );
    }
    const params = new URLSearchParams({
      from: parsed.data.from,
      to: parsed.data.to,
      quotes: String(parsed.data.quotes),
    });
    return this.send(`/m/insights?${params}`, { method: "GET", signal }, InsightsResponse);
  }

  actions(signal?: AbortSignal): Promise<InsightActionList> {
    return this.send("/m/insight-actions", { method: "GET", signal }, InsightActionList);
  }

  decide(id: string, decision: "approve" | "reject", signal?: AbortSignal): Promise<InsightActionView> {
    return this.send(
      `/m/insight-actions/${encodeURIComponent(id)}/${decision}`,
      { method: "POST", signal },
      InsightActionView,
    );
  }

  outbox(query: { cursor?: string } = {}, signal?: AbortSignal): Promise<OutboxResponse> {
    const params = new URLSearchParams({ limit: String(OUTBOX_PAGE_SIZE) });
    if (query.cursor) params.set("cursor", query.cursor);
    return this.send(`/m/outbox?${params}`, { method: "GET", signal }, OutboxResponse);
  }

  /**
   * POST the whole transcript and yield events as frames arrive.
   * The caller aborts `signal` on Stop and on unmount.
   */
  async *copilot(
    messages: readonly { role: "user" | "assistant"; text: string }[],
    signal: AbortSignal,
  ): AsyncGenerator<CopilotServerEvent> {
    const parsed = CopilotRequest.safeParse({ messages });
    if (!parsed.success || parsed.data.messages.at(-1)?.role !== "user") {
      throw new InsightsError("The conversation could not be sent.", 400, "invalid_request");
    }
    const response = await this.transportFetch("/m/copilot/messages", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      signal,
      headers: { accept: "text/event-stream" },
    });
    if (!response.ok) throw await errorFrom(response);
    if (!response.body) {
      throw new InsightsError("The assistant did not send a reply.", response.status, "empty");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    try {
      let finished = false;
      while (!finished) {
        const step = await reader.read();
        finished = step.done;
        const chunk = decoder.decode(step.value ?? new Uint8Array(), { stream: !step.done });
        for (const item of parser.push(chunk)) {
          const event = interpret(item);
          if (event === null) continue;
          if (event === "invalid") {
            yield { type: "error", code: "invalid_output", message: UNREADABLE };
            return;
          }
          yield event;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async send<T>(path: string, init: RequestInit, schema: ZodType<T>): Promise<T> {
    const response = await this.transportFetch(path, init);
    if (!response.ok) throw await errorFrom(response);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new InsightsError(
        "The server sent a response we could not read.",
        response.status,
        "invalid_response",
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new InsightsError(
        "The server sent a response we could not read.",
        response.status,
        "invalid_response",
      );
    }
    return parsed.data;
  }

  private async transportFetch(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.transport.fetchRaw(path, init);
    } catch (cause) {
      if (isAbortError(cause)) throw cause;
      throw new InsightsError("Could not reach Keepwell.", 0, "network");
    }
  }
}

function interpret(item: SseItem): CopilotServerEvent | "invalid" | null {
  if (!item.ok) return "invalid";
  const parsed = CopilotServerEvent.safeParse(item.data);
  if (parsed.success) return parsed.data;
  return KNOWN_EVENTS.has(eventType(item)) ? "invalid" : null;
}

function eventType(item: SseItem): string {
  const data = item.data;
  if (typeof data === "object" && data !== null && "type" in data) {
    const value: unknown = data.type;
    if (typeof value === "string") return value;
  }
  return item.event;
}

async function errorFrom(response: Response): Promise<InsightsError> {
  let code = "http_error";
  let message = `Request failed (${response.status})`;
  try {
    const body: unknown = await response.json();
    const parsed = ErrorEnvelope.safeParse(body);
    if (parsed.success) {
      code = parsed.data.error.code;
      message = parsed.data.error.message;
    }
  } catch {
    // Keep the status-based error when the body is not JSON.
  }
  return new InsightsError(message, response.status, code);
}
