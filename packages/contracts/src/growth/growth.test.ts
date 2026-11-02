import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  DomainEventType,
  DunningCase,
  growthEventPayloads,
  growthJobs,
  InsightAction,
  InsightActionProposal,
  InsightRecord,
  Notification,
  NotificationContent,
  NotificationRequest,
  OutboxResponse,
  parseDomainEventPayload,
} from "../index.js";

const merchantId = "019a3a2b-7c00-7000-8000-000000000001";
const subscriptionId = "019a3a2b-7c00-7000-8000-000000000002";
const sessionId = "019a3a2b-7c00-7000-8000-000000000003";
const replyId = "019a3a2b-7c00-7000-8000-000000000004";
const notificationId = "019a3a2b-7c00-7000-8000-000000000005";
const usd = (value: string) => ({ value, currency: "USD" });

// Parse, serialise to JSON, parse again: the value must survive unchanged both times.
function roundTrip<S extends z.ZodType>(schema: S, value: unknown): void {
  const parsed = schema.parse(value);
  expect(parsed).toEqual(value);
  expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
}

const contents: NotificationContent[] = [
  {
    template: "dunning.update_payment_method",
    payload: {
      firstName: "Raj",
      planName: "Standard",
      amount: usd("12.00"),
      retryAt: "2026-11-03T09:00:00.000Z",
      updatePaymentUrl: "https://www.sandbox.paypal.com/myaccount/autopay/",
    },
  },
  {
    template: "dunning.account_restricted",
    payload: {
      firstName: null,
      planName: "Standard",
      amount: usd("12.00"),
      resolutionUrl: "https://www.sandbox.paypal.com/resolutioncenter",
    },
  },
  {
    template: "dunning.sending_limit",
    payload: {
      firstName: "Raj",
      planName: "Standard",
      amount: usd("12.00"),
      retryAt: null,
      smallerPlan: { name: "Lite", price: usd("6.00") },
    },
  },
  {
    template: "dunning.generic",
    payload: {
      firstName: "Raj",
      planName: "Standard",
      amount: usd("12.00"),
      retryAt: "2026-11-03T09:00:00Z",
      helpUrl: "https://pantryplan.example/help",
    },
  },
  {
    template: "dunning.reactivate",
    payload: { firstName: "Ana", planName: "Lite", portalUrl: "https://keepwell.example/p/pantry" },
  },
  {
    template: "winback.ask",
    payload: {
      firstName: "Tom",
      planName: "Standard",
      replyUrl: "https://keepwell.example/p/pantry/exit?t=abc",
      resubscribeUrl: null,
    },
  },
];

describe("insights", () => {
  const record = {
    sessionId,
    replyId: null,
    source: "session",
    reason: "price",
    subReason: "too expensive after the trial",
    featureRequests: ["smaller boxes"],
    competitor: null,
    sentiment: "negative",
    quote: "I love the food but twelve dollars is a lot for one person.",
  };

  it("round-trips an InsightRecord from a session and from a win-back reply", () => {
    roundTrip(InsightRecord, record);
    roundTrip(InsightRecord, { ...record, source: "winback_reply", sessionId: null, replyId });
  });

  it("requires the id that matches the source", () => {
    expect(InsightRecord.safeParse({ ...record, sessionId: null }).success).toBe(false);
    expect(InsightRecord.safeParse({ ...record, source: "winback_reply" }).success).toBe(false);
  });

  it("rejects a record that carries both source ids", () => {
    expect(InsightRecord.safeParse({ ...record, replyId }).success).toBe(false);
  });

  it("rejects quotes over 20 words", () => {
    const quote = Array.from({ length: 21 }, () => "word").join(" ");
    expect(InsightRecord.safeParse({ ...record, quote }).success).toBe(false);
  });

  it("round-trips an InsightAction", () => {
    roundTrip(InsightAction, {
      id: "019a3a2b-7c00-7000-8000-000000000010",
      merchantId,
      kind: "create_plan",
      params: { name: "Basics", price: usd("4.00") },
      rationale: "23 people who left this month cited price",
      estimate: { monthlyRevenueImpact: usd("92.00"), basis: "23 × $4.00 at 100% uptake" },
      state: "proposed",
      proposedBy: "copilot",
      actionId: null,
      createdAt: "2026-11-05T10:00:00Z",
      decidedAt: null,
    });
  });

  it("validates proposal params per kind", () => {
    roundTrip(InsightActionProposal, {
      kind: "create_plan",
      params: {
        name: "Basics",
        description: null,
        price: usd("4.00"),
        interval: { unit: "MONTH", count: 1 },
        basedOnPaypalPlanId: "P-5ML4271244454362WXNWU5NQ",
      },
    });
    roundTrip(InsightActionProposal, {
      kind: "update_policy",
      params: {
        summary: "Allow 3-month pauses",
        changes: [{ path: "offers.pause.maxCycles", from: 1, to: 3 }],
      },
    });
    roundTrip(InsightActionProposal, {
      kind: "send_winback_batch",
      params: { subscriptionIds: [subscriptionId], reason: "price" },
    });
    expect(
      InsightActionProposal.safeParse({ kind: "create_plan", params: { name: "Basics", price: 4 } }).success,
    ).toBe(false);
    expect(
      InsightActionProposal.safeParse({
        kind: "send_winback_batch",
        params: { subscriptionIds: [], reason: null },
      }).success,
    ).toBe(false);
  });
});

