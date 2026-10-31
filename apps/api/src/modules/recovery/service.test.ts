import { beforeEach, describe, expect, it } from "vitest";
import type { GrowthJobName, SubscriptionSnapshot } from "@keepwell/contracts";
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
import type { JobQueue, RecoveryDb, SubscriberView, SubscriptionSource } from "./ports.js";
import { RecoveryService } from "./service.js";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const DAY = 86_400_000;
const inDays = (d: number) => new Date(NOW.getTime() + d * DAY).toISOString();
const OTHER_MERCHANT = "0199a1b2-c3d4-7e5f-8a6b-0000000000ff";
const MAYA = pantryPlanSubscription(NOW);
const SUB = MAYA.id;

class FakeJobs implements JobQueue {
  readonly sent: { name: GrowthJobName; payload: unknown; key: string }[] = [];
  send(name: GrowthJobName, payload: unknown, key: string): Promise<void> {
    // pg-boss singletonKey: a duplicate enqueue is a no-op.
    if (!this.sent.some((j) => j.name === name && j.key === key)) this.sent.push({ name, payload, key });
    return Promise.resolve();
  }
}

class FakeSubscriptions implements SubscriptionSource {
  readonly views = new Map<string, SubscriberView>();
  get(_tx: unknown, merchantId: string, subscriptionId: string): Promise<SubscriberView | null> {
    const v = this.views.get(subscriptionId);
    return Promise.resolve(v && v.snapshot.merchantId === merchantId ? v : null);
  }
}

let events: FakeDomainEvents;
let store: InMemoryDunningStore;
let notifier: FakeNotifier;
let actions: FakeActionEngine;
let audit: FakeAudit;
let jobs: FakeJobs;
let subs: FakeSubscriptions;
let policies: FakePolicyStore;
let svc: RecoveryService;
let now: Date;
let scopes: string[];

const logs: unknown[] = [];
const log = {
  info: (o: object) => logs.push(o),
  warn: (o: object) => logs.push(o),
  error: (o: object) => logs.push(o),
};

function setSnapshot(
  overrides: Partial<SubscriptionSnapshot> = {},
  email: string | null = "maya@example.com",
) {
  subs.views.set(SUB, { snapshot: { ...MAYA, ...overrides }, email });
}

const failed = (
  over: Partial<{ reasonCode: string; failedCount: number; nextRetryTime: string | null }> = {},
) =>
  events.emit({
    type: "subscription.payment_failed",
    merchantId: PANTRY_PLAN.merchantId,
    payload: {
      subscriptionId: SUB,
      reasonCode: "PAYER_CANNOT_PAY",
      failedCount: 1,
      nextRetryTime: inDays(5),
      ...over,
    },
  });

beforeEach(() => {
  now = NOW;
  events = new FakeDomainEvents(() => now);
  store = new InMemoryDunningStore();
  notifier = new FakeNotifier(() => now);
  actions = new FakeActionEngine({ clock: () => now });
  audit = new FakeAudit(() => now);
  jobs = new FakeJobs();
  subs = new FakeSubscriptions();
  policies = new FakePolicyStore(() => now);
  scopes = [];
  logs.length = 0;
  const db: RecoveryDb = {
    forMerchant: (merchantId, fn) => {
      scopes.push(merchantId);
      return fn(undefined);
    },
    acrossMerchants: (fn) => fn(undefined),
  };
  svc = new RecoveryService({
    db,
    store,
    subscriptions: subs,
    plans: { plans: () => Promise.resolve(PANTRY_PLAN.plans) },
    policies,
    notifier,
    actions,
    audit,
    jobs,
    config: { portalUrl: "https://portal.example", paypalWebUrl: "https://www.sandbox.paypal.com" },
    log,
    clock: () => now,
  });
  svc.register(events);
  setSnapshot();
});

/** The job a real worker would run after the failed event. */
const runEvaluate = async (failedCount = 1) =>
  svc.evaluate(PANTRY_PLAN.merchantId, { subscriptionId: SUB, failedCount });

