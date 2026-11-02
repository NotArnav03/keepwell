import { describe, expect, it } from "vitest";
import {
  CreateDelegationRequest,
  DelegationScope,
  DemoStoreTokenResponse,
  DemoStoreVerifyRequest,
  DemoStoreVerifyResponse,
  MagicLinkRequest,
  PortalClaims,
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

describe("portal identity", () => {
  const subscriptionId = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c";

  it("trims the email in a magic link request and rejects non-emails", () => {
    const padded = { merchantSlug: "pantry-plan", email: "  maya@example.com " };
    expect(MagicLinkRequest.parse(padded).email).toBe("maya@example.com");
    expect(MagicLinkRequest.safeParse({ ...padded, email: "maya" }).success).toBe(false);
    expect(MagicLinkRequest.safeParse({ ...padded, merchantSlug: "" }).success).toBe(false);
  });

  it("accepts each delegation scope once and nothing else", () => {
    expect(DelegationScope.options).toEqual(["read", "cancel", "accept_offer"]);
    expect(CreateDelegationRequest.safeParse({ subscriptionId, scopes: ["read", "cancel"] }).success).toBe(
      true,
    );
    for (const scopes of [[], ["read", "read"], ["admin"]]) {
      expect(CreateDelegationRequest.safeParse({ subscriptionId, scopes }).success).toBe(false);
    }
  });

  it("requires a portal claim to be a portal claim with a sha256 email hash", () => {
    const portal = { kind: "portal", mid: subscriptionId, eh: "a".repeat(64), iat: 1, exp: 2 };
    expect(PortalClaims.safeParse(portal).success).toBe(true);
    expect(PortalClaims.safeParse({ ...portal, kind: "shopper" }).success).toBe(false);
    expect(PortalClaims.safeParse({ ...portal, eh: "maya@example.com" }).success).toBe(false);
  });
});