describe("notifications", () => {
  it.each(contents.map((c) => [c.template, c] as const))("round-trips %s content", (_t, content) => {
    roundTrip(NotificationContent, content);
  });

  it("rejects a payload that belongs to another template", () => {
    const [first, second] = contents;
    expect(
      NotificationContent.safeParse({ template: first?.template, payload: second?.payload }).success,
    ).toBe(false);
  });

  it("rejects float money and non-UTC times", () => {
    const base = contents[0];
    if (base?.template !== "dunning.update_payment_method") throw new Error("fixture order changed");
    const amount = { value: 12, currency: "USD" };
    expect(NotificationContent.safeParse({ ...base, payload: { ...base.payload, amount } }).success).toBe(
      false,
    );
    const retryAt = "2026-11-03T14:30:00+05:30";
    expect(NotificationContent.safeParse({ ...base, payload: { ...base.payload, retryAt } }).success).toBe(
      false,
    );
  });

  it("defaults simulated to false on a request", () => {
    const parsed = NotificationRequest.parse({
      merchantId,
      subscriptionId,
      to: "raj@example.com",
      content: contents[0],
    });
    expect(parsed.simulated).toBe(false);
  });

  it("round-trips a Notification and the Demo Inbox response", () => {
    roundTrip(Notification, {
      id: notificationId,
      merchantId,
      subscriptionId,
      to: "raj@example.com",
      channel: "email",
      content: contents[0],
      status: "suppressed",
      suppressedBecause: "frequency_cap",
      dueAt: "2026-11-02T09:00:00Z",
      sentAt: null,
      attempts: 0,
      providerId: null,
      lastError: null,
      simulated: true,
      createdAt: "2026-11-01T09:00:00Z",
    });
    roundTrip(OutboxResponse, {
      items: [
        {
          id: notificationId,
          subscriptionId,
          to: "raj@example.com",
          template: "dunning.update_payment_method",
          subject: "Your Pantry Plan payment didn't go through",
          bodyText: "Hi Raj, ...",
          status: "sent",
          suppressedBecause: null,
          dueAt: "2026-11-02T09:00:00Z",
          sentAt: "2026-11-02T09:00:04Z",
          simulated: true,
        },
      ],
      nextCursor: null,
    });
  });
});

describe("dunning", () => {
  it("round-trips a DunningCase and keeps unknown PayPal reason codes", () => {
    const base = {
      id: "019a3a2b-7c00-7000-8000-000000000020",
      merchantId,
      subscriptionId,
      reasonCode: "PAYER_CANNOT_PAY",
      failedCount: 2,
      nextRetryTime: "2026-11-03T09:00:00Z",
      playbook: "update_payment_method",
      state: "open",
      outstanding: usd("12.00"),
      recoveredAmount: null,
      notificationId,
      captureActionId: null,
      simulated: false,
      openedAt: "2026-10-31T09:00:00Z",
      updatedAt: "2026-11-01T09:00:00Z",
      resolvedAt: null,
    };
    roundTrip(DunningCase, base);
    roundTrip(DunningCase, { ...base, reasonCode: "SOME_FUTURE_CODE", playbook: "generic" });
    expect(DunningCase.safeParse({ ...base, failedCount: 0 }).success).toBe(false);
  });
});

describe("jobs and events", () => {
  it("round-trips every M5 job payload", () => {
    roundTrip(growthJobs["dunning.evaluate"].payload, { subscriptionId, failedCount: 2 });
    roundTrip(growthJobs["notify.dispatch"].payload, { notificationId });
    roundTrip(growthJobs["winback.start"].payload, { subscriptionId });
    roundTrip(growthJobs["insights.extract"].payload, { sessionId });
    roundTrip(growthJobs["insights.extract"].payload, { replyId });
    roundTrip(growthJobs["insights.refresh_views"].payload, {});
  });

  it("insights.extract takes exactly one source id", () => {
    expect(growthJobs["insights.extract"].payload.safeParse({ sessionId, replyId }).success).toBe(false);
    expect(growthJobs["insights.extract"].payload.safeParse({}).success).toBe(false);
  });

  it("builds idempotency keys from the source id", () => {
    const now = new Date("2026-11-01T09:30:00.000Z");
    expect(growthJobs["dunning.evaluate"].idempotencyKey({ subscriptionId, failedCount: 2 })).toBe(
      `${subscriptionId}:2`,
    );
    expect(growthJobs["insights.extract"].idempotencyKey({ replyId })).toBe(replyId);
    expect(growthJobs["insights.extract"].idempotencyKey({ sessionId })).toBe(sessionId);
    expect(growthJobs["insights.refresh_views"].idempotencyKey({}, now)).toBe("2026-11-01T09");
  });

  it("registers the M5 events in the domain event map", () => {
    expect(DomainEventType.safeParse("notification.sent").success).toBe(true);
    expect(parseDomainEventPayload("insight_action.proposed", { insightActionId: notificationId })).toEqual({
      insightActionId: notificationId,
    });
  });

  it("round-trips M5 event payloads", () => {
    roundTrip(growthEventPayloads["notification.sent"], {
      notificationId,
      template: "winback.ask",
      channel: "email",
    });
    roundTrip(growthEventPayloads["insight_action.proposed"], {
      insightActionId: "019a3a2b-7c00-7000-8000-000000000010",
    });
  });
});
