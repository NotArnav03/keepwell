import { describe, expect, it } from "vitest";
import { PANTRY_PLAN } from "@keepwell/contracts/fakes";
import type { PublishPolicyRequest } from "@keepwell/contracts";
import { applyChange, WinbackStartBatchSender, PolicyApiPublisher, type PolicyApi } from "./adapters.js";
import type { MerchantPrincipal } from "./service.js";

const principal: MerchantPrincipal = {
  merchantId: PANTRY_PLAN.merchantId,
  userLabel: "owner@pantry.example",
};

describe("applyChange", () => {
  it("sets a nested value when `from` matches", () => {
    const doc = { pause: { maxMonths: 1 }, list: [{ id: "a" }] };
    applyChange(doc, { path: "pause.maxMonths", from: 1, to: 3 });
    applyChange(doc, { path: "list.0.id", from: "a", to: "b" });
    expect(doc).toEqual({ pause: { maxMonths: 3 }, list: [{ id: "b" }] });
  });

  it("refuses when the policy moved on since the proposal", () => {
    const doc = { pause: { maxMonths: 2 } };
    expect(() => applyChange(doc, { path: "pause.maxMonths", from: 1, to: 3 })).toThrow(/changed since/);
    expect(doc.pause.maxMonths).toBe(2);
  });

  it("refuses a path that does not exist", () => {
    expect(() => applyChange({ a: 1 }, { path: "x.y", from: null, to: 1 })).toThrow(/does not exist/);
    expect(() => applyChange({ a: 1 }, { path: "a.b", from: null, to: 1 })).toThrow(/does not exist/);
  });

  it("allows adding a key when `from` is undefined", () => {
    const doc: Record<string, unknown> = {};
    applyChange(doc, { path: "note", from: undefined, to: "hi" });
    expect(doc).toEqual({ note: "hi" });
  });
});

describe("PolicyApiPublisher", () => {
  const { version, ...draft } = PANTRY_PLAN.policy;
  const current = { version, document: { ...PANTRY_PLAN.policy } };

  function api(currentVersion: number | null) {
    const published: PublishPolicyRequest[] = [];
    const policies: PolicyApi = {
      list: () => Promise.resolve({ currentVersion }),
      get: () => Promise.resolve(structuredClone(current)),
      publish: (_p, body) => {
        published.push(body);
        return Promise.resolve({ version: version + 1 });
      },
    };
    return { policies, published };
  }

  it("publishes the changed document on top of the current version, without its version field", async () => {
    const { policies, published } = api(version);
    const key = "tone";
    const from = (draft as Record<string, unknown>)[key];
    const to = from === "brief" ? "warm" : "brief";
    const result = await new PolicyApiPublisher(policies).publishChanges(principal, {
      summary: "Tweak",
      changes: [{ path: key, from, to }],
    });
    expect(result).toEqual({ version: version + 1 });
    expect(published).toHaveLength(1);
    expect(published[0]?.baseVersion).toBe(version);
    expect(published[0]?.changeNote).toBe("Tweak");
    expect(published[0]?.document).not.toHaveProperty("version");
    expect((published[0]?.document as Record<string, unknown>)[key]).toBe(to);
  });

  it("fails when there is no policy yet, publishing nothing", async () => {
    const { policies, published } = api(null);
    await expect(
      new PolicyApiPublisher(policies).publishChanges(principal, {
        summary: "x",
        changes: [{ path: "a", from: 1, to: 2 }],
      }),
    ).rejects.toThrow(/no published policy/);
    expect(published).toHaveLength(0);
  });
});

describe("WinbackStartBatchSender", () => {
  const ids = ["0199a1b2-c3d4-7e5f-8a6b-000000000011", "0199a1b2-c3d4-7e5f-8a6b-000000000012"];

  it("passes the merchant and ids to startBatch and returns its true counts", async () => {
    const calls: [string, string[]][] = [];
    const sender = new WinbackStartBatchSender({
      startBatch: (merchantId, subscriptionIds) => {
        calls.push([merchantId, subscriptionIds]);
        return Promise.resolve({
          queued: 1,
          skipped: [{ subscriptionId: ids[1] ?? "", reason: "not_cancelled" }],
        });
      },
    });
    await expect(
      sender.send(principal.merchantId, { subscriptionIds: ids, reason: "price" }),
    ).resolves.toEqual({ queued: 1, skipped: [{ subscriptionId: ids[1], reason: "not_cancelled" }] });
    expect(calls).toEqual([[principal.merchantId, ids]]);
  });

  it("lets a startBatch failure through, so approve() records the action as failed", async () => {
    const sender = new WinbackStartBatchSender({
      startBatch: () => Promise.reject(new Error("batch limit is 500")),
    });
    await expect(
      sender.send(principal.merchantId, { subscriptionIds: ids, reason: "price" }),
    ).rejects.toThrow(/batch limit/);
  });
});
