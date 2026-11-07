import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { FakeAgent } from "../fakes/agent.js";
import { DomainEventType, parseDomainEventPayload } from "../platform/events.js";
import type { SubscriptionSnapshot } from "../platform/subscriptions.js";
import { ReasonCategory } from "../shared.js";
import { AgentStreamEvent, brainJobs, FallbackLevel, SessionContext } from "./agent.js";
import { Offer, OfferMenu, PolicyDecision } from "./offers.js";
import { PolicyContext, PolicyDocument } from "./policy.js";

const MERCHANT = "01972f3e-8c4a-7b1e-9d2a-3f4b5c6d7e8f";
const SUB = "01972f3e-8c4a-7b1e-9d2a-000000000001";
const SESSION = "01972f3e-8c4a-7b1e-9d2a-000000000003";
const T = "2026-10-29T10:00:00.000Z";
const usd = (value: string) => ({ value, currency: "USD" });

function roundTrips<S extends z.ZodType>(schema: S, value: unknown): void {
  const once = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
}

const maya: SubscriptionSnapshot = {
  id: SUB,
  merchantId: MERCHANT,
  paypalSubscriptionId: "I-BW452GLLEP1G",
  paypalPlanId: "P-STANDARD",
  planName: "Standard",
  price: usd("12.00"),
  priceOverride: null,
  interval: { unit: "MONTH", count: 1 },
  status: "ACTIVE",
  startedAt: "2026-02-28T09:00:00Z",
  nextBillingTime: "2026-11-28T10:00:00Z",
  lastPayment: { amount: usd("12.00"), time: "2026-10-28T10:00:00Z" },
  outstandingBalance: null,
  failedPaymentsCount: 0,
  lastFailure: null,
  subscriberFirstName: "Maya",
  syncedAt: T,
};

const pantryPolicy: PolicyDocument = {
  version: 1,
  offers: {
    pause: { enabled: true, maxCycles: 3, cooldownDays: 90 },
    downgrade: { enabled: true, targets: { "P-STANDARD": ["P-LITE"] } },
    switch_annual: { enabled: true, targets: { "P-STANDARD": "P-ANNUAL" } },
    discount: { enabled: true, maxPercent: 25, maxCycles: 3 },
    refund_partial: { enabled: false, maxPercentOfLastPayment: 50, maxPerMonth: usd("10.00") },
  },
  eligibility: { minTenureDaysForDiscount: 60, maxSavesPerSubscriberPer365d: 2 },
  reasonPreferences: { price: ["downgrade", "discount"], temporary: ["pause"], other: ["none"] },
  tone: "warm",
  supportContact: "help@pantryplan.example",
};

const offers: Offer[] = [
  { id: "o1", kind: "pause", cycles: 1, resumesOn: "2026-12-28T10:00:00Z" },
  { id: "o2", kind: "downgrade", toPlanId: "P-LITE", toPlanName: "Lite", newPrice: usd("6.00") },
  {
    id: "o3",
    kind: "switch_annual",
    toPlanId: "P-ANNUAL",
    newPrice: usd("120.00"),
    effectiveMonthly: usd("10.00"),
  },
  {
    id: "o4",
    kind: "discount",
    percent: 25,
    cycles: 3,
    newPrice: usd("9.00"),
    firstAffectedBilling: "2026-11-28T10:00:00Z",
  },
  { id: "o5", kind: "refund_partial", amount: usd("6.00"), ofPaymentOn: "2026-10-28T10:00:00Z" },
];

const allReasons = (id: string | null) =>
  Object.fromEntries(ReasonCategory.options.map((r) => [r, id])) as Record<ReasonCategory, string | null>;

const menu: OfferMenu = {
  policyVersion: 1,
  computedAt: T,
  offers,
  defaultByReason: { ...allReasons(null), temporary: "o1", price: "o2" },
  excluded: [{ kind: "refund_partial", because: "Disabled by the merchant's policy" }],
};

