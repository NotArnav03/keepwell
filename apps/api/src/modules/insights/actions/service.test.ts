import { beforeEach, describe, expect, it } from "vitest";
import { FakeActionEngine, FakeAudit, FakeDomainEvents } from "@keepwell/contracts/fakes";
import { DeterministicEstimateProvider, type EstimateInputs } from "./estimate.js";
import {
  InsightActionError,
  InsightActionService,
  type MerchantPrincipal,
  type PolicyPublisher,
  type SendWinbackBatchInput,
  type UpdatePolicyInput,
  type WinbackBatchResult,
  type WinbackBatchSender,
} from "./service.js";
import { InMemoryInsightActionStore } from "./store.js";

const M1 = "0199a1b2-c3d4-7e5f-8a6b-0000000000a1";
const M2 = "0199a1b2-c3d4-7e5f-8a6b-0000000000a2";
const SUB = "0199a1b2-c3d4-7e5f-8a6b-000000000001";
const principal = (merchantId: string): MerchantPrincipal => ({
  merchantId,
  userLabel: "owner@pantry.example",
});
const monthly = { unit: "MONTH", count: 1 } as const;

const createPlan = {
  kind: "create_plan",
  params: {
    name: "Basics",
    description: null,
    price: { value: "4.00", currency: "USD" },
    interval: monthly,
    basedOnPaypalPlanId: "P-STANDARD",
  },
} as const;
const updatePolicy = {
  kind: "update_policy",
  params: { summary: "Allow 3-month pauses", changes: [{ path: "pause.maxMonths", from: 1, to: 3 }] },
} as const;
const winback = {
  kind: "send_winback_batch",
  params: { subscriptionIds: [SUB], reason: "price" },
} as const;

const inputs: EstimateInputs = {
  priceCancellations: () => Promise.resolve(23),
  planFootprints: () =>
    Promise.resolve([
      {
        planName: "Standard",
        activeSubscribers: 40,
        price: { value: "10.00", currency: "USD" },
        interval: monthly,
      },
    ]),
};

class RecordingPolicy implements PolicyPublisher {
  readonly calls: UpdatePolicyInput[] = [];
  failWith: Error | null = null;
  publishChanges(_p: MerchantPrincipal, params: UpdatePolicyInput) {
    if (this.failWith) return Promise.reject(this.failWith);
    this.calls.push(params);
    return Promise.resolve({ version: 7 });
  }
}
class RecordingWinback implements WinbackBatchSender {
  readonly calls: { merchantId: string; params: SendWinbackBatchInput }[] = [];
  result: WinbackBatchResult | null = null;
  send(merchantId: string, params: SendWinbackBatchInput) {
    this.calls.push({ merchantId, params });
    return Promise.resolve(this.result ?? { queued: params.subscriptionIds.length, skipped: [] });
  }
}

let store: InMemoryInsightActionStore;
let engine: FakeActionEngine;
let audit: FakeAudit;
let events: FakeDomainEvents;
let policy: RecordingPolicy;
let sender: RecordingWinback;
let productId: string | null;
let service: InsightActionService;
const logs: string[] = [];

beforeEach(() => {
  store = new InMemoryInsightActionStore();
  engine = new FakeActionEngine();
  audit = new FakeAudit();
  events = new FakeDomainEvents();
  policy = new RecordingPolicy();
  sender = new RecordingWinback();
  productId = "PROD-1";
  logs.length = 0;
  service = new InsightActionService({
    store,
    estimates: new DeterministicEstimateProvider(inputs),
    engine,
    audit,
    events,
    policy,
    winback: sender,
    products: { productIdFor: () => Promise.resolve(productId) },
    log: { info: (_o, msg) => logs.push(msg), error: (_o, msg) => logs.push(msg) },
  });
});

