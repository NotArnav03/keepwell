import { describe, expect, it } from "vitest";
import {
  MerchantApiKeyListResponse,
  MerchantCreateApiKeyRequest,
  MerchantCreateApiKeyResponse,
  MerchantAuditQuery,
  MerchantFeedEvent,
  MerchantLoginRequest,
  MerchantOnboardingCredentialsRequest,
  MerchantOnboardingCredentialsResponse,
  MerchantOverviewQuery,
  MerchantOverviewResponse,
  MerchantSubscriptionListResponse,
  MerchantSubscriptionListQuery,
  MerchantTimelineQuery,
} from "./merchant.js";
import { pantryPlanSubscription } from "../fakes/pantry-plan.js";

describe("merchant API contracts", () => {
  it("requires a valid login email and preserves passwords exactly", () => {
    expect(MerchantLoginRequest.parse({ email: "owner@example.test", password: " pass " })).toEqual({
      email: "owner@example.test",
      password: " pass ",
    });
    expect(MerchantLoginRequest.safeParse({ email: "not-an-email", password: "secret" }).success).toBe(false);
    expect(
      MerchantLoginRequest.safeParse({
        email: "owner@example.test",
        password: "secret",
        merchantId: "untrusted-tenant",
      }).success,
    ).toBe(false);
  });

  it("accepts only documented subscription list filters", () => {
    expect(MerchantSubscriptionListQuery.parse({ query: "Maya", status: "ACTIVE" })).toEqual({
      query: "Maya",
      status: "ACTIVE",
    });
    expect(MerchantSubscriptionListQuery.safeParse({ status: "UNKNOWN" }).success).toBe(false);
    expect(MerchantSubscriptionListQuery.safeParse({ page: 4 }).success).toBe(false);
  });

  it("validates audit filters and UTC timeline boundaries", () => {
    expect(MerchantAuditQuery.safeParse({ kind: "action.confirmed", subject: "sub-1" }).success).toBe(true);
    expect(MerchantAuditQuery.safeParse({ kind: "Not a kind" }).success).toBe(false);
    expect(
      MerchantTimelineQuery.safeParse({
        from: "2026-11-01T00:00:00Z",
        to: "2026-11-02T00:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      MerchantTimelineQuery.safeParse({
        from: "2026-11-01T00:00:00-07:00",
        to: "2026-11-02T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("round-trips KPI, feed, subscriber, onboarding and API-key payloads", () => {
    const from = "2026-11-01T00:00:00Z";
    const to = "2026-11-03T00:00:00Z";
    const overview = {
      from,
      to,
      mrrSaved: { value: "24.00", currency: "USD" },
      saveRate: { savedSessions: 2, eligibleSessions: 5 },
      recoveredRevenue: { value: "12.00", currency: "USD" },
      outcomesByOffer: [{ offer: "pause" as const, count: 2 }],
      outcomesByReason: [{ reason: "price" as const, count: 3 }],
    };
    expect(MerchantOverviewQuery.parse({ from, to })).toEqual({ from, to });
    expect(MerchantOverviewResponse.parse(overview)).toEqual(overview);
    expect(
      MerchantOverviewResponse.safeParse({
        ...overview,
        saveRate: { savedSessions: -1, eligibleSessions: 0 },
      }).success,
    ).toBe(false);

    const subscription = pantryPlanSubscription(new Date(to));
    expect(
      MerchantSubscriptionListResponse.parse({
        subscriptions: [{ subscription, risk: { score: 30, band: "medium" } }],
        nextCursor: null,
      }).subscriptions[0]?.subscription.id,
    ).toBe(subscription.id);
    expect(MerchantSubscriptionListQuery.parse({ risk: "high" }).risk).toBe("high");

    expect(
      MerchantFeedEvent.parse({
        id: "0199a1b2-c3d4-7e5f-8a6b-000000000003",
        merchantId: subscription.merchantId,
        type: "subscription.synced",
        occurredAt: to,
        simulated: false,
        payload: { subscriptionId: subscription.id, snapshot: subscription },
      }).type,
    ).toBe("subscription.synced");

    expect(
      MerchantOnboardingCredentialsRequest.parse({ clientId: "sandbox-client", clientSecret: " exact " })
        .clientSecret,
    ).toBe(" exact ");
    expect(
      MerchantOnboardingCredentialsResponse.parse({ verified: true, clientIdSuffix: "1234", storedAt: to }),
    ).toEqual({ verified: true, clientIdSuffix: "1234", storedAt: to });
    expect(
      MerchantOnboardingCredentialsResponse.safeParse({
        verified: true,
        clientIdSuffix: "1234",
        storedAt: to,
        clientSecret: "must-not-return",
      }).success,
    ).toBe(false);

    const key = {
      id: "0199a1b2-c3d4-7e5f-8a6b-000000000004",
      name: "Demo read-only",
      prefix: "kw_live_1234",
      scopes: ["query_metric" as const],
      createdAt: to,
      lastUsedAt: null,
    };
    expect(MerchantCreateApiKeyRequest.parse({ name: " Demo read-only ", scopes: key.scopes }).name).toBe(
      "Demo read-only",
    );
    expect(MerchantCreateApiKeyResponse.parse({ key, token: "shown-once" }).token).toBe("shown-once");
    expect(MerchantApiKeyListResponse.parse({ keys: [key] }).keys).toHaveLength(1);
  });
});
