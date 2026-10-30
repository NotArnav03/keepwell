import type {
  AcceptOfferResponse,
  CancelResponse,
  CreateSessionResponse,
  ReasonCategory,
  SessionStreamEvent,
} from "@keepwell/contracts";

// How the widget talks to the sessions API (CONTRACTS.md §4). The UI only sees this interface,
// so tests swap in a fake and the portal can reuse it.
//
// Types only from @keepwell/contracts: its zod schemas alone are ~100 KB gzipped, twice the
// widget's budget. The API validates every response and stream event with zod before sending
// it, so the widget checks just enough shape to never act on garbage.

const STREAM_TYPES = new Set<string>([
  "agent.delta",
  "agent.done",
  "offer.presented",
  "reason.chips",
  "fallback.changed",
  "action.update",
  "session.closed",
  "error",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function expect<T>(value: unknown, keys: string[], what: string): T {
  if (!isRecord(value) || keys.some((key) => !(key in value))) {
    throw new ApiError("internal", `Unexpected ${what} from the API`, 200);
  }
  return value as T;
}

/** A stream event this widget knows, or null to skip it (a newer API may send more types). */
export function readStreamEvent(data: string): SessionStreamEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  return isRecord(value) && typeof value.type === "string" && STREAM_TYPES.has(value.type)
    ? (value as SessionStreamEvent)
    : null;
}

export interface Transport {
  createSession(): Promise<CreateSessionResponse>;
  message(sessionId: string, text: string): Promise<void>;
  reason(sessionId: string, reason: ReasonCategory): Promise<void>;
  accept(sessionId: string, offerId: string, shownTextHash: string): Promise<AcceptOfferResponse>;
  decline(sessionId: string, offerId: string): Promise<void>;
  keep(sessionId: string): Promise<void>;
  cancel(sessionId: string, reason?: ReasonCategory): Promise<CancelResponse>;
  /** Opens the stream after `afterSeq`; returns a function that closes it. */
  stream(
    streamUrl: string,
    afterSeq: number,
    onEvent: (seq: number, event: SessionStreamEvent) => void,
  ): () => void;
}

/** The API answered with an error envelope. `code` is a SessionErrorCode. */
export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The API couldn't be reached at all: the widget falls back to its L2 shell. */
export class ApiUnreachable extends Error {
  override readonly name = "ApiUnreachable";
}

export interface HttpTransportOptions {
  /** e.g. https://api.keepwell.example (no trailing /v1). */
  apiBase: string;
  /** The signed subscriber token for this subscription, fetched once per open. */
  token: () => Promise<string>;
  fetch?: typeof fetch;
}

export function httpTransport(options: HttpTransportOptions): Transport {
  const base = options.apiBase.replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  let token: Promise<string> | null = null;

  async function call(path: string, body?: object): Promise<unknown> {
    token ??= options.token();
    let res: Response;
    try {
      res = await doFetch(`${base}/v1${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new ApiUnreachable(err instanceof Error ? err.message : "Network error");
    }
    if (res.status === 202 || res.status === 204) return undefined;
    const data: unknown = await res.json().catch(() => null);
    if (res.ok) return data;
    const error = isRecord(data) && isRecord(data.error) ? data.error : null;
    // A proxy's 502 page or a crashed process: treat it as the API being down.
    if (error === null && res.status >= 500) throw new ApiUnreachable(`HTTP ${res.status}`);
    const code = typeof error?.code === "string" ? error.code : "internal";
    const message = typeof error?.message === "string" ? error.message : `HTTP ${res.status}`;
    throw new ApiError(code, message, res.status);
  }

  const session = (id: string) => `/sessions/${encodeURIComponent(id)}`;

  return {
    async createSession() {
      const data = await call("/sessions", { channel: "widget" });
      return expect<CreateSessionResponse>(
        data,
        ["sessionId", "streamUrl", "subscription", "merchant"],
        "session",
      );
    },
    async message(id, text) {
      await call(`${session(id)}/messages`, { text });
    },
    async reason(id, reason) {
      await call(`${session(id)}/reason`, { reason });
    },
    async accept(id, offerId, shownTextHash) {
      const data = await call(`${session(id)}/offers/${encodeURIComponent(offerId)}/accept`, {
        shownTextHash,
      });
      return expect<AcceptOfferResponse>(data, ["actionIds", "approveUrl"], "accept response");
    },
    async decline(id, offerId) {
      await call(`${session(id)}/offers/${encodeURIComponent(offerId)}/decline`);
    },
    async keep(id) {
      await call(`${session(id)}/keep`);
    },
    async cancel(id, reason) {
      const data = await call(`${session(id)}/cancel`, reason === undefined ? {} : { reason });
      return expect<CancelResponse>(data, ["actionId"], "cancel response");
    },
    stream(streamUrl, afterSeq, onEvent) {
      const url = new URL(streamUrl);
      if (afterSeq > 0) url.searchParams.set("after", String(afterSeq));
      // EventSource sends Last-Event-ID itself when it reconnects.
      const source = new EventSource(url);
      source.onmessage = (message: MessageEvent<string>) => {
        const event = readStreamEvent(message.data);
        // An event this widget version doesn't know is skipped, not fatal.
        if (event === null) return;
        onEvent(Number(message.lastEventId), event);
        if (event.type === "session.closed") source.close();
      };
      return () => source.close();
    },
  };
}
