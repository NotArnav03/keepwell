import { describe, expect, it } from "vitest";
import {
  DemoStoreTokenResponse,
  DemoStoreVerifyRequest,
  DemoStoreVerifyResponse,
  WidgetTokenClaims,
} from "./identity.js";

const claims = {
  mid: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
  sid: "I-BW452GLLEP1G",
  iat: 1_793_000_000,
  exp: 1_793_000_600,
  nonce: "f".repeat(32),
};

describe("identity contracts", () => {
  it("round-trips widget token claims and rejects a non-PayPal subscription id", () => {
    expect(WidgetTokenClaims.parse(claims)).toEqual(claims);
    expect(
      WidgetTokenClaims.safeParse({ ...claims, sid: "0199a1b2-c3d4-7e5f-8a6b-000000000001" }).success,
    ).toBe(false);
    expect(WidgetTokenClaims.safeParse({ ...claims, nonce: "short" }).success).toBe(false);
  });

  it("round-trips the demo store bodies", () => {
    expect(DemoStoreVerifyRequest.parse({ paypalSubscriptionId: "I-FAKE-PAUSE" })).toEqual({
      paypalSubscriptionId: "I-FAKE-PAUSE",
    });
    expect(DemoStoreVerifyRequest.safeParse({ paypalSubscriptionId: "javascript:1" }).success).toBe(false);
    const verified = {
      paypalSubscriptionId: "I-FAKE-PAUSE",
      status: "ACTIVE",
      planName: "Standard",
      shopperToken: "t",
    };
    expect(DemoStoreVerifyResponse.parse(verified)).toEqual(verified);
    expect(DemoStoreTokenResponse.safeParse({ token: "t", expiresAt: "2026-10-30T10:10:00Z" }).success).toBe(
      true,
    );
  });
});
