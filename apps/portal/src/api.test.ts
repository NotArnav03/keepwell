import { describe, expect, it, vi } from "vitest";
import { PortalApiError, PortalUnreachable, portalApi } from "./api.js";

const respond = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

function client(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(handler(url, init ?? {}));
  });
  const api = portalApi({
    apiBase: "https://api.keepwell.example/",
    merchantSlug: "pantry-plan",
    fetch: fetcher as typeof fetch,
  });
  return { api, calls };
}

const envelope = (code: string, message: string) => ({ error: { code, message, requestId: "r1" } });

describe("portal api client", () => {
  it("sends the cookie on every call, to /v1 on the API", async () => {
    const { api, calls } = client(() => respond(200, { subscriptions: [], delegations: [] }));
    await api.me();
    expect(calls[0]?.url).toBe("https://api.keepwell.example/v1/portal/me");
    expect(calls[0]?.init).toMatchObject({ method: "GET", credentials: "include" });
  });

  it("calls its own origin's /v1 when the API base is empty (the deployed rewrite)", async () => {
    const urls: string[] = [];
    const api = portalApi({
      apiBase: "",
      merchantSlug: "pantry-plan",
      fetch: ((url: string) => {
        urls.push(url);
        return Promise.resolve(respond(202));
      }) as typeof fetch,
    });
    await api.requestLink("maya@example.com");
    expect(urls).toEqual(["/v1/portal/magic-link"]);
  });

  it("treats 401 as signed out, not as an error", async () => {
    const { api } = client(() => respond(401, envelope("unauthorized", "Please sign in")));
    expect(await api.me()).toBeNull();
  });

  it("requests a link for this merchant, and a 202 is all it needs", async () => {
    const { api, calls } = client(() => respond(202));
    await api.requestLink("maya@example.com");
    expect(calls[0]?.url).toBe("https://api.keepwell.example/v1/portal/magic-link");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      merchantSlug: "pantry-plan",
      email: "maya@example.com",
    });
  });

  it("reports a rate limit with how long to wait", async () => {
    const { api } = client(() =>
      respond(429, envelope("rate_limited", "Slow down"), { "retry-after": "120" }),
    );
    await expect(api.requestLink("maya@example.com")).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfter: 120,
    });
  });

  it("returns the widget token, and creates and revokes delegations", async () => {
    const { api, calls } = client((url, init) => {
      if (url.endsWith("/portal/token"))
        return respond(200, { token: "jwt", expiresAt: "2026-11-02T10:10:00Z" });
      if (init.method === "DELETE") return respond(204);
      return respond(201, { id: "d1", token: "kwd_x", scopes: ["read"], expiresAt: "2026-11-09T10:00:00Z" });
    });
    expect(await api.token("sub-1")).toBe("jwt");
    const made = await api.createDelegation("sub-1", ["read"]);
    expect(made.token).toBe("kwd_x");
    await api.revokeDelegation("d/1");
    expect(calls[2]?.url).toBe("https://api.keepwell.example/v1/delegations/d%2F1");
  });

  it("says unreachable for a network failure or a proxy's 502, and an API error for an envelope", async () => {
    const down = portalApi({
      apiBase: "https://api.keepwell.example",
      merchantSlug: "pantry-plan",
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    await expect(down.me()).rejects.toBeInstanceOf(PortalUnreachable);

    const proxy = client(() => respond(502));
    await expect(proxy.api.me()).rejects.toBeInstanceOf(PortalUnreachable);

    const refused = client(() => respond(403, envelope("forbidden", "Not yours")));
    await expect(refused.api.createDelegation("s", ["read"])).rejects.toBeInstanceOf(PortalApiError);
  });

  it("refuses a 200 that isn't the shape it expects", async () => {
    const { api } = client(() => respond(200, { hello: "world" }));
    await expect(api.me()).rejects.toMatchObject({ code: "internal" });
  });
});
