import type { SessionContext, SubscriberHistory, SubscriptionSnapshot } from "@keepwell/contracts";
import { PANTRY_PLAN, pantryPlanSubscription } from "@keepwell/contracts/fakes";
import type { Persona, Scenario } from "./personas.js";

// The subscription each persona is on: Pantry Plan, the fictional demo merchant, in five shapes
// that each change what the policy may offer. Times are relative to the run's clock.

const DAY_MS = 86_400_000;

const NO_HISTORY: SubscriberHistory = {
  savesLast365d: 0,
  pausesLast365d: 0,
  lastPauseEndedAt: null,
  refundedLast30d: { value: "0.00", currency: "USD" },
};

export function subscriptionFor(scenario: Scenario, now: Date, firstName: string): SubscriptionSnapshot {
  const daysFromNow = (days: number) => new Date(now.getTime() + days * DAY_MS).toISOString();
  const base = { subscriberFirstName: firstName };
  switch (scenario) {
    case "standard":
    case "saved_twice":
      return pantryPlanSubscription(now, base);
    case "billing_soon":
      return pantryPlanSubscription(now, {
        ...base,
        nextBillingTime: daysFromNow(5),
        lastPayment: { amount: PANTRY_PLAN.standard.price, time: daysFromNow(-25) },
      });
    case "lite_plan":
      return pantryPlanSubscription(now, {
        ...base,
        paypalPlanId: PANTRY_PLAN.lite.planId,
        planName: PANTRY_PLAN.lite.name,
        price: PANTRY_PLAN.lite.price,
        lastPayment: { amount: PANTRY_PLAN.lite.price, time: daysFromNow(-10) },
      });
    case "new_subscriber":
      return pantryPlanSubscription(now, { ...base, startedAt: daysFromNow(-30) });
  }
}

export function historyFor(scenario: Scenario): SubscriberHistory {
  return scenario === "saved_twice" ? { ...NO_HISTORY, savesLast365d: 2 } : NO_HISTORY;
}

/** A fresh session for one persona, as the sessions module would load it before start(). */
export function sessionFor(persona: Persona, sessionId: string, now: Date): SessionContext {
  return {
    sessionId,
    merchantId: PANTRY_PLAN.merchantId,
    channel: "widget",
    policy: PANTRY_PLAN.policy,
    subscription: subscriptionFor(persona.scenario, now, persona.firstName),
    history: historyFor(persona.scenario),
    plans: PANTRY_PLAN.plans,
    menu: null,
    transcript: [],
    presentedOfferId: null,
    fallbackLevel: "L0",
    locale: persona.language,
  };
}