const history = { savesLast365d: 0, pausesLast365d: 0, lastPauseEndedAt: null, refundedLast30d: usd("0.00") };
const plans = [
  { planId: "P-LITE", name: "Lite", price: usd("6.00"), interval: { unit: "MONTH", count: 1 } },
  { planId: "P-STANDARD", name: "Standard", price: usd("12.00"), interval: { unit: "MONTH", count: 1 } },
  { planId: "P-ANNUAL", name: "Standard Annual", price: usd("120.00"), interval: { unit: "YEAR", count: 1 } },
];

describe("offers", () => {
  it("round-trips every offer kind", () => {
    for (const offer of offers) roundTrips(Offer, offer);
  });

  it("has no 'none' offer: 'none' is only a ranking value", () => {
    expect(Offer.safeParse({ id: "x", kind: "none" }).success).toBe(false);
  });

  it("rejects float money, non-UTC dates and out-of-range numbers", () => {
    expect(Offer.safeParse({ ...offers[1], newPrice: { value: 6, currency: "USD" } }).success).toBe(false);
    expect(Offer.safeParse({ ...offers[0], resumesOn: "2026-12-28T15:30:00+05:30" }).success).toBe(false);
    expect(Offer.safeParse({ ...offers[0], cycles: 0 }).success).toBe(false);
    expect(Offer.safeParse({ ...offers[0], cycles: 13 }).success).toBe(false);
    expect(Offer.safeParse({ ...offers[3], percent: 101 }).success).toBe(false);
    expect(Offer.safeParse({ ...offers[3], percent: 12.5 }).success).toBe(false);
  });

  it("round-trips OfferMenu, including an empty one", () => {
    roundTrips(OfferMenu, menu);
    roundTrips(OfferMenu, { ...menu, offers: [], defaultByReason: allReasons(null) });
  });

  it("needs a default for every reason, so L1 never has a gap", () => {
    const { unknown: _dropped, ...partial } = menu.defaultByReason;
    expect(OfferMenu.safeParse({ ...menu, defaultByReason: partial }).success).toBe(false);
  });

  it("round-trips PolicyDecision, allowed and denied", () => {
    roundTrips(PolicyDecision, {
      allowed: true,
      policyVersion: 1,
      offer: offers[0],
      violations: [],
      explanation: ["Pause is enabled"],
    });
    roundTrips(PolicyDecision, {
      allowed: false,
      policyVersion: 1,
      offer: null,
      violations: [{ rule: "builtin.one_offer_per_session", message: "An offer was already shown" }],
      explanation: [],
    });
  });
});

describe("policy", () => {
  it("round-trips the Pantry Plan policy", () => {
    roundTrips(PolicyDocument, pantryPolicy);
  });

  it("lets reasonPreferences leave reasons out", () => {
    roundTrips(PolicyDocument, { ...pantryPolicy, reasonPreferences: {} });
  });

  it("rejects limits outside what the engine allows", () => {
    const withOffers = (o: Partial<PolicyDocument["offers"]>) => ({
      ...pantryPolicy,
      offers: { ...pantryPolicy.offers, ...o },
    });
    expect(
      PolicyDocument.safeParse(withOffers({ pause: { enabled: true, maxCycles: 13, cooldownDays: 0 } }))
        .success,
    ).toBe(false);
    expect(
      PolicyDocument.safeParse(withOffers({ discount: { enabled: true, maxPercent: 150, maxCycles: 1 } }))
        .success,
    ).toBe(false);
    expect(PolicyDocument.safeParse({ ...pantryPolicy, version: 0 }).success).toBe(false);
    expect(PolicyDocument.safeParse({ ...pantryPolicy, tone: "pushy" }).success).toBe(false);
  });

  it("round-trips PolicyContext", () => {
    roundTrips(PolicyContext, {
      now: T,
      channel: "widget",
      reason: "temporary",
      cancelIntent: false,
      offersPresentedThisSession: 0,
      subscription: maya,
      history,
      plans,
    });
  });
});