describe("opening the case", () => {
  it("opens a case, audits it and enqueues dunning.evaluate keyed on subscription + count", async () => {
    await failed();
    expect(store.cases).toHaveLength(1);
    expect(store.cases[0]).toMatchObject({
      state: "open",
      reasonCode: "PAYER_CANNOT_PAY",
      failedCount: 1,
      playbook: "update_payment_method",
      simulated: false,
    });
    expect(audit.byKind("dunning.case_opened")).toHaveLength(1);
    expect(jobs.sent).toEqual([
      { name: "dunning.evaluate", payload: { subscriptionId: SUB, failedCount: 1 }, key: `${SUB}:1` },
    ]);
    expect(scopes).toEqual([PANTRY_PLAN.merchantId]);
  });

  it("the same event twice changes nothing", async () => {
    await failed();
    await failed();
    expect(store.cases).toHaveLength(1);
    expect(audit.entries).toHaveLength(1);
    expect(jobs.sent).toHaveLength(1);
  });

  it("a higher failed count updates the case and re-plans the message", async () => {
    await failed();
    await runEvaluate(1);
    await failed({ failedCount: 2, nextRetryTime: inDays(4) });
    expect(store.cases).toHaveLength(1);
    expect(store.cases[0]).toMatchObject({ failedCount: 2, notificationId: null });
    expect(audit.byKind("dunning.case_updated")).toHaveLength(1);
    expect(jobs.sent.map((j) => j.key)).toEqual([`${SUB}:1`, `${SUB}:2`]);
    // The stale job for count 1 is a no-op.
    await runEvaluate(1);
    expect(notifier.queued).toHaveLength(1);
  });

  it("copies the simulated flag from the event to the case, message and audit entries", async () => {
    await events.emit({
      type: "subscription.payment_failed",
      merchantId: PANTRY_PLAN.merchantId,
      simulated: true,
      payload: {
        subscriptionId: SUB,
        reasonCode: "PAYMENT_DENIED",
        failedCount: 1,
        nextRetryTime: inDays(5),
      },
    });
    await runEvaluate();
    expect(store.cases[0]?.simulated).toBe(true);
    expect(notifier.queued[0]?.simulated).toBe(true);
    expect(audit.entries.every((e) => e.simulated)).toBe(true);
    expect(audit.entries.length).toBeGreaterThanOrEqual(2);
  });
});

describe("playbooks", () => {
  it.each([
    ["PAYER_CANNOT_PAY", "update_payment_method", "dunning.update_payment_method"],
    ["PAYMENT_DENIED", "update_payment_method", "dunning.update_payment_method"],
    ["PAYER_ACCOUNT_RESTRICTED", "account_restricted", "dunning.account_restricted"],
    ["SENDING_LIMIT_EXCEEDED", "sending_limit", "dunning.sending_limit"],
    ["SOMETHING_NEW", "generic", "dunning.generic"],
  ] as const)("%s uses %s and sends %s", async (reasonCode, playbook, template) => {
    await failed({ reasonCode });
    expect(store.cases[0]?.playbook).toBe(playbook);
    await runEvaluate();
    expect(notifier.queued.map((n) => n.content.template)).toEqual([template]);
    expect(notifier.queued[0]?.to).toBe("maya@example.com");
  });

  it("INTERNAL_SERVER_ERROR sends nothing, also not from the sweep", async () => {
    await failed({ reasonCode: "INTERNAL_SERVER_ERROR" });
    await runEvaluate();
    now = new Date(NOW.getTime() + 10 * DAY);
    expect(await svc.sweepDueWork()).toBe(0);
    expect(store.cases[0]?.playbook).toBe("wait_for_retry");
    expect(notifier.queued).toHaveLength(0);
  });

  it("message facts come from the snapshot", async () => {
    setSnapshot({ outstandingBalance: { value: "12.00", currency: "USD" } });
    await failed();
    await runEvaluate();
    const content = notifier.queued[0]?.content;
    expect(content?.template === "dunning.update_payment_method" && content.payload).toMatchObject({
      planName: "Standard",
      amount: { value: "12.00", currency: "USD" },
      retryAt: inDays(5),
      updatePaymentUrl: "https://www.sandbox.paypal.com/myaccount/autopay/connect/I-FAKEMAYA00001",
    });
  });

  it("sending limit offers the smaller plan only when the policy allows a downgrade", async () => {
    await failed({ reasonCode: "SENDING_LIMIT_EXCEEDED" });
    await runEvaluate();
    const noPolicy = notifier.queued[0]?.content;
    expect(noPolicy?.template === "dunning.sending_limit" && noPolicy.payload.smallerPlan).toBeNull();

    const { version: _v, ...draft } = PANTRY_PLAN.policy;
    await policies.publish({
      merchantId: PANTRY_PLAN.merchantId,
      baseVersion: null,
      document: draft,
      changeNote: null,
      publishedBy: "test",
    });
    await store.update(undefined, PANTRY_PLAN.merchantId, store.cases[0]?.id ?? "", { notificationId: null });
    await runEvaluate();
    const allowed = notifier.queued[1]?.content;
    expect(allowed?.template === "dunning.sending_limit" && allowed.payload.smallerPlan).toEqual({
      name: "Lite",
      price: { value: "6.00", currency: "USD" },
    });

    await policies.publish({
      merchantId: PANTRY_PLAN.merchantId,
      baseVersion: 1,
      document: { ...draft, offers: { ...draft.offers, downgrade: { enabled: false, targets: {} } } },
      changeNote: null,
      publishedBy: "test",
    });
    await store.update(undefined, PANTRY_PLAN.merchantId, store.cases[0]?.id ?? "", { notificationId: null });
    await runEvaluate();
    const disabled = notifier.queued[2]?.content;
    expect(disabled?.template === "dunning.sending_limit" && disabled.payload.smallerPlan).toBeNull();
  });
});

