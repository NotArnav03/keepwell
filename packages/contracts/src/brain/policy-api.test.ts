import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { FakeAgent } from "../fakes/agent.js";
import { PANTRY_PLAN, pantryPlanSubscription } from "../fakes/pantry-plan.js";
import { FakePolicyStore } from "../fakes/policy-store.js";
import { ReasonCategory } from "../shared.js";
import {
  ListPoliciesResponse,
  PolicyDraft,
  PolicyDryRunRequest,
  PolicyDryRunResponse,
  PolicyError,
  PolicyVersionResponse,
  PublishPolicyRequest,
  StoredPolicy,
} from "./policy-api.js";
import type { PolicyContext } from "./policy.js";

const MERCHANT = PANTRY_PLAN.merchantId;
const SUB = "0199a1b2-c3d4-7e5f-8a6b-000000000001";
const T = new Date("2026-10-29T10:00:00.000Z");
const { version: _version, ...draft } = PANTRY_PLAN.policy;

function roundTrips<S extends z.ZodType>(schema: S, value: unknown): void {
  const once = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
}

const publishInput = (baseVersion: number | null) => ({
  merchantId: MERCHANT,
  baseVersion,
  document: draft,
  changeNote: null,
  publishedBy: "owner@pantryplan.example",
});

describe("policy API schemas", () => {
  it("a draft is a policy without its version", () => {
    expect(PolicyDraft.parse(draft)).toEqual(draft);
    expect(PolicyDraft.parse(PANTRY_PLAN.policy)).not.toHaveProperty("version");
  });

  it("publish requests are strict and trim the change note", () => {
    const body = PublishPolicyRequest.parse({
      baseVersion: 1,
      document: draft,
      changeNote: "  more pauses ",
    });
    expect(body.changeNote).toBe("more pauses");
    expect(PublishPolicyRequest.safeParse({ ...body, version: 3 }).success).toBe(false);
    expect(PublishPolicyRequest.safeParse({ ...body, changeNote: "x".repeat(281) }).success).toBe(false);
    expect(PublishPolicyRequest.safeParse({ baseVersion: 0, document: draft }).success).toBe(false);
  });

  it("dry-run requests take 1 to 20 subscription ids", () => {
    expect(PolicyDryRunRequest.safeParse({ document: draft, sampleSubscriptionIds: [] }).success).toBe(false);
    const many = Array.from({ length: 21 }, () => SUB);
    expect(PolicyDryRunRequest.safeParse({ document: draft, sampleSubscriptionIds: many }).success).toBe(
      false,
    );
    roundTrips(PolicyDryRunRequest, { document: draft, sampleSubscriptionIds: [SUB] });
  });

  it("responses round-trip", async () => {
    const store = new FakePolicyStore(() => T);
    const stored = await store.publish(publishInput(null));
    roundTrips(StoredPolicy, stored);
    roundTrips(PolicyVersionResponse, stored);
    roundTrips(ListPoliciesResponse, { currentVersion: 1, versions: await store.list(MERCHANT) });

    const context: PolicyContext = {
      now: T.toISOString(),
      channel: "widget",
      reason: "unknown",
      cancelIntent: false,
      offersPresentedThisSession: 0,
      subscription: pantryPlanSubscription(T),
      history: {
        savesLast365d: 0,
        pausesLast365d: 0,
        lastPauseEndedAt: null,
        refundedLast30d: { value: "0.00", currency: "USD" },
      },
      plans: PANTRY_PLAN.plans,
    };
    const { menu } = await new FakeAgent({ clock: () => T }).start({
      sessionId: "0199a1b2-c3d4-7e5f-8a6b-00000000aaaa",
      merchantId: MERCHANT,
      channel: "widget",
      policy: PANTRY_PLAN.policy,
      subscription: context.subscription,
      history: context.history,
      plans: context.plans,
      menu: null,
      transcript: [],
      presentedOfferId: null,
      fallbackLevel: "L0",
    });
    const byReason = Object.fromEntries(ReasonCategory.options.map((r) => [r, menu.offers.map((o) => o.id)]));
    roundTrips(PolicyDryRunResponse, {
      computedAt: T.toISOString(),
      samples: [
        {
          subscriptionId: SUB,
          subscriberFirstName: "Maya",
          planName: "Standard",
          context,
          menu,
          offerIdsByReason: byReason,
        },
      ],
      missingSubscriptionIds: [],
    });
  });

  it("PolicyError maps codes to HTTP statuses", () => {
    expect(new PolicyError("version_conflict", "x").status).toBe(409);
    expect(new PolicyError("invalid_policy", "x", [{ path: "offers.downgrade", message: "y" }]).status).toBe(
      422,
    );
  });
});

describe("FakePolicyStore", () => {
  it("appends versions 1, 2, ... and keeps each one immutable", async () => {
    const store = new FakePolicyStore(() => T);
    expect(await store.current(MERCHANT)).toBeNull();
    const v1 = await store.publish(publishInput(null));
    const v2 = await store.publish({ ...publishInput(1), changeNote: "longer pauses" });
    expect([v1.version, v1.document.version, v2.version, v2.document.version]).toEqual([1, 1, 2, 2]);
    expect((await store.current(MERCHANT))?.version).toBe(2);
    expect((await store.get(MERCHANT, 1))?.changeNote).toBeNull();
    expect((await store.list(MERCHANT)).map((s) => s.version)).toEqual([2, 1]);
    v1.document.tone = "brief";
    expect((await store.get(MERCHANT, 1))?.document.tone).toBe(PANTRY_PLAN.policy.tone);
  });

  it("refuses a stale base version instead of overwriting", async () => {
    const store = new FakePolicyStore(() => T);
    await store.publish(publishInput(null));
    await expect(store.publish(publishInput(null))).rejects.toMatchObject({ code: "version_conflict" });
    await store.publish(publishInput(1));
    await expect(store.publish(publishInput(1))).rejects.toBeInstanceOf(PolicyError);
    expect(await store.get(MERCHANT, 3)).toBeNull();
  });

  it("keeps merchants apart", async () => {
    const store = new FakePolicyStore(() => T);
    await store.publish(publishInput(null));
    expect(await store.current("0199a1b2-c3d4-7e5f-8a6b-ffffffffffff")).toBeNull();
  });
});
