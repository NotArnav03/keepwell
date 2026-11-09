import { describe, expect, it, vi } from "vitest";
import { MerchantApi } from "../api.js";
import { InsightsClient, type InsightsTransport } from "./client.js";
import { InsightsError } from "./errors.js";
import type { CopilotServerEvent } from "./schemas.js";

const insights = {
  range: { from: "2026-10-01", to: "2026-10-31" },
  total: 0,
  byWeek: [],
  byPlan: [],
  byReason: [],
  byOutcome: [],
  topQuotes: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function transport(handler: InsightsTransport["fetchRaw"]): { client: InsightsClient; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const client = new InsightsClient({
    fetchRaw: (path, init) => {
      calls.push(init);
      return handler(path, init);
    },
  });
  return { client, calls };
}

describe("InsightsClient", () => {
  it("requests the insights range and parses the body", async () => {
    let path = "";
    const { client } = transport((next) => {
      path = next;
      return Promise.resolve(jsonResponse(insights));
    });
    const body = await client.insights({ from: "2026-10-01", to: "2026-10-31" });
    expect(path).toBe("/m/insights?from=2026-10-01&to=2026-10-31&quotes=50");
    expect(body.total).toBe(0);
  });

  it("surfaces the error envelope for 401 and 500, and marks 404", async () => {
    const errorResponse = (status: number, code: string, message: string) =>
      jsonResponse({ error: { code, message, requestId: "req-1" } }, status);
    const unauthorized = new InsightsClient({
      fetchRaw: () => Promise.resolve(errorResponse(401, "unauthorized", "Sign in required")),
    });
    const missing = new InsightsClient({
      fetchRaw: () => Promise.resolve(errorResponse(404, "not_found", "Not found")),
    });
    const broken = new InsightsClient({
      fetchRaw: () => Promise.resolve(errorResponse(500, "internal", "Something went wrong on our side")),
    });
    await expect(unauthorized.actions()).rejects.toMatchObject({
      name: "InsightsError",
      status: 401,
      message: "Sign in required",
    });
    await expect(missing.actions()).rejects.toMatchObject({ status: 404, message: "Not found" });
    await expect(broken.actions()).rejects.toMatchObject({
      status: 500,
      message: "Something went wrong on our side",
    });
  });

  it("rejects a malformed success body", async () => {
    const { client } = transport(() => Promise.resolve(jsonResponse({})));
    await expect(client.insights({ from: "2026-10-01", to: "2026-10-31" })).rejects.toBeInstanceOf(
      InsightsError,
    );
  });

  it("rethrows an aborted request", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { client } = transport((_path, init) => {
      if (init.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
      return Promise.reject(new Error("should have aborted"));
    });
    await expect(client.actions(ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("posts the transcript as {role, text} and yields split SSE frames", async () => {
    const encoder = new TextEncoder();
    let body = "";
    const { client } = transport((_path, init) => {
      body = typeof init.body === "string" ? init.body : "";
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: delta\ndata: {"type":"delta","text":"Hi"}\n'));
          controller.enqueue(encoder.encode('\nevent: ping\ndata: {"type":"ping"}\n\n'));
          controller.enqueue(encoder.encode('event: done\ndata: {"type":"done","flagged":false}\n\n'));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    const events: CopilotServerEvent[] = [];
    const signal = new AbortController().signal;
    for await (const event of client.copilot([{ role: "user", text: "Why?" }], signal)) {
      events.push(event);
    }
    expect(JSON.parse(body)).toEqual({ messages: [{ role: "user", text: "Why?" }] });
    expect(events).toEqual([
      { type: "delta", text: "Hi" },
      { type: "done", flagged: false },
    ]);
  });

  it("turns a malformed SSE data frame into an error event", async () => {
    const { client } = transport(() =>
      Promise.resolve(new Response("event: delta\ndata: {not json}\n\n", { status: 200 })),
    );
    const events: CopilotServerEvent[] = [];
    const signal = new AbortController().signal;
    for await (const event of client.copilot([{ role: "user", text: "Why?" }], signal)) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        type: "error",
        code: "invalid_output",
        message: "The assistant's reply could not be read.",
      },
    ]);
  });
});

describe("MerchantApi.fetchRaw", () => {
  it("keeps cookies on every call and the CSRF header on writes", async () => {
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
            user: {
              id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c",
              email: "owner@example.test",
              role: "owner",
            },
            csrfToken,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const api = new MerchantApi("https://keepwell.example/v1", fetcher);
    await api.login({ email: "owner@example.test", password: "not-logged" });
    await api.fetchRaw("/m/insight-actions/abc/approve", { method: "POST" });

    const [url, init] = fetcher.mock.calls[1] ?? [];
    expect(url instanceof URL ? url.href : url).toBe(
      "https://keepwell.example/v1/m/insight-actions/abc/approve",
    );
    expect(init?.credentials).toBe("include");
    expect(init?.headers).toMatchObject({ "x-keepwell-csrf": csrfToken });
  });
});
