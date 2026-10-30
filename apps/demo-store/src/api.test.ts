import { describe, expect, it, vi } from "vitest";
import { StoreApiError, verifySubscription, widgetToken } from "./api.js";

const API = "http://localhost:3000";
const ok = (body: object) => new Response(JSON.stringify(body), { status: 200 });
const fail = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: code, requestId: "r1" } }), { status });
const verified = {
  paypalSubscriptionId: "I-MAYA0001",
  status: "ACTIVE",
  planName: "Standard",
  shopperToken: "s",
};

describe("verifySubscription", () => {
  it("posts the subscription id to Pantry Plan's backend", async () => {
    const fetch = vi.fn(() => Promise.resolve(ok(verified)));
    await expect(verifySubscription(API, "I-MAYA0001", { fetch })).resolves.toEqual(verified);
    expect(fetch).toHaveBeenCalledWith(
      `${API}/v1/demo-store/subscriptions`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("waits out APPROVAL_PENDING and a slow PayPal, then succeeds", async () => {
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(fail(409, "not_active"))
      .mockResolvedValueOnce(fail(503, "paypal_unavailable"))
      .mockResolvedValueOnce(ok(verified));
    await expect(verifySubscription(API, "I-MAYA0001", { fetch, delayMs: 1 })).resolves.toEqual(verified);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("gives up after its attempts, and never retries a refusal", async () => {
    const pending = vi.fn(() => Promise.resolve(fail(409, "not_active")));
    await expect(
      verifySubscription(API, "I-X", { fetch: pending, attempts: 2, delayMs: 1 }),
    ).rejects.toMatchObject({
      code: "not_active",
    });
    expect(pending).toHaveBeenCalledTimes(2);

    const wrongPlan = vi.fn(() => Promise.resolve(fail(409, "unknown_plan")));
    await expect(verifySubscription(API, "I-X", { fetch: wrongPlan, delayMs: 1 })).rejects.toBeInstanceOf(
      StoreApiError,
    );
    expect(wrongPlan).toHaveBeenCalledTimes(1);
  });
});

describe("widgetToken", () => {
  it("returns the token, or a 401 the account page signs out on", async () => {
    const good = vi.fn(() => Promise.resolve(ok({ token: "t", expiresAt: "2026-10-30T10:10:00.000Z" })));
    await expect(widgetToken(API, "s", good)).resolves.toMatchObject({ token: "t" });
    const expired = vi.fn(() => Promise.resolve(fail(401, "unauthorized")));
    await expect(widgetToken(API, "s", expired)).rejects.toMatchObject({ status: 401 });
  });
});