describe("timing", () => {
  it("schedules about 24h before the retry", async () => {
    await failed({ nextRetryTime: inDays(5) });
    await runEvaluate();
    expect(notifier.queued[0]?.dueAt).toBe(inDays(4));
    expect(audit.byKind("dunning.notification_requested")).toHaveLength(1);
  });

  it("sends immediately when the retry is closer than 24h", async () => {
    await failed({ nextRetryTime: new Date(NOW.getTime() + 6 * 3_600_000).toISOString() });
    await runEvaluate();
    expect(notifier.queued[0]?.dueAt).toBe(NOW.toISOString());
  });

  it("evaluating twice queues one message", async () => {
    await failed();
    await runEvaluate();
    await runEvaluate();
    expect(notifier.queued).toHaveLength(1);
  });

  it("queues nothing without a subscriber email", async () => {
    setSnapshot({}, null);
    await failed();
    await runEvaluate();
    expect(notifier.queued).toHaveLength(0);
  });
});

describe("due-work sweep (lost jobs)", () => {
  it("re-evaluates a case whose message time passed and has no notification", async () => {
    await failed({ nextRetryTime: inDays(5) });
    // The evaluate job was lost. Before the message time, the sweep leaves it alone.
    expect(await svc.sweepDueWork()).toBe(0);
    now = new Date(NOW.getTime() + 4 * DAY + 60_000);
    expect(await svc.sweepDueWork()).toBe(1);
    expect(notifier.queued).toHaveLength(1);
    expect(await svc.sweepDueWork()).toBe(0);
    expect(notifier.queued).toHaveLength(1);
  });

  it("keeps going when one case fails", async () => {
    await failed({ nextRetryTime: inDays(1) });
    subs.views.clear();
    setSnapshot();
    const original = notifier.enqueue.bind(notifier);
    notifier.enqueue = () => Promise.reject(new Error("outbox down"));
    expect(await svc.sweepDueWork()).toBe(0);
    notifier.enqueue = original;
    expect(await svc.sweepDueWork()).toBe(1);
  });
});

describe("time machine", () => {
  it("sendDunningNow queues the message for now and flags it simulated in the audit trail", async () => {
    await failed({ nextRetryTime: inDays(5) });
    await runEvaluate();
    const { notificationId } = await svc.sendDunningNow(PANTRY_PLAN.merchantId, SUB);
    expect(notificationId).not.toBeNull();
    const shifted = notifier.queued.find((n) => n.id === notificationId);
    expect(shifted).toMatchObject({ dueAt: NOW.toISOString(), simulated: true });
    const entry = audit.byKind("dunning.notification_requested").at(-1);
    expect(entry).toMatchObject({ simulated: true, payload: { timeShifted: true } });
    expect(store.cases[0]?.simulated).toBe(false);
  });

  it("does nothing when there is no open case", async () => {
    expect(await svc.sendDunningNow(PANTRY_PLAN.merchantId, SUB)).toEqual({ notificationId: null });
  });
});

