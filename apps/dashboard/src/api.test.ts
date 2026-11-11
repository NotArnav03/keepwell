import { afterEach, describe, expect, it, vi } from "vitest";
import { MerchantApi } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MerchantApi", () => {
  it("calls the browser's own fetch the way a browser allows (not as a method of the client)", async () => {
    // A real browser throws "Illegal invocation" when fetch runs with any `this` but the window.
    const browserFetch = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response(JSON.stringify({ subscriptions: [], nextCursor: null })));
    });
    vi.stubGlobal("fetch", browserFetch);
    const api = new MerchantApi("https://keepwell.example/v1");
    await expect(api.listSubscriptions()).resolves.toEqual({ subscriptions: [], nextCursor: null });
    expect(browserFetch).toHaveBeenCalledOnce();
  });

  it("validates queries, uses the v1 route, and includes the merchant cookie", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ subscriptions: [], nextCursor: null }), { status: 200 }),
      );
    const api = new MerchantApi("https://keepwell.example/v1", fetcher);

    await api.listSubscriptions({ query: "Maya", status: "ACTIVE" });

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe(
      "https://keepwell.example/v1/m/subscriptions?query=Maya&status=ACTIVE",
    );
    expect(init?.credentials).toBe("include");
  });

  it("sends a parsed login body and validates returned identity", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          merchant: { id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b", slug: "pantry-plan", name: "Pantry Plan" },
          user: { id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c", email: "owner@example.test", role: "owner" },
          csrfToken: "a-csrf-token-that-is-at-least-thirty-two-characters",
        }),
        { status: 200 },
      ),
    );
    const api = new MerchantApi("https://keepwell.example/v1", fetcher);

    const identity = await api.login({ email: "owner@example.test", password: "not-logged" });

    expect(identity.merchant.name).toBe("Pantry Plan");
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        email: "owner@example.test",
        password: "not-logged",
      }),
    );
  });

  it("surfaces a shared API error without exposing an untyped response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "unauthorized", message: "Sign in required", requestId: "req-1" },
        }),
        { status: 401 },
      ),
    );
    const api = new MerchantApi("https://keepwell.example/v1", fetcher);

    await expect(api.me()).rejects.toMatchObject({
      name: "MerchantApiError",
      code: "unauthorized",
      status: 401,
      message: "Sign in required",
    });
  });

  it("sends the session CSRF token on unsafe requests", async () => {
    const csrfToken = "a-csrf-token-that-is-at-least-thirty-two-characters";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            merchant: {
              id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
              slug: "pantry-plan",
              name: "Pantry Plan",
            },
            user: { id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c", email: "owner@example.test", role: "owner" },
            csrfToken,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new MerchantApi("https://keepwell.example/v1", fetcher);

    await api.login({ email: "owner@example.test", password: "not-logged" });
    await api.logout();

    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ "x-keepwell-csrf": csrfToken });
  });

  it("rejects malformed successful response bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const api = new MerchantApi("https://keepwell.example/v1", fetcher);

    await expect(api.me()).rejects.toThrow();
  });
});

describe("MerchantApi.subscribeToFeed", () => {
  // Enough of EventSource to drive the client: tests open, deliver and refuse streams by hand.
  class FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    static opened: FakeEventSource[] = [];
    readyState = FakeEventSource.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((message: { data: unknown; lastEventId: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(
      readonly url: URL,
      readonly init?: EventSourceInit,
    ) {
      FakeEventSource.opened.push(this);
    }
    close() {
      this.closed = true;
      this.readyState = FakeEventSource.CLOSED;
    }
  }

  const ticketResponse = (n: number) =>
    new Response(
      JSON.stringify({
        streamUrl: `https://api.keepwell.example/v1/m/feed?ticket=t${n}`,
        expiresAt: "2026-11-12T01:00:00.000Z",
      }),
    );
  const event = {
    id: "0199a1b2-c3d4-7e5f-8a6b-000000000e01",
    type: "subscription.status_changed",
    merchantId: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
    occurredAt: "2026-11-12T00:00:00.000Z",
    simulated: false,
    payload: {},
  };

  it("opens the stream on the API's own host with a ticket, not through the rewrite or with the cookie", async () => {
    FakeEventSource.opened = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(ticketResponse(1));
    const api = new MerchantApi("https://dashboard.keepwell.example/v1", fetcher);
    const stop = api.subscribeToFeed(() => {});
    await vi.waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe("https://dashboard.keepwell.example/v1/m/feed/ticket");
    expect(init?.method).toBe("POST");
    const source = FakeEventSource.opened[0];
    expect(source?.url.href).toBe("https://api.keepwell.example/v1/m/feed?ticket=t1");
    expect(source?.init?.withCredentials).toBeFalsy();
    stop();
    expect(source?.closed).toBe(true);
  });

  it("asks for a new ticket once the stream is refused, and resumes after the last event", async () => {
    vi.useFakeTimers();
    try {
      FakeEventSource.opened = [];
      vi.stubGlobal("EventSource", FakeEventSource);
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(ticketResponse(1))
        .mockResolvedValueOnce(ticketResponse(2));
      const api = new MerchantApi("https://dashboard.keepwell.example/v1", fetcher);
      const seen: unknown[] = [];
      const stop = api.subscribeToFeed((e) => seen.push(e));
      await vi.waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
      const first = FakeEventSource.opened[0];
      first?.onmessage?.({ data: JSON.stringify(event), lastEventId: event.id });
      expect(seen).toHaveLength(1);

      // A network blip: EventSource is reconnecting by itself, so no new ticket.
      if (first) first.readyState = FakeEventSource.CONNECTING;
      first?.onerror?.();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Refused (an expired ticket): EventSource gives up, so the client asks again and resumes.
      if (first) first.readyState = FakeEventSource.CLOSED;
      first?.onerror?.();
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(FakeEventSource.opened).toHaveLength(2));
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(FakeEventSource.opened[1]?.url.href).toBe(
        `https://api.keepwell.example/v1/m/feed?ticket=t2&after=${event.id}`,
      );
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