describe("agent", () => {
  it("round-trips SessionContext before and after start()", () => {
    const session = {
      sessionId: SESSION,
      merchantId: MERCHANT,
      channel: "widget",
      policy: pantryPolicy,
      subscription: maya,
      history,
      plans,
      menu: null,
      transcript: [],
      presentedOfferId: null,
      fallbackLevel: "L0",
    };
    roundTrips(SessionContext, session);
    roundTrips(SessionContext, {
      ...session,
      menu,
      transcript: [{ role: "subscriber", text: "I'm travelling for two months", at: T }],
      presentedOfferId: "o1",
    });
    roundTrips(SessionContext, { ...session, locale: "hi-IN" });
    expect(SessionContext.safeParse({ ...session, locale: "h" }).success).toBe(false);
  });

  it("round-trips every AgentStreamEvent and rejects a bad consent hash", () => {
    const hash = "a".repeat(64);
    const events = [
      { type: "agent.delta", text: "Thanks " },
      { type: "agent.done", messageId: SESSION },
      {
        type: "offer.presented",
        offer: offers[0],
        cardText: "Pause for 1 billing cycle.",
        shownTextHash: hash,
      },
      { type: "reason.chips", reasons: ["price", "temporary"] },
      { type: "fallback.changed", level: "L1" },
    ];
    for (const e of events) roundTrips(AgentStreamEvent, e);
    expect(AgentStreamEvent.safeParse({ ...events[2], shownTextHash: "not-a-hash" }).success).toBe(false);
    expect(FallbackLevel.options).toEqual(["L0", "L1", "L2"]);
  });

  it("registers M2's domain events", () => {
    expect(DomainEventType.options).toEqual(
      expect.arrayContaining(["session.offer_presented", "policy.published"]),
    );
    expect(parseDomainEventPayload("policy.published", { version: 2 })).toEqual({ version: 2 });
    expect(() =>
      parseDomainEventPayload("session.offer_presented", {
        sessionId: SESSION,
        subscriptionId: SUB,
        offer: { kind: "none" },
        policyVersion: 1,
      }),
    ).toThrow();
  });

  it("keys llm.budget_reset by UTC day", () => {
    const job = brainJobs["llm.budget_reset"];
    expect(job.payload.parse({})).toEqual({});
    expect(job.idempotencyKey({}, new Date("2026-10-29T23:59:00Z"))).toBe("2026-10-29");
    expect(job.idempotencyKey({}, new Date("2026-10-30T00:01:00Z"))).toBe("2026-10-30");
  });
});

