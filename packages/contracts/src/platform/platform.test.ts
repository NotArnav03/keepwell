import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { canonicalJson } from "../canonical-json.js";
import { Money } from "../shared.js";
import {
  ACTION_TRANSITIONS,
  Action,
  ActionCreateInput,
  ActionState,
  canTransition,
  isTerminalActionState,
  parseActionParams,
} from "./actions.js";
import { AuditAppendInput, AuditEntry, AuditVerifyResult, GENESIS_HASH } from "./audit.js";
import { DomainEventEnvelope, platformEventPayloads } from "./events.js";
import { ErrorEnvelope } from "./http.js";
import { platformJobs } from "./jobs.js";
import { PayPalGatewayError, PayPalSubscription } from "./paypal.js";
import { SubscriptionSnapshot } from "./subscriptions.js";

const MERCHANT = "01972f3e-8c4a-7b1e-9d2a-3f4b5c6d7e8f";
const SUB = "01972f3e-8c4a-7b1e-9d2a-000000000001";
const ACTION = "01972f3e-8c4a-7b1e-9d2a-000000000002";
const T = "2026-10-29T10:00:00.000Z";

/** parse → JSON → parse gives the same value: the schema survives the wire and the database. */
function roundTrips<S extends z.ZodType>(schema: S, value: unknown): void {
  const once = schema.parse(value);
  const twice = schema.parse(JSON.parse(JSON.stringify(once)));
  expect(twice).toEqual(once);
}

const usd = (value: string) => ({ value, currency: "USD" });

