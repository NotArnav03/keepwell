import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DomainEvent } from "@keepwell/contracts";
import { createDb, merchants, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { DbDomainEvents } from "./domain-events.js";
import { Jobs } from "./jobs.js";

// Jobs and domain events against a real Postgres with pg-boss running.

const M = "0199d000-0000-7000-8000-00000000000a";
const SUB = "0199d000-0000-7000-8000-0000000000b1";
const ACTION = "0199d000-0000-7000-8000-0000000000c1";

let testDb: TestDatabase;
let db: Db;
let jobs: Jobs;
let events: DbDomainEvents;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

const actionChanged = (to: "PENDING" | "EXECUTING") => ({
  type: "action.state_changed" as const,
  merchantId: M,
  payload: {
    actionId: ACTION,
    subscriptionId: SUB,
    type: "suspend" as const,
    from: null,
    to,
    approveUrl: null,
    error: null,
  },
});

/** The `to` state of an action.state_changed event. */
const toOf = (event: DomainEvent) => (event.payload as { to?: string }).to;

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

it.runIf(process.env.KEEPWELL_REQUIRE_DATABASE_TESTS === "1" && TEST_DATABASE_URL === undefined)(
  "has a test database when the database tests are required",
  () => {
    expect.fail("KEEPWELL_REQUIRE_DATABASE_TESTS is set but KEEPWELL_TEST_DATABASE_URL is not");
  },
);

describe.skipIf(TEST_DATABASE_URL === undefined)("Jobs and DbDomainEvents", { timeout: 60_000 }, () => {
  const delivered: { handler: string; event: DomainEvent }[] = [];
  let flakyFailuresLeft = 1;

  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    await db.forMerchant(M, (tx) => tx.insert(merchants).values({ id: M, slug: "jobs", name: "Jobs" }));
    jobs = await Jobs.start({
      connectionString: testDb.url,
      log: quiet,
      pollingIntervalSeconds: 0.5,
      retryDelaySeconds: 1,
    });
    events = new DbDomainEvents(db, jobs, quiet);
    events.on("action.state_changed", "test.recorder", (event) => {
      delivered.push({ handler: "test.recorder", event });
      return Promise.resolve();
    });
    events.on("action.state_changed", "test.flaky", (event) => {
      if (flakyFailuresLeft-- > 0) return Promise.reject(new Error("flaky handler"));
      delivered.push({ handler: "test.flaky", event });
      return Promise.resolve();
    });
    await events.startWorker();
  }, 120_000);

  afterAll(async () => {
    await jobs.stop();
    await testDb.drop();
  }, 60_000);

  it("delivers a committed event to every handler, once each, retrying the one that failed", async () => {
    await db.forMerchant(M, (tx) => events.emit(actionChanged("PENDING"), tx));
    await until(() => delivered.filter((d) => toOf(d.event) === "PENDING").length === 2);
    expect(delivered.map((d) => d.handler).sort()).toEqual(["test.flaky", "test.recorder"]);
    expect(delivered[0]?.event).toMatchObject({
      type: "action.state_changed",
      merchantId: M,
      simulated: false,
    });
  });

  it("delivers nothing when the emitting transaction rolls back", async () => {
    const dispatchJobs = async () =>
      (
        await testDb.ownerPool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'domain.dispatch'",
        )
      ).rows[0]?.n;
    const before = await dispatchJobs();
    await expect(
      db.forMerchant(M, async (tx) => {
        await events.emit(actionChanged("EXECUTING"), tx);
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    await new Promise((r) => setTimeout(r, 2000));
    expect(delivered.filter((d) => toOf(d.event) === "EXECUTING")).toEqual([]);
    // The dispatch jobs rolled back with the event: none was ever queued.
    expect(await dispatchJobs()).toBe(before);
  });

  it("refuses a payload that breaks the producer's schema", async () => {
    await expect(
      events.emit({
        ...actionChanged("PENDING"),
        payload: { ...actionChanged("PENDING").payload, actionId: "nope" },
      }),
    ).rejects.toThrow();
  });

  it("treats a repeated idempotency key as one job", async () => {
    const first = await jobs.send("action.execute", { actionId: ACTION });
    const second = await jobs.send("action.execute", { actionId: ACTION });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("validates a job's payload on the way in", async () => {
    await expect(jobs.send("action.execute", { actionId: "not-a-uuid" })).rejects.toThrow();
  });
});
