import { describe, expect, it } from "vitest";
import { JudgeApiError, JudgeUnreachable, judgeApi } from "./api.js";

const respond = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

function client(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = judgeApi({
    apiBase: "",
    fetch: ((url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(handler(url, init ?? {}));
    }) as typeof fetch,
  });
  return { api, calls };
}

const lease = {
  leaseId: "0199a1b2-0000-7000-8000-0000000000a1",
  leaseToken: "lease-token",
  expiresAt: "2026-11-05T11:00:00.000Z",
  subscriptionId: "0199a1b2-0000-7000-8000-000000000001",
};

describe("judge api client", () => {
  it("leases on its own origin's /v1, and reads pool_empty as an answer, not an error", async () => {
    const ok = client(() => respond(201, lease));
    expect(await ok.api.lease()).toEqual(lease);
    expect(ok.calls[0]).toMatchObject({ url: "/v1/demo/leases", init: { method: "POST" } });

    const empty = client(() => respond(503, { error: { code: "pool_empty", message: "x", requestId: "r" } }));
    expect(await empty.api.lease()).toBe("pool_empty");
  });

  it("sends the lease token for the lease's own routes", async () => {
    const { api, calls } = client((url) =>
      url.endsWith("/token")
        ? respond(200, { token: "w", expiresAt: lease.expiresAt })
        : url.includes("time-machine")
          ? respond(200, { resumed: false, actionId: null, label: "TIME SHIFT", note: "n" })
          : respond(200, { result: "consumed" }),
    );
    expect(await api.widgetToken(lease)).toBe("w");
    expect(await api.resumeNow(lease)).toMatchObject({ resumed: false, label: "TIME SHIFT" });
    expect(await api.release(lease)).toBe("consumed");
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["POST", `/v1/demo/leases/${lease.leaseId}/token`],
      ["POST", `/v1/demo/time-machine/resume/${lease.subscriptionId}`],
      ["DELETE", `/v1/demo/leases/${lease.leaseId}`],
    ]);
    for (const call of calls) expect(call.init.headers).toEqual({ authorization: "Bearer lease-token" });
  });

  it("reports the status page's word, and down when it can't be read", async () => {
    expect(await client(() => respond(200, { status: "degraded" })).api.status()).toBe("degraded");
    expect(await client(() => respond(404)).api.status()).toBe("unknown");
    const broken = judgeApi({ apiBase: "", fetch: () => Promise.reject(new TypeError("Failed to fetch")) });
    expect(await broken.status()).toBe("down");
  });

  it("tells an unreachable API from an error the API gave", async () => {
    const down = judgeApi({ apiBase: "", fetch: () => Promise.reject(new TypeError("Failed to fetch")) });
    await expect(down.lease()).rejects.toBeInstanceOf(JudgeUnreachable);
    const limited = client(() =>
      respond(429, { error: { code: "rate_limited", message: "slow", requestId: "r" } }),
    );
    await expect(limited.api.lease()).rejects.toBeInstanceOf(JudgeApiError);
    await expect(client(() => respond(502)).api.lease()).rejects.toBeInstanceOf(JudgeUnreachable);
  });
});
