import { describe, expect, it } from "vitest";
import { PayPalGatewayError } from "../platform/paypal.js";
import { FakeActionEngine } from "./action-engine.js";
import { FakeAudit } from "./audit.js";
import { FakeDomainEvents } from "./domain-events.js";
import { FakePayPalGateway } from "./paypal-gateway.js";
import { uuidv7 } from "./uuidv7.js";

const MERCHANT = "01972f3e-8c4a-7b1e-9d2a-3f4b5c6d7e8f";
const OTHER_MERCHANT = "01972f3e-8c4a-7b1e-9d2a-3f4b5c6d7e90";
const SUB = "01972f3e-8c4a-7b1e-9d2a-000000000001";
const clock = () => new Date("2026-10-29T10:00:00.000Z");

describe("uuidv7", () => {
  it("is a version-7 RFC 9562 UUID that sorts by time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe("FakeDomainEvents", () => {
  it("validates, stores and delivers events to handlers in order", async () => {
    const events = new FakeDomainEvents(clock);
    const seen: string[] = [];
    events.on("subscription.cancelled_externally", "winback.start", (e) => {
      seen.push(`winback:${e.payload.subscriptionId}`);
      return Promise.resolve();
    });
    events.on("subscription.cancelled_externally", "feed.push", () => {
      seen.push("feed");
      return Promise.resolve();
    });

    await events.emit({
      type: "subscription.cancelled_externally",
      merchantId: MERCHANT,
      payload: { subscriptionId: SUB },
    });

    expect(seen).toEqual([`winback:${SUB}`, "feed"]);
    expect(events.ofType("subscription.cancelled_externally")).toHaveLength(1);
    expect(events.emitted[0]).toMatchObject({ occurredAt: "2026-10-29T10:00:00.000Z", simulated: false });
  });

  it("rejects a payload that breaks the producer's schema", async () => {
    const events = new FakeDomainEvents(clock);
    await expect(
      events.emit({
        type: "subscription.payment_failed",
        merchantId: MERCHANT,
        payload: {
          subscriptionId: SUB,
          reasonCode: "PAYER_CANNOT_PAY",
          // @ts-expect-error: failedCount must be a number; this checks the runtime guard too.
          failedCount: "1",
          nextRetryTime: null,
        },
      }),
    ).rejects.toThrow();
    expect(events.emitted).toHaveLength(0);
  });

  it("refuses two handlers with the same name, and surfaces handler errors", async () => {
    const events = new FakeDomainEvents(clock);
    events.on("subscription.cancelled_externally", "h", () => Promise.reject(new Error("boom")));
    expect(() => {
      events.on("subscription.cancelled_externally", "h", () => Promise.resolve());
    }).toThrow(/already registered/);
    await expect(
      events.emit({
        type: "subscription.cancelled_externally",
        merchantId: MERCHANT,
        payload: { subscriptionId: SUB },
      }),
    ).rejects.toThrow("boom");
  });
});

describe("FakeAudit", () => {
  const entry = {
    merchantId: MERCHANT,
    actor: "agent",
    kind: "offer.presented",
    subjectIds: { subscriptionId: SUB },
    payload: { n: 1 },
  } as const;

  it("chains entries per merchant and verifies", async () => {
    const audit = new FakeAudit(clock);
    const first = await audit.append(entry);
    const second = await audit.append({ ...entry, payload: { n: 2 } });
    const otherFirst = await audit.append({ ...entry, merchantId: OTHER_MERCHANT });

    expect(first.seq).toBe(1);
    expect(second).toMatchObject({ seq: 2, prevHash: first.hash, simulated: false });
    expect(otherFirst.seq).toBe(1);
    expect(audit.verify(MERCHANT)).toEqual({ ok: true, checked: 2, brokenAtSeq: null });
    expect(audit.byKind("offer.presented")).toHaveLength(3);
  });

  it("detects a tampered entry", async () => {
    const audit = new FakeAudit(clock);
    await audit.append(entry);
    await audit.append(entry);
    await audit.append(entry);
    const tampered = audit.entries[1];
    if (!tampered) throw new Error("expected a second entry");
    tampered.payload = { n: 999 };
    expect(audit.verify(MERCHANT)).toEqual({ ok: false, checked: 1, brokenAtSeq: 2 });
  });

  it("rejects an invalid entry", async () => {
    const audit = new FakeAudit(clock);
    await expect(audit.append({ ...entry, kind: "Bad Kind" })).rejects.toThrow();
  });
});

describe("FakePayPalGateway", () => {
  const sub = (id: string, planId: string, updated: string) => ({
    id,
    plan_id: planId,
    status: "ACTIVE" as const,
    status_update_time: updated,
  });

  it("returns copies, and throws not_found for unknown or other-merchant subscriptions", async () => {
    const gateway = new FakePayPalGateway();
    gateway.put(MERCHANT, sub("I-1", "P-STD", "2026-10-01T00:00:00Z"));

    const got = await gateway.getSubscription(MERCHANT, "I-1");
    got.status = "CANCELLED";
    expect((await gateway.getSubscription(MERCHANT, "I-1")).status).toBe("ACTIVE");

    await expect(gateway.getSubscription(OTHER_MERCHANT, "I-1")).rejects.toMatchObject({ kind: "not_found" });
    expect(gateway.calls).toHaveLength(3);
  });

  it("filters the list by status_updated_after and plan, and pages by 20", async () => {
    const gateway = new FakePayPalGateway();
    for (let i = 0; i < 25; i++) gateway.put(MERCHANT, sub(`I-${i}`, "P-STD", "2026-10-20T00:00:00Z"));
    gateway.put(MERCHANT, sub("I-old", "P-STD", "2026-09-01T00:00:00Z"));
    gateway.put(MERCHANT, sub("I-lite", "P-LITE", "2026-10-20T00:00:00Z"));

    const recent = await gateway.listSubscriptions(MERCHANT, {
      statusUpdatedAfter: "2026-10-01T00:00:00Z",
      planIds: ["P-STD"],
    });
    expect(recent).toMatchObject({ page: 1, totalItems: 25, totalPages: 2 });
    expect(recent.items).toHaveLength(20);
    expect((await gateway.listSubscriptions(MERCHANT, { planIds: ["P-STD"], page: 2 })).items).toHaveLength(
      6,
    );
  });

  it("fails the next call with an injected error, once", async () => {
    const gateway = new FakePayPalGateway();
    gateway.put(MERCHANT, sub("I-1", "P-STD", "2026-10-01T00:00:00Z"));
    gateway.failNext(new PayPalGatewayError("unavailable", "timeout"));
    await expect(gateway.getSubscription(MERCHANT, "I-1")).rejects.toMatchObject({
      kind: "unavailable",
      retryable: true,
    });
    await expect(gateway.getSubscription(MERCHANT, "I-1")).resolves.toMatchObject({ id: "I-1" });
  });
});

describe("FakeActionEngine", () => {
  const suspend = {
    merchantId: MERCHANT,
    subscriptionId: SUB,
    type: "suspend",
    origin: "session",
    params: { reason: "Pause for 2 months" },
  } as const;

  it("creates PENDING actions and emits action.state_changed", async () => {
    const events = new FakeDomainEvents(clock);
    const engine = new FakeActionEngine({ clock, events });
    const action = await engine.create(suspend);

    expect(action).toMatchObject({ state: "PENDING", attempts: 0, simulated: false, approveUrl: null });
    expect(events.ofType("action.state_changed")[0]?.payload).toMatchObject({
      actionId: action.id,
      from: null,
      to: "PENDING",
    });
  });

  it("returns the existing action for a repeated idempotency key", async () => {
    const engine = new FakeActionEngine({ clock });
    const a = await engine.create({ ...suspend, idempotencyKey: "offer-1" });
    const b = await engine.create({ ...suspend, idempotencyKey: "offer-1" });
    expect(b.id).toBe(a.id);
    expect(engine.actions).toHaveLength(1);
  });

  it("lets a cancel supersede waiting actions but not an executing one", async () => {
    const engine = new FakeActionEngine({ clock });
    const pending = await engine.create(suspend);
    const executing = await engine.create({ ...suspend, type: "revise", params: { planId: "P-LITE" } });
    await engine.transition(executing.id, "EXECUTING");

    await engine.create({ ...suspend, type: "cancel", params: { reason: "Subscriber cancelled" } });

    expect((await engine.get(MERCHANT, pending.id))?.state).toBe("SUPERSEDED");
    expect((await engine.get(MERCHANT, executing.id))?.state).toBe("EXECUTING");
  });

  it("drives the real state machine and rejects impossible transitions", async () => {
    const engine = new FakeActionEngine({ clock });
    const { id } = await engine.create({ ...suspend, type: "revise", params: { planId: "P-LITE" } });
    await engine.transition(id, "EXECUTING");
    const waiting = await engine.transition(id, "AWAITING_BUYER", {
      approveUrl: "https://www.sandbox.paypal.com/approve",
    });
    expect(waiting).toMatchObject({ attempts: 1, approveUrl: "https://www.sandbox.paypal.com/approve" });
    await expect(engine.transition(id, "CONFIRMED")).rejects.toThrow(
      /cannot go from AWAITING_BUYER to CONFIRMED/,
    );
  });

  it("scopes get() by merchant", async () => {
    const engine = new FakeActionEngine({ clock });
    const { id } = await engine.create(suspend);
    expect(await engine.get(OTHER_MERCHANT, id)).toBeNull();
  });

  it("validates input and records scheduled resumes", async () => {
    const engine = new FakeActionEngine({ clock });
    await expect(engine.create({ ...suspend, subscriptionId: null })).rejects.toThrow();
    const resumeId = await engine.scheduleResume({
      merchantId: MERCHANT,
      subscriptionId: SUB,
      dueAt: "2026-12-29T10:00:00Z",
    });
    expect(engine.resumes).toEqual([
      { id: resumeId, merchantId: MERCHANT, subscriptionId: SUB, dueAt: "2026-12-29T10:00:00Z" },
    ]);
  });
});