describe("recovery", () => {
  const completed = (simulated = false) =>
    events.emit({
      type: "subscription.payment_completed",
      merchantId: PANTRY_PLAN.merchantId,
      simulated,
      payload: { subscriptionId: SUB, amount: { value: "12.00", currency: "USD" } },
    });

  it("closes the case as recovered and records the amount", async () => {
    await failed();
    await completed();
    expect(store.cases[0]).toMatchObject({
      state: "recovered",
      recoveredAmount: { value: "12.00", currency: "USD" },
    });
    expect(store.cases[0]?.resolvedAt).not.toBeNull();
    expect(audit.byKind("dunning.case_recovered")).toHaveLength(1);
    expect(actions.actions).toHaveLength(0);
  });

  it("creates exactly one capture Action when an ACTIVE subscription still owes a balance", async () => {
    setSnapshot({ outstandingBalance: { value: "12.00", currency: "USD" } });
    await events.emit({
      type: "subscription.payment_failed",
      merchantId: PANTRY_PLAN.merchantId,
      simulated: true,
      payload: {
        subscriptionId: SUB,
        reasonCode: "PAYER_CANNOT_PAY",
        failedCount: 1,
        nextRetryTime: inDays(5),
      },
    });
    await completed();
    await completed();
    expect(actions.actions).toHaveLength(1);
    expect(actions.actions[0]).toMatchObject({
      type: "capture_outstanding",
      origin: "recovery",
      params: { amount: { value: "12.00", currency: "USD" } },
      simulated: true,
    });
    expect(store.cases[0]?.captureActionId).toBe(actions.actions[0]?.id);
    expect(audit.byKind("dunning.capture_requested")).toHaveLength(1);
    expect(audit.byKind("dunning.case_recovered")).toHaveLength(1);
  });

  it("does not capture when the subscription is not ACTIVE", async () => {
    setSnapshot({ status: "SUSPENDED", outstandingBalance: { value: "12.00", currency: "USD" } });
    await failed();
    await completed();
    expect(actions.actions).toHaveLength(0);
  });

  it("an ordinary renewal with no case does nothing", async () => {
    await completed();
    expect(audit.entries).toHaveLength(0);
  });
});

describe("suspension and closing", () => {
  const status = (to: "SUSPENDED" | "CANCELLED" | "EXPIRED" | "ACTIVE") =>
    events.emit({
      type: "subscription.status_changed",
      merchantId: PANTRY_PLAN.merchantId,
      payload: { subscriptionId: SUB, from: "ACTIVE", to },
    });

  it("SUSPENDED marks the case suspended and queues dunning.reactivate with the portal link", async () => {
    await failed();
    await status("SUSPENDED");
    await status("SUSPENDED");
    expect(store.cases[0]?.state).toBe("suspended");
    expect(notifier.queued).toHaveLength(1);
    const n = notifier.queued[0]?.content;
    expect(n?.template === "dunning.reactivate" && n.payload.portalUrl).toBe("https://portal.example");
    expect(audit.byKind("dunning.case_suspended")).toHaveLength(1);
  });

  it("a suspended case is recovered by a later payment", async () => {
    await failed();
    await status("SUSPENDED");
    await events.emit({
      type: "subscription.payment_completed",
      merchantId: PANTRY_PLAN.merchantId,
      payload: { subscriptionId: SUB, amount: { value: "12.00", currency: "USD" } },
    });
    expect(store.cases[0]?.state).toBe("recovered");
  });

  it.each(["CANCELLED", "EXPIRED"] as const)("%s closes the case", async (to) => {
    await failed();
    await status(to);
    expect(store.cases[0]).toMatchObject({ state: "closed" });
    expect(audit.byKind("dunning.case_closed")).toHaveLength(1);
  });

  it("without an open case nothing happens", async () => {
    await status("SUSPENDED");
    expect(notifier.queued).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });
});

describe("merchant isolation", () => {
  it("another merchant's events never touch this merchant's case", async () => {
    await failed();
    await events.emit({
      type: "subscription.payment_completed",
      merchantId: OTHER_MERCHANT,
      payload: { subscriptionId: SUB, amount: { value: "12.00", currency: "USD" } },
    });
    await events.emit({
      type: "subscription.status_changed",
      merchantId: OTHER_MERCHANT,
      payload: { subscriptionId: SUB, from: "ACTIVE", to: "CANCELLED" },
    });
    expect(store.cases[0]?.state).toBe("open");
    expect(audit.chain(PANTRY_PLAN.merchantId)).toHaveLength(1);
    expect(audit.chain(OTHER_MERCHANT)).toHaveLength(0);
  });

  it("every database scope is the event's own merchant", async () => {
    await failed();
    await runEvaluate();
    expect(new Set(scopes)).toEqual(new Set([PANTRY_PLAN.merchantId]));
  });

  it("sendDunningNow for the wrong merchant finds no case", async () => {
    await failed();
    expect(await svc.sendDunningNow(OTHER_MERCHANT, SUB)).toEqual({ notificationId: null });
  });
});
