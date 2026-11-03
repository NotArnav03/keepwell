import { describe, expect, it } from "vitest";
import { pantryPlanSubscription, PANTRY_PLAN } from "@keepwell/contracts/fakes";
import type { AuditEntry, MerchantFeedEvent, MerchantTimelineResponse } from "@keepwell/contracts";
import { renderAuditExplorer, renderLiveFeed, renderSubscribers, renderTimelineFallback } from "./views.js";

describe("merchant dashboard data views", () => {
  it("renders API-provided subscriber data and a cursor link safely", () => {
    const subscription = pantryPlanSubscription(new Date("2026-11-03T12:00:00Z"), {
      planName: "<img src=x>",
    });
    const html = renderSubscribers({
      subscriptions: [{ subscription, risk: { score: 58, band: "high" } }],
      nextCursor: "cursor/1",
    });

    expect(html).toContain("Maya");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).toContain("I-FAKEMAYA00001");
    expect(html).toContain("high (58/100)");
    expect(html).toContain("cursor%2F1");
    expect(html).not.toContain("<img src=x>");
  });

  it("explains audit events, links their subjects and labels simulated records", () => {
    const entry: AuditEntry = {
      seq: 1,
      merchantId: PANTRY_PLAN.merchantId,
      at: "2026-11-03T12:00:00Z",
      actor: "demo",
      kind: "action.state_changed",
      subjectIds: { actionId: "action-1", paypalSubscriptionId: "I-FAKEMAYA00001" },
      payload: {},
      simulated: true,
      prevHash: "0".repeat(64),
      hash: "1".repeat(64),
    };
    const html = renderAuditExplorer([entry]);

    expect(html).toContain("SIMULATED");
    expect(html).toContain("check its linked action and PayPal subscription");
    expect(html).toContain("#audit?subject=action-1");
    expect(html).toContain("I-FAKEMAYA00001");
    expect(html).not.toContain("payload");
  });

  it("renders the vendor-neutral timeline fallback with audit and PayPal links", () => {
    const timeline: MerchantTimelineResponse = {
      resources: [
        {
          id: "0199a1b2-c3d4-7e5f-8a6b-000000000001",
          name: "Maya",
          subscriptionId: "0199a1b2-c3d4-7e5f-8a6b-000000000001",
        },
      ],
      events: [
        {
          id: "0199a1b2-c3d4-7e5f-8a6b-000000000002",
          resourceId: "0199a1b2-c3d4-7e5f-8a6b-000000000001",
          startDate: "2026-11-03T12:00:00Z",
          endDate: null,
          name: "Pause applied",
          kind: "action.confirmed",
          auditSeq: 2,
          paypalSubscriptionId: "I-FAKEMAYA00001",
          simulated: false,
        },
      ],
    };
    const html = renderTimelineFallback(timeline);

    expect(html).toContain("Event list fallback");
    expect(html).toContain("#audit?seq=2");
    expect(html).toContain("#paypal/I-FAKEMAYA00001");
  });

  it("renders live event metadata without exposing arbitrary payload fields", () => {
    const event: MerchantFeedEvent = {
      id: "0199a1b2-c3d4-7e5f-8a6b-000000000003",
      type: "action.state_changed",
      merchantId: PANTRY_PLAN.merchantId,
      occurredAt: "2026-11-03T12:00:00Z",
      simulated: true,
      payload: { secretLikeText: "must not render" },
    };
    const html = renderLiveFeed([event]);

    expect(html).toContain("action.state_changed");
    expect(html).toContain("SIMULATED");
    expect(html).toContain("#audit?event=0199a1b2-c3d4-7e5f-8a6b-000000000003");
    expect(html).not.toContain("must not render");
  });
});
