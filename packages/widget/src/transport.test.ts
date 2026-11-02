import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStreamEvent } from "@keepwell/contracts";
import { httpTransport } from "./transport.js";

// The stream's reconnecting: EventSource retries a dropped connection itself, but gives up for
// good on an error status (a restarted API that answers 401 or 404), so the transport reopens it.

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState: number = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string; lastEventId: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: URL) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  send(seq: number, event: SessionStreamEvent) {
    this.onmessage?.({ data: JSON.stringify(event), lastEventId: String(seq) });
  }

  /** The browser's own retry (connection dropped): still CONNECTING, so the transport leaves it. */
  drop() {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.();
  }

  /** The browser giving up (an error status): CLOSED. */
  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

const STREAM = "http://localhost:3000/v1/sessions/x/stream";
const delta = (text: string): SessionStreamEvent => ({ type: "agent.delta", text });
const latest = () => {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("No stream opened");
  return source;
};

function stream(afterSeq = 0) {
  const events: [number, SessionStreamEvent][] = [];
  const transport = httpTransport({ apiBase: "http://localhost:3000/v1", token: () => Promise.resolve("t") });
  const close = transport.stream(STREAM, afterSeq, (seq, event) => events.push([seq, event]));
  return { events, close };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("stream", () => {
  it("opens after the given event and passes events on in order", () => {
    const { events } = stream(4);
    expect(latest().url.searchParams.get("after")).toBe("4");
    latest().open();
    latest().send(5, delta("a"));
    latest().send(6, delta("b"));
    expect(events.map(([seq]) => seq)).toEqual([5, 6]);
  });

  it("leaves a dropped connection to the browser, which resumes with Last-Event-ID", () => {
    stream();
    latest().open();
    latest().drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("reopens after the browser gives up, resuming after the last event seen", () => {
    const { events } = stream();
    latest().open();
    latest().send(3, delta("a"));
    latest().fail();
    expect(FakeEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest().url.searchParams.get("after")).toBe("3");
    latest().open();
    latest().send(4, delta("b"));
    expect(events.map(([seq]) => seq)).toEqual([3, 4]);
  });

  it("backs off between attempts, up to 30 seconds, and stops after 8", () => {
    stream();
    const waits: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = FakeEventSource.instances.length;
      latest().fail();
      let waited = 0;
      while (FakeEventSource.instances.length === before) {
        vi.advanceTimersByTime(500);
        waited += 500;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);

    latest().fail();
    vi.advanceTimersByTime(120_000);
    expect(FakeEventSource.instances).toHaveLength(9);
  });

  it("starts the backoff over once a connection works", () => {
    stream();
    latest().fail();
    vi.advanceTimersByTime(1000);
    latest().fail();
    vi.advanceTimersByTime(2000);
    latest().open();
    latest().fail();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("doesn't reopen once the session has closed, or once the caller closed the stream", () => {
    const closed = stream();
    latest().open();
    latest().send(1, { type: "session.closed", outcome: "cancelled", summary: "Cancelled." });
    latest().fail();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);

    const manual = stream();
    latest().fail();
    manual.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(closed.events).toHaveLength(1);
  });

  it("skips events it doesn't know instead of failing", () => {
    const { events } = stream();
    latest().open();
    latest().onmessage?.({ data: JSON.stringify({ type: "from.the.future" }), lastEventId: "1" });
    latest().onmessage?.({ data: "not json", lastEventId: "2" });
    latest().send(3, delta("ok"));
    expect(events.map(([seq]) => seq)).toEqual([3]);
  });
});
