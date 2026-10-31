import { describe, expect, it } from "vitest";
import { PayPalState, fixtureSubscriptionId, pantryPlanFixture } from "@keepwell/paypal-mock";
import {
  FakeActionEngine,
  FakeAudit,
  FakeDomainEvents,
  FakeNotifier,
  FakePolicyStore,
  PANTRY_PLAN,
  pantryPlanSubscription,
} from "@keepwell/contracts/fakes";
import { InMemoryDunningStore } from "./memory-store.js";
import type { SubscriberView, SubscriptionSource } from "./ports.js";
import { RecoveryService } from "./service.js";

// Drives the engine with values produced by packages/paypal-mock's failure injection, so the
// reason code and retry-time formats are PayPal-shaped. M1's diff engine doesn't exist yet, so
// the platform events are derived from the mock's record here, the way the diff will.

const NOW = new Date("2026-11-01T12:00:00.000Z");
const PAYPAL_ID = fixtureSubscriptionId("maya");
const MAYA = pantryPlanSubscription(NOW);

describe("failed renewal from paypal-mock", () => {
  it("PAYER_CANNOT_PAY then a successful retry recovers the case", async () => {
    const mock = new PayPalState([pantryPlanFixture(NOW)], () => NOW);
    const merchantId = pantryPlanFixture(NOW).merchant.id;
    mock.renew(PAYPAL_ID, "PAYER_CANNOT_PAY");
    const billing = mock.getSubscription(merchantId, PAYPAL_ID).billing_info;
    expect(billing?.failed_payments_count).toBe(1);
    const failure = billing?.last_failed_payment;

    const events = new FakeDomainEvents(() => NOW);
    const store = new InMemoryDunningStore();
    const notifier = new FakeNotifier(() => NOW);
    const actions = new FakeActionEngine({ clock: () => NOW });
    const audit = new FakeAudit(() => NOW);
    const view: SubscriberView = { snapshot: MAYA, email: "maya@example.com" };
    const subscriptions: SubscriptionSource = { get: () => Promise.resolve(view) };
    const svc = new RecoveryService({
      db: { forMerchant: (_m, fn) => fn(undefined), acrossMerchants: (fn) => fn(undefined) },
      store,
      subscriptions,
      plans: { plans: () => Promise.resolve([]) },
      policies: new FakePolicyStore(),
      notifier,
      actions,
      audit,
      jobs: { send: () => Promise.resolve() },
      config: { portalUrl: "https://portal.example", paypalWebUrl: "https://www.sandbox.paypal.com" },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      clock: () => NOW,
    });
    svc.register(events);

    await events.emit({
      type: "subscription.payment_failed",
      merchantId: PANTRY_PLAN.merchantId,
      payload: {
        subscriptionId: MAYA.id,
        reasonCode: failure?.reason_code ?? "",
        failedCount: billing?.failed_payments_count ?? 0,
        nextRetryTime: failure?.next_payment_retry_time ?? null,
      },
    });
    await svc.evaluate(PANTRY_PLAN.merchantId, { subscriptionId: MAYA.id, failedCount: 1 });
    expect(store.cases[0]?.playbook).toBe("update_payment_method");
    expect(notifier.queued).toHaveLength(1);

    // PayPal's retry succeeds.
    mock.renew(PAYPAL_ID);
    expect(mock.getSubscription(merchantId, PAYPAL_ID).billing_info?.failed_payments_count).toBe(0);
    await events.emit({
      type: "subscription.payment_completed",
      merchantId: PANTRY_PLAN.merchantId,
      payload: { subscriptionId: MAYA.id, amount: MAYA.price },
    });
    expect(store.cases[0]).toMatchObject({ state: "recovered", recoveredAmount: MAYA.price });
  });
});
