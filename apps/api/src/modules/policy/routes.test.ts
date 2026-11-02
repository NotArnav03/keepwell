import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ErrorEnvelope,
  ListPoliciesResponse,
  PolicyDryRunResponse,
  PolicyError,
  PolicyVersionResponse,
  type PolicyDraft,
} from "@keepwell/contracts";
import {
  FakeAudit,
  FakeDomainEvents,
  FakePolicyStore,
  PANTRY_PLAN,
  pantryPlanSubscription,
} from "@keepwell/contracts/fakes";
import { loadEnv } from "../../env.js";
import { buildServer } from "../../server.js";
import { policyRoutes } from "./routes.js";
import { PolicyService, type MerchantCatalog, type MerchantPrincipal } from "./service.js";

const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const NOW = new Date("2026-11-01T10:00:00.000Z");
const MERCHANT = PANTRY_PLAN.merchantId;
const principal: MerchantPrincipal = { merchantId: MERCHANT, userLabel: "owner@pantryplan.example" };
const maya = pantryPlanSubscription(NOW);
const OTHER_ID = "0199a1b2-c3d4-7e5f-8a6b-0000000000ff";
const { version: _version, ...draft } = PANTRY_PLAN.policy;

const catalog: MerchantCatalog = {
  plans: () => Promise.resolve([...PANTRY_PLAN.plans]),
  samples: (_merchantId, ids) =>
    Promise.resolve(
      ids.includes(maya.id)
        ? [
            {
              subscription: maya,
              history: {
                savesLast365d: 0,
                pausesLast365d: 0,
                lastPauseEndedAt: null,
                refundedLast30d: { value: "0.00", currency: "USD" },
              },
            },
          ]
        : [],
    ),
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(authenticate: () => Promise<MerchantPrincipal> = () => Promise.resolve(principal)) {
  const store = new FakePolicyStore(() => NOW);
  const events = new FakeDomainEvents(() => NOW);
  const audit = new FakeAudit(() => NOW);
  const service = new PolicyService({ store, catalog, events, audit, clock: () => NOW });
  app = buildServer(env);
  await app.register(policyRoutes, { prefix: "/v1/m", service, authenticate });
  await app.ready();
  const server = app;
  const publish = (body: unknown) =>
    server.inject({ method: "POST", url: "/v1/m/policies", payload: body as object });
  return { server, store, events, audit, publish };
}

const errorOf = (body: unknown) => ErrorEnvelope.parse(body).error;

describe("policy routes", () => {
  it("lists nothing before the first publish", async () => {
    const { server } = await start();
    const res = await server.inject({ method: "GET", url: "/v1/m/policies" });
    expect(ListPoliciesResponse.parse(res.json())).toEqual({ currentVersion: null, versions: [] });
  });

  it("publishes v1 then v2, announces and audits each", async () => {
    const { server, events, audit, publish } = await start();
    const v1 = await publish({ baseVersion: null, document: draft });
    expect(v1.statusCode).toBe(201);
    expect(PolicyVersionResponse.parse(v1.json())).toMatchObject({
      version: 1,
      publishedBy: principal.userLabel,
      changeNote: null,
      document: { ...draft, version: 1 },
    });
    const v2 = await publish({
      baseVersion: 1,
      document: { ...draft, tone: "brief" },
      changeNote: "shorter replies",
    });
    expect(v2.statusCode).toBe(201);

    const list = ListPoliciesResponse.parse(
      (await server.inject({ method: "GET", url: "/v1/m/policies" })).json(),
    );
    expect(list.currentVersion).toBe(2);
    expect(list.versions.map((v) => [v.version, v.changeNote])).toEqual([
      [2, "shorter replies"],
      [1, null],
    ]);
    const old = PolicyVersionResponse.parse(
      (await server.inject({ method: "GET", url: "/v1/m/policies/1" })).json(),
    );
    expect(old.document.tone).toBe(draft.tone);

    expect(events.ofType("policy.published").map((e) => e.payload.version)).toEqual([1, 2]);
    expect(audit.byKind("policy.published").map((e) => [e.actor, e.subjectIds.policyVersion])).toEqual([
      ["merchant", "1"],
      ["merchant", "2"],
    ]);
  });

  it("refuses a stale base version with 409", async () => {
    const { publish, events } = await start();
    await publish({ baseVersion: null, document: draft });
    const stale = await publish({ baseVersion: null, document: draft });
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale.json()).code).toBe("version_conflict");
    expect(events.emitted).toHaveLength(1);
  });

  it("refuses a policy that contradicts the plans with 422 and the paths to fix", async () => {
    const { publish, store, events, audit } = await start();
    const bad: PolicyDraft = {
      ...draft,
      offers: {
        ...draft.offers,
        downgrade: { enabled: true, targets: { [PANTRY_PLAN.lite.planId]: ["P-GONE"] } },
      },
    };
    const res = await publish({ baseVersion: null, document: bad });
    expect(res.statusCode).toBe(422);
    const error = errorOf(res.json());
    expect(error.code).toBe("invalid_policy");
    expect(error.details).toEqual([
      {
        path: `offers.downgrade.targets.${PANTRY_PLAN.lite.planId}.0`,
        message: "P-GONE isn't one of your plans",
      },
    ]);
    expect(await store.current(MERCHANT)).toBeNull();
    expect(events.emitted).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it("rejects malformed bodies and params with 400", async () => {
    const { server, publish } = await start();
    expect((await publish({ baseVersion: null, document: { ...draft, version: 7 } })).statusCode).toBe(400);
    expect((await publish({ baseVersion: null })).statusCode).toBe(400);
    const notJson = await server.inject({
      method: "POST",
      url: "/v1/m/policies",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(errorOf(notJson.json()).code).toBe("invalid_request");
    expect((await server.inject({ method: "GET", url: "/v1/m/policies/abc" })).statusCode).toBe(400);
  });

  it("returns 404 for a version that doesn't exist", async () => {
    const { server } = await start();
    const res = await server.inject({ method: "GET", url: "/v1/m/policies/9" });
    expect(res.statusCode).toBe(404);
    expect(errorOf(res.json()).code).toBe("not_found");
  });

  it("returns 401 when the merchant can't be authenticated, and 500 for anything unexpected", async () => {
    const unauthorized = await start(() => Promise.reject(new PolicyError("unauthorized", "Log in first")));
    expect((await unauthorized.server.inject({ method: "GET", url: "/v1/m/policies" })).statusCode).toBe(401);
    await app?.close();
    const broken = await start(() => Promise.reject(new Error("database down")));
    const res = await broken.server.inject({ method: "GET", url: "/v1/m/policies" });
    expect(res.statusCode).toBe(500);
    expect(errorOf(res.json()).message).not.toContain("database");
  });
});

describe("dry-run", () => {
  const dryRun = (server: FastifyInstance, body: unknown) =>
    server.inject({ method: "POST", url: "/v1/m/policies/dry-run", payload: body as object });

  it("returns each sample's menu, offers per reason and inputs, and stores nothing", async () => {
    const { server, store, events } = await start();
    const res = await dryRun(server, {
      document: draft,
      sampleSubscriptionIds: [maya.id, OTHER_ID, maya.id],
    });
    expect(res.statusCode).toBe(200);
    const body = PolicyDryRunResponse.parse(res.json());
    expect(body.problems).toEqual([]);
    expect(body.missingSubscriptionIds).toEqual([OTHER_ID]);
    expect(body.samples).toHaveLength(1);
    const [sample] = body.samples;
    expect(sample?.menu.policyVersion).toBe(1);
    expect(sample?.context).toMatchObject({ reason: "unknown", now: NOW.toISOString() });
    expect(sample?.menu.offers.length).toBeGreaterThan(0);
    // A missing feature isn't fixed by a discount: by default nothing is offered.
    expect(sample?.offerIdsByReason.missing_feature).toEqual([]);
    const menuIds = new Set(sample?.menu.offers.map((o) => o.id));
    for (const ids of Object.values(sample?.offerIdsByReason ?? {}))
      for (const id of ids) expect(menuIds).toContain(id);
    expect(await store.current(MERCHANT)).toBeNull();
    expect(events.emitted).toHaveLength(0);
  });

  it("labels the menu with the next version and reports what Publish would reject", async () => {
    const { server, publish } = await start();
    await publish({ baseVersion: null, document: draft });
    const bad = {
      ...draft,
      offers: { ...draft.offers, switch_annual: { enabled: true, targets: { "P-X": "P-Y" } } },
    };
    const body = PolicyDryRunResponse.parse(
      (await dryRun(server, { document: bad, sampleSubscriptionIds: [maya.id] })).json(),
    );
    expect(body.samples[0]?.menu.policyVersion).toBe(2);
    expect(body.problems.map((p) => p.path)).toEqual(["offers.switch_annual.targets.P-X"]);
  });

  it("takes 1 to 20 sample ids", async () => {
    const { server } = await start();
    expect((await dryRun(server, { document: draft, sampleSubscriptionIds: [] })).statusCode).toBe(400);
  });
});
