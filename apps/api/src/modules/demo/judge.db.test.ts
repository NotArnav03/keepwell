import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAudit, FakeDomainEvents, PANTRY_PLAN } from "@keepwell/contracts/fakes";
import { createDb, merchants, subscriptions, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { DbActionEngine } from "../actions/engine.js";
import { DbTimeMachine } from "./judge.js";

// The time machine against Postgres: a pause's resume runs now, as a real activate Action, and is
// audited as a TIME SHIFT by the demo actor. No PayPal call happens here: the Action is created and
// queued, and the worker would execute it.

const M = PANTRY_PLAN.merchantId;
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
let testDb: TestDatabase;
let db: Db;

async function addSubscription(key: string): Promise<string> {
  const [row] = await db.forMerchant(M, (tx) =>
    tx
      .insert(subscriptions)
      .values({
        merchantId: M,
        paypalSubscriptionId: `I-${key}`,
        paypalPlanId: "P-STANDARD",
        planName: "Standard",
        status: "SUSPENDED",
        intervalUnit: "MONTH",
        intervalCount: 1,
        priceValue: "12.00",
        priceCurrency: "USD",
        startedAt: new Date("2026-03-01T00:00:00Z"),
        snapshot: {},
        syncedAt: new Date(),
      })
      .returning({ id: subscriptions.id }),
  );
  if (!row) throw new Error("seed failed");
  return row.id;
}

describe.skipIf(TEST_DATABASE_URL === undefined)("DbTimeMachine", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    await db.forMerchant(M, (tx) =>
      tx.insert(merchants).values({ id: M, slug: "prod-demo", name: "Pantry Plan" }),
    );
  }, 120_000);

  afterAll(async () => {
    await testDb.drop();
  }, 60_000);

  const build = () => {
    const audit = new FakeAudit();
    const engine = new DbActionEngine({
      db,
      lockPool: testDb.appPool,
      paypal: {} as never,
      audit,
      events: new FakeDomainEvents(),
      log: quiet,
    });
    return { engine, audit, machine: new DbTimeMachine({ db, engine, audit }) };
  };

  it("runs a pause's resume now as an activate Action, audited as a TIME SHIFT", async () => {
    const { engine, audit, machine } = build();
    const subscriptionId = await addSubscription("JUDGE0001");
    const dueAt = new Date(Date.now() + 60 * 24 * 3600_000).toISOString();
    const resumeId = await engine.scheduleResume({ merchantId: M, subscriptionId, dueAt });

    const { actionId, note } = await machine.resumeNow(M, subscriptionId);
    expect(actionId).not.toBeNull();
    expect(note).toContain("TIME SHIFT");
    const action = await testDb.ownerPool.query<{ type: string; subscription_id: string }>(
      "SELECT type, subscription_id FROM actions WHERE id = $1",
      [actionId],
    );
    expect(action.rows[0]).toEqual({ type: "activate", subscription_id: subscriptionId });
    const resume = await testDb.ownerPool.query<{ status: string }>(
      "SELECT status FROM scheduled_resumes WHERE id = $1",
      [resumeId],
    );
    expect(resume.rows[0]?.status).toBe("done");
    expect(audit.entries.find((e) => e.kind === "demo.time_shift")).toMatchObject({
      actor: "demo",
      payload: { label: "TIME SHIFT" },
    });
  });

  it("does nothing, and says why, when there is no applied pause to resume", async () => {
    const { machine, audit } = build();
    const subscriptionId = await addSubscription("JUDGE0002");
    const result = await machine.resumeNow(M, subscriptionId);
    expect(result.actionId).toBeNull();
    expect(result.note).toContain("Nothing to resume");
    expect(audit.entries).toEqual([]);
  });
});