const maya: SubscriptionSnapshot = {
  id: SUB,
  merchantId: MERCHANT,
  paypalSubscriptionId: "I-BW452GLLEP1G",
  paypalPlanId: "P-5ML4271244454362WXNWU5NQ",
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

const action: Action = {
  id: ACTION,
  merchantId: MERCHANT,
  subscriptionId: SUB,
  type: "revise",
  params: { planId: "P-LITE" },
  state: "AWAITING_BUYER",
  origin: "session",
  attempts: 1,
  idempotencyKey: "session-1:offer-1",
  approveUrl: "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-1",
  paypalDebugIds: ["f1e2d3c4b5a6"],
  error: null,
  simulated: false,
  createdAt: T,
  updatedAt: T,
};

describe("shared + subscriptions", () => {
  it("round-trips Money and rejects floats or missing cents", () => {
    roundTrips(Money, usd("6.00"));
    expect(Money.safeParse({ value: 6, currency: "USD" }).success).toBe(false);
    expect(Money.safeParse(usd("6.5")).success).toBe(false);
  });

  it("round-trips SubscriptionSnapshot, including a failed and discounted one", () => {
    roundTrips(SubscriptionSnapshot, maya);
    roundTrips(SubscriptionSnapshot, {
      ...maya,
      priceOverride: usd("9.00"),
      failedPaymentsCount: 2,
      outstandingBalance: usd("12.00"),
      lastFailure: { reasonCode: "PAYER_CANNOT_PAY", time: T, nextRetryTime: "2026-11-03T10:00:00Z" },
    });
  });

  it("rejects non-UTC times in our own types", () => {
    expect(SubscriptionSnapshot.safeParse({ ...maya, syncedAt: "2026-10-29T15:30:00+05:30" }).success).toBe(
      false,
    );
  });
});

describe("PayPal raw shapes", () => {
  const raw = {
    id: "I-BW452GLLEP1G",
    plan_id: "P-5ML4271244454362WXNWU5NQ",
    status: "ACTIVE",
    status_update_time: "2026-10-28T10:00:00Z",
    start_time: "2026-02-28T09:00:00Z",
    subscriber: { name: { given_name: "Maya", surname: "Rao" }, email_address: "maya@example.com" },
    billing_info: {
      outstanding_balance: { currency_code: "USD", value: "0.00" },
      last_payment: { amount: { currency_code: "USD", value: "12.00" }, time: "2026-10-28T10:00:00Z" },
      next_billing_time: "2026-11-28T10:00:00Z",
      failed_payments_count: 0,
      cycle_executions: [{ tenure_type: "REGULAR", sequence: 1, cycles_completed: 8 }],
    },
    quantity: "1",
  };

  it("round-trips and keeps fields we don't model", () => {
    roundTrips(PayPalSubscription, raw);
    expect(PayPalSubscription.parse(raw)).toMatchObject({ quantity: "1" });
  });

  it("accepts PayPal's offset times", () => {
    expect(PayPalSubscription.safeParse({ ...raw, start_time: "2026-02-28T01:00:00-08:00" }).success).toBe(
      true,
    );
  });

  it("classifies gateway errors as retryable or not", () => {
    expect(new PayPalGatewayError("rate_limited", "429").retryable).toBe(true);
    expect(new PayPalGatewayError("unavailable", "timeout").retryable).toBe(true);
    expect(new PayPalGatewayError("unprocessable", "422").retryable).toBe(false);
    expect(new PayPalGatewayError("not_found", "404")).toBeInstanceOf(Error);
  });
});

describe("actions", () => {
  it("round-trips Action", () => {
    roundTrips(Action, action);
    roundTrips(Action, { ...action, state: "FAILED", approveUrl: null, error: { code: "X", message: "y" } });
  });

  const base = { merchantId: MERCHANT, subscriptionId: SUB, origin: "session" } as const;
  const valid: ActionCreateInput[] = [
    { ...base, type: "suspend", params: { reason: "Paused for 2 months at subscriber request" } },
    { ...base, type: "activate", params: { reason: "Scheduled resume" } },
    { ...base, type: "cancel", params: { reason: "Subscriber cancelled" } },
    { ...base, type: "revise", params: { planId: "P-LITE" } },
    { ...base, type: "patch_price", params: { fixedPrice: usd("9.00") } },
    { ...base, type: "patch_price", params: { fixedPrice: null } },
    { ...base, type: "refund", params: { transactionId: "8AB12345CD678901E", amount: usd("6.00") } },
    { ...base, type: "capture_outstanding", origin: "recovery", params: { amount: usd("12.00") } },
    {
      ...base,
      subscriptionId: null,
      type: "create_plan",
      origin: "insight",
      params: {
        productId: "PROD-1",
        name: "Lite",
        price: usd("6.00"),
        interval: { unit: "MONTH", count: 1 },
      },
    },
  ];

  it.each(valid.map((v) => [`${v.type} ${JSON.stringify(v.params)}`, v] as const))(
    "round-trips ActionCreateInput: %s",
    (_label, input) => {
      roundTrips(ActionCreateInput, input);
      expect(ActionCreateInput.parse(input).simulated).toBe(false);
    },
  );

  it("requires a subscription for everything except create_plan", () => {
    expect(ActionCreateInput.safeParse({ ...valid[0], subscriptionId: null }).success).toBe(false);
    expect(ActionCreateInput.safeParse({ ...valid.at(-1), subscriptionId: SUB }).success).toBe(false);
  });

  it("rejects unknown params and PayPal-invalid reasons", () => {
    expect(
      ActionCreateInput.safeParse({ ...base, type: "suspend", params: { reason: "x", cycles: 2 } }).success,
    ).toBe(false);
    expect(
      ActionCreateInput.safeParse({ ...base, type: "cancel", params: { reason: "x".repeat(129) } }).success,
    ).toBe(false);
  });

  it("parses stored params by type", () => {
    expect(parseActionParams("revise", action.params).planId).toBe("P-LITE");
    expect(() => parseActionParams("refund", action.params)).toThrow();
  });

  it("has a state machine where only the four end states are terminal", () => {
    const terminal = ActionState.options.filter(isTerminalActionState);
    expect(terminal.sort()).toEqual(["ABANDONED", "CONFIRMED", "FAILED", "SUPERSEDED"]);
    expect(canTransition("PENDING", "EXECUTING")).toBe(true);
    expect(canTransition("CONFIRMED", "PENDING")).toBe(false);
    expect(canTransition("EXECUTING", "SUPERSEDED")).toBe(false);
  });

  it("can reach every state from PENDING", () => {
    const seen = new Set<string>(["PENDING"]);
    const queue: ActionState[] = ["PENDING"];
    for (let s = queue.shift(); s; s = queue.shift()) {
      for (const next of ACTION_TRANSITIONS[s]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...ActionState.options].sort());
  });
});

describe("audit", () => {
  const entry: AuditEntry = {
    seq: 1,
    merchantId: MERCHANT,
    at: T,
    actor: "agent",
    kind: "offer.presented",
    subjectIds: { subscriptionId: SUB, sessionId: "s-1" },
    payload: { offer: { kind: "pause", cycles: 2 } },
    simulated: false,
    prevHash: GENESIS_HASH,
    hash: "a".repeat(64),
  };

  it("round-trips AuditEntry, AuditAppendInput and AuditVerifyResult", () => {
    roundTrips(AuditEntry, entry);
    roundTrips(AuditAppendInput, {
      merchantId: MERCHANT,
      actor: "system",
      kind: "action.state_changed",
      subjectIds: {},
      payload: {},
    });
    roundTrips(AuditVerifyResult, { ok: false, checked: 41, brokenAtSeq: 42 });
  });

  it("rejects malformed kinds and hashes", () => {
    expect(AuditEntry.safeParse({ ...entry, kind: "OfferPresented" }).success).toBe(false);
    expect(AuditEntry.safeParse({ ...entry, kind: "offer" }).success).toBe(false);
    expect(AuditEntry.safeParse({ ...entry, hash: "xyz" }).success).toBe(false);
  });
});

describe("domain events", () => {
  const payloads: { [K in keyof typeof platformEventPayloads]: unknown } = {
    "subscription.synced": { subscriptionId: SUB, snapshot: maya },
    "subscription.status_changed": { subscriptionId: SUB, from: "ACTIVE", to: "SUSPENDED" },
    "subscription.plan_changed": { subscriptionId: SUB, fromPlanId: "P-STD", toPlanId: "P-LITE" },
    "subscription.payment_failed": {
      subscriptionId: SUB,
      reasonCode: "PAYER_CANNOT_PAY",
      failedCount: 1,
      nextRetryTime: "2026-11-03T10:00:00Z",
    },
    "subscription.payment_completed": { subscriptionId: SUB, amount: usd("12.00") },
    "subscription.cancelled_externally": { subscriptionId: SUB },
    "action.state_changed": {
      actionId: ACTION,
      subscriptionId: SUB,
      type: "revise",
      from: "EXECUTING",
      to: "AWAITING_BUYER",
      approveUrl: action.approveUrl,
      error: null,
    },
  };

  it.each(Object.entries(payloads))("round-trips the %s payload", (type, payload) => {
    roundTrips(platformEventPayloads[type as keyof typeof platformEventPayloads], payload);
  });

  it("round-trips the envelope and rejects unknown event types", () => {
    const envelope = {
      id: ACTION,
      type: "subscription.cancelled_externally",
      merchantId: MERCHANT,
      occurredAt: T,
      simulated: true,
      payload: { subscriptionId: SUB },
    };
    roundTrips(DomainEventEnvelope, envelope);
    expect(DomainEventEnvelope.safeParse({ ...envelope, type: "subscription.exploded" }).success).toBe(false);
  });
});

describe("jobs", () => {
  const now = new Date("2026-10-29T17:24:31.500Z");

  it("round-trips every job payload", () => {
    const samples: { [K in keyof typeof platformJobs]: unknown } = {
      "webhook.process": { webhookEventId: ACTION },
      "action.execute": { actionId: ACTION },
      "action.confirm": { actionId: ACTION },
      "reconcile.subscription": { subscriptionId: SUB },
      "reconcile.sweep": { merchantId: MERCHANT },
      "reconcile.drift": { merchantId: MERCHANT },
      "due.sweep": {},
      "resume.due": { scheduledResumeId: ACTION },
      "domain.dispatch": { domainEventId: ACTION, handler: "recovery.open_case" },
      "pool.health": {},
    };
    for (const [name, payload] of Object.entries(samples)) {
      roundTrips(platformJobs[name as keyof typeof platformJobs].payload, payload);
    }
  });

  it("keys windowed jobs by UTC bucket", () => {
    expect(platformJobs["reconcile.subscription"].idempotencyKey({ subscriptionId: SUB }, now)).toBe(
      `${SUB}:2026-10-29T17:24`,
    );
    expect(platformJobs["reconcile.sweep"].idempotencyKey({ merchantId: MERCHANT }, now)).toBe(
      `${MERCHANT}:2026-10-29T17:00`,
    );
    // One drift report per merchant per UTC day.
    expect(platformJobs["reconcile.drift"].idempotencyKey({ merchantId: MERCHANT }, now)).toBe(
      `${MERCHANT}:2026-10-29`,
    );
    expect(platformJobs["pool.health"].idempotencyKey({}, now)).toBe("2026-10-29T17:20");
    expect(platformJobs["domain.dispatch"].idempotencyKey({ domainEventId: ACTION, handler: "h" }, now)).toBe(
      `${ACTION}:h`,
    );
  });
});

describe("http + canonical JSON", () => {
  it("round-trips the error envelope", () => {
    roundTrips(ErrorEnvelope, {
      error: { code: "not_found", message: "No such session", requestId: "req-1" },
    });
    roundTrips(ErrorEnvelope, {
      error: {
        code: "invalid_request",
        message: "Bad body",
        requestId: "req-2",
        details: [{ path: "text" }],
      },
    });
  });

  it("is independent of key order and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [3, 1] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
    expect(canonicalJson({ a: undefined, b: new Date(T) })).toBe(`{"b":"${T}"}`);
  });
});