describe("FakeAgent", () => {
  const clock = () => new Date(T);
  const session: SessionContext = SessionContext.parse({
    sessionId: SESSION,
    merchantId: MERCHANT,
    channel: "widget",
    policy: pantryPolicy,
    subscription: maya,
    history,
    plans,
    menu: null,
    transcript: [],
    presentedOfferId: null,
    fallbackLevel: "L0",
  });
  const collect = () => {
    const events: AgentStreamEvent[] = [];
    return { events, push: (e: AgentStreamEvent) => events.push(e) };
  };

  it("starts with a valid menu holding one pause that resumes a cycle after next billing", async () => {
    const { menu: started, fallbackLevel } = await new FakeAgent({ clock }).start(session);
    expect(fallbackLevel).toBe("L0");
    expect(started.offers).toEqual([
      { id: "offer-pause-1", kind: "pause", cycles: 1, resumesOn: "2026-12-28T10:00:00.000Z" },
    ]);
    expect(started.policyVersion).toBe(1);
    expect(Object.values(started.defaultByReason)).toEqual(Array(9).fill("offer-pause-1"));
    expect(started.excluded.map((e) => e.kind)).not.toContain("pause");
  });

  it("offers nothing when the policy disables pause", async () => {
    const policy = {
      ...pantryPolicy,
      offers: { ...pantryPolicy.offers, pause: { ...pantryPolicy.offers.pause, enabled: false } },
    };
    const { menu: started } = await new FakeAgent({ clock }).start({ ...session, policy });
    expect(started.offers).toEqual([]);
    expect(started.excluded.map((e) => e.kind)).toContain("pause");
  });

  it("streams the reply, then the pause card built from the offer, then done", async () => {
    const { events, push } = collect();
    await new FakeAgent({ clock }).respond(session, "I'm away for a month", push);
    const text = events.flatMap((e) => (e.type === "agent.delta" ? [e.text] : [])).join("");
    expect(text).toContain("pause instead of cancelling");
    const offerEvent = events.find((e) => e.type === "offer.presented");
    expect(offerEvent).toMatchObject({
      offer: { kind: "pause" },
      cardText: "Pause for 1 billing cycle. Billing resumes on 2026-12-28.",
    });
    expect(events.at(-1)?.type).toBe("agent.done");
  });

  it("hashes exactly the text shown, so consent can be checked", async () => {
    const { events, push } = collect();
    await new FakeAgent({ clock, reply: "Short reply." }).respond(session, "hi", push);
    const offerEvent = events.find((e) => e.type === "offer.presented");
    const expected = createHash("sha256")
      .update("Short reply.\nPause for 1 billing cycle. Billing resumes on 2026-12-28.")
      .digest("hex");
    expect(offerEvent).toMatchObject({ shownTextHash: expected });
  });

  it("no-means-no: 'cancel' gets a close and no offer", async () => {
    const { events, push } = collect();
    await new FakeAgent({ clock }).respond(session, "Just cancel it please", push);
    expect(events.some((e) => e.type === "offer.presented")).toBe(false);
    expect(events.at(-1)?.type).toBe("agent.done");
  });

  it("never shows a second offer in one session", async () => {
    const { events, push } = collect();
    const agent = new FakeAgent({ clock });
    await agent.respond({ ...session, presentedOfferId: "offer-pause-1" }, "hmm", push);
    await agent.respondToReason({ ...session, presentedOfferId: "offer-pause-1" }, "temporary", push);
    expect(events.some((e) => e.type === "offer.presented")).toBe(false);
  });

  it("L1: a reason chip shows that reason's default offer, or none", async () => {
    const agent = new FakeAgent({ clock, fallbackLevel: "L1" });
    expect((await agent.start(session)).fallbackLevel).toBe("L1");

    const withDefault = collect();
    await agent.respondToReason({ ...session, menu }, "price", withDefault.push);
    expect(withDefault.events.find((e) => e.type === "offer.presented")).toMatchObject({
      offer: { id: "o2", kind: "downgrade" },
      cardText: "Switch to Lite for 6.00 USD.",
    });

    const withoutDefault = collect();
    await agent.respondToReason({ ...session, menu }, "other", withoutDefault.push);
    expect(withoutDefault.events.some((e) => e.type === "offer.presented")).toBe(false);
    expect(agent.calls.map((c) => c.method)).toEqual(["start", "respondToReason", "respondToReason"]);
  });

  it("renders a card for every offer kind from the menu", async () => {
    const texts: string[] = [];
    for (const offer of offers) {
      const { events, push } = collect();
      const single = { ...menu, offers: [offer] };
      await new FakeAgent({ clock }).respond({ ...session, menu: single }, "hi", push);
      const shown = events.find((e) => e.type === "offer.presented");
      if (shown?.type === "offer.presented") texts.push(shown.cardText);
    }
    expect(texts).toEqual([
      "Pause for 1 billing cycle. Billing resumes on 2026-12-28.",
      "Switch to Lite for 6.00 USD.",
      "Switch to annual billing: 120.00 USD a year (10.00 USD a month).",
      "25% off for 3 billing cycles: 9.00 USD from 2026-11-28.",
      "A refund of 6.00 USD on your payment of 2026-10-28.",
    ]);
  });

  it("rejects an invalid session", async () => {
    await expect(new FakeAgent().start({ ...session, sessionId: "nope" })).rejects.toThrow();
  });
});
