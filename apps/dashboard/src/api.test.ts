import { describe, expect, it, vi } from "vitest";
import { MerchantApi } from "./api.js";

describe("MerchantApi", () => {
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

  it("rejects malformed successful response bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const api = new MerchantApi("https://keepwell.example/v1", fetcher);

    await expect(api.me()).rejects.toThrow();
  });
});
