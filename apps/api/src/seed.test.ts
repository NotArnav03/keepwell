import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAudit, FakeDomainEvents, PANTRY_PLAN } from "@keepwell/contracts/fakes";
import { actions, createDb, merchants, policies, subscriptions, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { createPayPalMock, PANTRY_PLAN_CREDENTIALS, pantryPlanFixture } from "@keepwell/paypal-mock";
import { DbActionEngine } from "./modules/actions/engine.js";
import { PayPalClient } from "./modules/paypal/client.js";
import { singleAppCredentials } from "./modules/paypal/credentials.js";
import { Reconciler } from "./modules/reconcile/reconciler.js";
import { SubscriptionSync } from "./modules/reconcile/sync.js";
import { seedDemoMerchant } from "./seed.js";

// The seed against paypal-mock and a real Postgres: with Pantry Plan's plans already at PayPal,
// and with a PayPal account that has nothing yet. Run twice each: the second run changes nothing.

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const EMPTY = {
  id: "0199f000-0000-7000-8000-00000000000e",
  name: "Empty",
  clientId: "empty-client",
  clientSecret: "empty-secret",
};

let testDb: TestDatabase;
let db: Db;

async function setUp(credentials: { clientId: string; clientSecret: string }, withFixtures: boolean) {
  const mock = createPayPalMock({
    fixtures: (now) =>
      withFixtures
        ? [pantryPlanFixture(now)]
        : [{ merchant: EMPTY, plans: [], subscriptions: [], transactions: [] }],
  });
  const paypal = new PayPalClient({
    baseUrl: await mock.listen(),
    credentials: singleAppCredentials(credentials),
    log: quiet,
    retryDelaysMs: [],
  });
  const events = new FakeDomainEvents();
  const engine = new DbActionEngine({
    db,
    lockPool: testDb.appPool,
    paypal,
    audit: new FakeAudit(),
    events,
    log: quiet,
  });
  const sync = new SubscriptionSync(db, paypal, events);
  const reconciler = new Reconciler({
    db,
    paypal,
    sync,
    engine,
    jobs: { send: () => Promise.resolve(null) },
    log: quiet,
  });
  return { mock, deps: { db, paypal, engine, reconciler, log: quiet } };
}

it.runIf(process.env.KEEPWELL_REQUIRE_DATABASE_TESTS === "1" && TEST_DATABASE_URL === undefined)(
  "has a test database when the database tests are required",
  () => {
    expect.fail("KEEPWELL_REQUIRE_DATABASE_TESTS is set but KEEPWELL_TEST_DATABASE_URL is not");
  },
);

describe.skipIf(TEST_DATABASE_URL === undefined)("pnpm seed", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
  }, 120_000);

  afterAll(async () => {
    await testDb.drop();
  }, 60_000);

  it("adopts the plans PayPal already has, registers one webhook, publishes v1 and imports everyone", async () => {
    const M = PANTRY_PLAN.merchantId;
    const { mock, deps } = await setUp(PANTRY_PLAN_CREDENTIALS, true);
    const options = { merchantId: M, webhookUrl: `http://localhost:3000/webhooks/paypal/${M}` };
    try {
      const first = await seedDemoMerchant(deps, options);
      expect(first).toMatchObject({
        createdMerchant: true,
        createdPlans: [],
        planIds: {
          lite: PANTRY_PLAN.lite.planId,
          standard: PANTRY_PLAN.standard.planId,
          standardAnnual: PANTRY_PLAN.annual.planId,
        },
        policyVersion: 1,
        importedSubscriptions: 12,
      });
      const second = await seedDemoMerchant(deps, options);
      expect(second).toMatchObject({
        createdMerchant: false,
        createdPlans: [],
        webhookId: first.webhookId,
        policyVersion: 1,
      });
      expect(mock.state.webhooks(M)).toHaveLength(1);

      const [merchant] = await db.forMerchant(M, (tx) => tx.select().from(merchants));
      expect(merchant).toMatchObject({ mode: "demo", webhookId: first.webhookId, activePolicyVersion: 1 });
      const [policy] = await db.forMerchant(M, (tx) => tx.select().from(policies));
      expect(JSON.stringify(policy?.document)).toContain(PANTRY_PLAN.lite.planId);
      expect(await db.forMerchant(M, (tx) => tx.select().from(subscriptions))).toHaveLength(12);
    } finally {
      await mock.close();
    }
  });

  it("creates the product and plans, as audited create_plan Actions, when PayPal has none", async () => {
    const { mock, deps } = await setUp(EMPTY, false);
    const options = {
      merchantId: EMPTY.id,
      slug: "empty",
      webhookUrl: `http://localhost:3000/webhooks/paypal/${EMPTY.id}`,
    };
    try {
      const first = await seedDemoMerchant(deps, options);
      expect(first.createdPlans).toHaveLength(3);
      expect(Object.values(first.planIds).sort()).toEqual([...first.createdPlans].sort());
      const atPayPal = mock.state.listPlans(EMPTY.id, null, { page: 1, pageSize: 20 }).items;
      expect(atPayPal.map((p) => p.name).sort()).toEqual(["Lite", "Standard", "Standard Annual"]);
      expect(new Set(atPayPal.map((p) => p.product_id)).size).toBe(1);
      const made = await db.forMerchant(EMPTY.id, (tx) =>
        tx.select().from(actions).where(eq(actions.type, "create_plan")),
      );
      expect(made.map((a) => a.state)).toEqual(["CONFIRMED", "CONFIRMED", "CONFIRMED"]);

      const second = await seedDemoMerchant(deps, options);
      expect(second.createdPlans).toEqual([]);
      expect(mock.state.listPlans(EMPTY.id, null, { page: 1, pageSize: 20 }).items).toHaveLength(3);
    } finally {
      await mock.close();
    }
  });
});