const kinds = () => audit.entries.map((e) => e.kind);
describe("propose", () => {
  it("stores a proposed action with a deterministic estimate, announces and audits it", async () => {
    const row = await service.propose(M1, createPlan, "copilot", "23 people left over price");
    expect(row).toMatchObject({
      merchantId: M1,
      kind: "create_plan",
      state: "proposed",
      rationale: "23 people left over price",
      proposedBy: "copilot",
      actionId: null,
      decidedAt: null,
    });
    expect(row.estimate?.monthlyRevenueImpact).toEqual({ value: "3.60", currency: "USD" });
    expect(row.estimate?.basis).toContain("23 price-reason cancellations in 30 days");
    expect(events.emitted.map((e) => [e.type, e.payload])).toEqual([
      ["insight_action.proposed", { insightActionId: row.id }],
    ]);
    expect(kinds()).toEqual(["insight_action.proposed"]);
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it("executes nothing on its own", async () => {
    await service.propose(M1, createPlan, "copilot");
    await service.propose(M1, updatePolicy, "merchant_mcp");
    await service.propose(M1, winback, "copilot");
    expect(engine.actions).toHaveLength(0);
    expect(policy.calls).toHaveLength(0);
    expect(sender.calls).toHaveLength(0);
  });

  it("stores a null estimate when there is no data", async () => {
    const empty = new InsightActionService({
      ...optionsWith({
        priceCancellations: () => Promise.resolve(0),
        planFootprints: () => Promise.resolve([]),
      }),
    });
    const row = await empty.propose(M1, createPlan, "copilot");
    expect(row.estimate).toBeNull();
    expect(audit.entries[0]?.payload["estimateBasis"]).toMatch(/nothing to estimate from/);
  });

  it("rejects a proposal that fails the contract before anything is written", async () => {
    const bad = { kind: "create_plan", params: { name: "Basics", price: 4 } };
    await expect(service.propose(M1, bad, "copilot")).rejects.toMatchObject({ code: "invalid_request" });
    expect(store.rows).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });
});

function optionsWith(est: EstimateInputs) {
  return {
    store,
    estimates: new DeterministicEstimateProvider(est),
    engine,
    audit,
    events,
    policy,
    winback: sender,
    products: { productIdFor: () => Promise.resolve(productId) },
    log: { info: () => {}, error: () => {} },
  };
}

describe("approve", () => {
  it("create_plan: exactly one engine Action with origin insight, and the row records it", async () => {
    const proposed = await service.propose(M1, createPlan, "copilot");
    const done = await service.approve(proposed.id, principal(M1));

    expect(engine.actions).toHaveLength(1);
    expect(engine.actions[0]).toMatchObject({
      merchantId: M1,
      type: "create_plan",
      origin: "insight",
      subscriptionId: null,
      idempotencyKey: `insight-action:${proposed.id}`,
      params: {
        productId: "PROD-1",
        name: "Basics",
        price: { value: "4.00", currency: "USD" },
        interval: monthly,
      },
    });
    expect(done).toMatchObject({ state: "executed", actionId: engine.actions[0]?.id });
    expect(done.decidedAt).not.toBeNull();
    expect(kinds()).toEqual([
      "insight_action.proposed",
      "insight_action.approved",
      "insight_action.executed",
    ]);
  });

  it("cannot be approved twice, and the second try creates no second Action", async () => {
    const { id } = await service.propose(M1, createPlan, "copilot");
    await service.approve(id, principal(M1));
    await expect(service.approve(id, principal(M1))).rejects.toMatchObject({
      code: "conflict",
      message: "Can't approve an action that is already executed",
    });
    expect(engine.actions).toHaveLength(1);
  });

  it("cannot approve a rejected action", async () => {
    const { id } = await service.propose(M1, createPlan, "copilot");
    await service.reject(id, principal(M1));
    await expect(service.approve(id, principal(M1))).rejects.toMatchObject({ code: "conflict" });
    expect(engine.actions).toHaveLength(0);
  });

  it("update_policy publishes through the policy seam and audits the version", async () => {
    const { id } = await service.propose(M1, updatePolicy, "copilot");
    const done = await service.approve(id, principal(M1));
    expect(policy.calls).toEqual([updatePolicy.params]);
    expect(done).toMatchObject({ state: "executed", actionId: null });
    expect(audit.entries.at(-1)).toMatchObject({
      kind: "insight_action.executed",
      payload: { kind: "update_policy", policyVersion: 7 },
    });
    expect(engine.actions).toHaveLength(0);
  });

  it("send_winback_batch hands the subscriptions to the win-back sender", async () => {
    const { id } = await service.propose(M1, winback, "copilot");
    const done = await service.approve(id, principal(M1));
    expect(sender.calls).toEqual([{ merchantId: M1, params: winback.params }]);
    expect(done.state).toBe("executed");
    expect(audit.entries.at(-1)?.payload).toMatchObject({ queued: 1, skipped: [] });
  });

  it("fails a win-back batch that queued nothing, and the audit keeps the reasons", async () => {
    const other = "0199a1b2-c3d4-7e5f-8a6b-000000000002";
    const skipped = [
      { subscriptionId: SUB, reason: "no win-back case" },
      { subscriptionId: other, reason: "opted out" },
    ];
    sender.result = { queued: 0, skipped };
    const { id } = await service.propose(
      M1,
      { kind: "send_winback_batch", params: { subscriptionIds: [SUB, other], reason: "price" } },
      "copilot",
    );
    const done = await service.approve(id, principal(M1));
    expect(done).toMatchObject({
      state: "failed",
      error: `no subscription could be messaged: ${SUB} (no win-back case); ${other} (opted out)`,
    });
    expect(audit.entries.at(-1)).toMatchObject({
      kind: "insight_action.failed",
      payload: { queued: 0, skipped, error: done.error },
    });
    expect(kinds()).toEqual(["insight_action.proposed", "insight_action.approved", "insight_action.failed"]);
    expect(engine.actions).toHaveLength(0);
  });

  it("records a partial win-back batch as executed with the real counts", async () => {
    const ids = [
      "0199a1b2-c3d4-7e5f-8a6b-000000000101",
      "0199a1b2-c3d4-7e5f-8a6b-000000000102",
      "0199a1b2-c3d4-7e5f-8a6b-000000000103",
      "0199a1b2-c3d4-7e5f-8a6b-000000000104",
      "0199a1b2-c3d4-7e5f-8a6b-000000000105",
    ] as const;
    const skipped = [
      { subscriptionId: ids[3], reason: "no win-back case" },
      { subscriptionId: ids[4], reason: "opted out" },
    ];
    sender.result = { queued: 3, skipped };
    const { id } = await service.propose(
      M1,
      { kind: "send_winback_batch", params: { subscriptionIds: ids, reason: "price" } },
      "copilot",
    );
    const done = await service.approve(id, principal(M1));
    expect(done).toMatchObject({ state: "executed", error: null });
    expect(audit.entries.at(-1)).toMatchObject({
      kind: "insight_action.executed",
      payload: { kind: "send_winback_batch", queued: 3, skipped },
    });
    expect(sender.calls).toHaveLength(1);
  });

  it("records a failure instead of throwing, and a failed action cannot be approved again", async () => {
    policy.failWith = new Error("Policy changed since this was proposed");
    const { id } = await service.propose(M1, updatePolicy, "copilot");
    const done = await service.approve(id, principal(M1));
    expect(done).toMatchObject({ state: "failed", error: "Policy changed since this was proposed" });
    expect(audit.entries.at(-1)).toMatchObject({
      kind: "insight_action.failed",
      payload: { error: "Policy changed since this was proposed" },
    });
    await expect(service.approve(id, principal(M1))).rejects.toMatchObject({ code: "conflict" });
    expect(logs).toContain("insight action failed");
  });

  it("fails create_plan cleanly when the base plan is unknown, with no Action created", async () => {
    productId = null;
    const { id } = await service.propose(M1, createPlan, "copilot");
    const done = await service.approve(id, principal(M1));
    expect(done.state).toBe("failed");
    expect(done.error).toContain("P-STANDARD");
    expect(engine.actions).toHaveLength(0);
  });

  it("is merchant-scoped: another merchant cannot see, approve or reject it", async () => {
    const { id } = await service.propose(M1, createPlan, "copilot");
    await expect(service.approve(id, principal(M2))).rejects.toMatchObject({ code: "not_found" });
    await expect(service.reject(id, principal(M2))).rejects.toMatchObject({ code: "not_found" });
    expect(await service.list(M2)).toEqual([]);
    expect(await service.list(M1)).toHaveLength(1);
    expect(store.rows[0]?.state).toBe("proposed");
    expect(engine.actions).toHaveLength(0);
  });

  it("answers not_found for an id that does not exist", async () => {
    const err: unknown = await service
      .approve("0199a1b2-c3d4-7e5f-8a6b-00000000ffff", principal(M1))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsightActionError);
    expect((err as InsightActionError).status).toBe(404);
  });
});

describe("reject and list", () => {
  it("reject moves proposed -> rejected, stamps decidedAt and audits; it cannot be repeated", async () => {
    const { id } = await service.propose(M1, createPlan, "copilot");
    const done = await service.reject(id, principal(M1));
    expect(done.state).toBe("rejected");
    expect(done.decidedAt).not.toBeNull();
    expect(kinds().at(-1)).toBe("insight_action.rejected");
    await expect(service.reject(id, principal(M1))).rejects.toMatchObject({ code: "conflict" });
  });

  it("lists newest first and filters by state", async () => {
    const a = await service.propose(M1, createPlan, "copilot");
    const b = await service.propose(M1, updatePolicy, "copilot");
    await service.reject(a.id, principal(M1));
    expect((await service.list(M1)).map((r) => r.id)).toEqual([b.id, a.id]);
    expect((await service.list(M1, "proposed")).map((r) => r.id)).toEqual([b.id]);
    expect((await service.list(M1, "rejected")).map((r) => r.id)).toEqual([a.id]);
  });
});

describe("store guards", () => {
  it("refuses transitions the table does not allow", async () => {
    const row = await store.create({
      merchantId: M1,
      kind: "create_plan",
      params: {},
      rationale: "",
      estimate: null,
      proposedBy: "copilot",
    });
    await expect(store.transition(M1, row.id, "proposed", "executed")).rejects.toThrow(/cannot move/);
    await expect(store.transition(M1, row.id, "rejected", "approved")).rejects.toThrow(/cannot move/);
  });
});
