import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeAudit, FakeDomainEvents, PANTRY_PLAN } from "@keepwell/contracts/fakes";
import { actions, createDb, merchants, scheduledResumes, subscriptions, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import {
  createPayPalMock,
  fixtureSubscriptionId,
  PANTRY_PLAN_CREDENTIALS,
  type PayPalMock,
} from "@keepwell/paypal-mock";
import { PayPalClient } from "../paypal/client.js";
import { singleAppCredentials } from "../paypal/credentials.js";
import { DbAudit } from "../audit/log.js";
import { DbActionEngine, type PayPalMutator } from "./engine.js";

// The engine against a real Postgres (row-level security, advisory locks) and paypal-mock over
// HTTP. Runs in CI's database job, or locally with KEEPWELL_TEST_DATABASE_URL.

const M = PANTRY_PLAN.merchantId;
const NAMES = ["maya", "raj", "tom", "lena", "chloe", "priya"] as const;
type Name = (typeof NAMES)[number];

let testDb: TestDatabase;
let db: Db;
let mock: PayPalMock;
let mockUrl: string;
let now: Date;
let audit: FakeAudit;
let events: FakeDomainEvents;
let calls: string[];
let engine: DbActionEngine;
const subId: Record<Name, string> = {} as Record<Name, string>;

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function makeEngine(options: Partial<ConstructorParameters<typeof DbActionEngine>[0]> = {}) {
  // One gateway attempt, so the engine's own retry handling is what's tested.
  const client = new PayPalClient({
    baseUrl: mockUrl,
    credentials: singleAppCredentials(PANTRY_PLAN_CREDENTIALS),
    log: quiet,
    retryDelaysMs: [],
  });
  const paypal: PayPalMutator = {
    getSubscription: (m, id) => client.getSubscription(m, id),
    suspend: (m, id, r) => (calls.push(`suspend ${id}`), client.suspend(m, id, r)),
    activate: (m, id, r) => (calls.push(`activate ${id}`), client.activate(m, id, r)),
    cancel: (m, id, r) => (calls.push(`cancel ${id}`), client.cancel(m, id, r)),
  };
  return new DbActionEngine({
    db,
    lockPool: testDb.appPool,
    paypal,
    audit,
    events,
    log: quiet,
    clock: () => now,
    retryDelaysMs: [60_000, 60_000],
    random: () => 0.5,
    ...options,
  });
}

const suspend = (name: Name, key?: string) =>
  engine.create({
    merchantId: M,
    subscriptionId: subId[name],
    type: "suspend",
    origin: "session",
    params: { reason: "Paused at the subscriber's request" },
    ...(key && { idempotencyKey: key }),
  });

const cancel = (name: Name) =>
  engine.create({
    merchantId: M,
    subscriptionId: subId[name],
    type: "cancel",
    origin: "session",
    params: { reason: "Cancelled by the subscriber" },
  });

const statusAtPayPal = (name: Name) => mock.state.getSubscription(M, fixtureSubscriptionId(name)).status;
const resume = async (id: string) =>
  (await db.forMerchant(M, (tx) => tx.select().from(scheduledResumes).where(eq(scheduledResumes.id, id))))[0];

// CI's database job sets KEEPWELL_REQUIRE_DATABASE_TESTS, so a missing URL fails there instead of
// silently skipping the engine tests.
it.runIf(process.env.KEEPWELL_REQUIRE_DATABASE_TESTS === "1" && TEST_DATABASE_URL === undefined)(
  "has a test database when the database tests are required",
  () => {
    expect.fail("KEEPWELL_REQUIRE_DATABASE_TESTS is set but KEEPWELL_TEST_DATABASE_URL is not");
  },
);

describe.skipIf(TEST_DATABASE_URL === undefined)("DbActionEngine", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    await db.forMerchant(M, async (tx) => {
      await tx.insert(merchants).values({ id: M, slug: "pantry-plan", name: "Pantry Plan" });
      for (const name of NAMES) {
        const [row] = await tx
          .insert(subscriptions)
          .values({
            merchantId: M,
            paypalSubscriptionId: fixtureSubscriptionId(name),
            paypalPlanId: PANTRY_PLAN.standard.planId,
            planName: "Standard",
            status: "ACTIVE",
            intervalUnit: "MONTH",
            intervalCount: 1,
            priceValue: "12.00",
            priceCurrency: "USD",
            startedAt: new Date("2026-03-01T00:00:00Z"),
            snapshot: {},
            syncedAt: new Date(),
          })
          .returning({ id: subscriptions.id });
        if (!row) throw new Error("seed failed");
        subId[name] = row.id;
      }
    });
  }, 120_000);

  afterAll(async () => {
    await testDb.drop();
  }, 60_000);

  beforeEach(async () => {
    mock = createPayPalMock();
    mockUrl = await mock.listen();
    now = new Date();
    audit = new FakeAudit();
    events = new FakeDomainEvents();
    calls = [];
    engine = makeEngine();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("creates PENDING, audits and emits it, and treats a repeated key as the same Action", async () => {
    const first = await suspend("maya", "session-1:pause");
    const again = await suspend("maya", "session-1:pause");
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ state: "PENDING", type: "suspend", attempts: 0 });
    expect(audit.entries.map((e) => e.kind)).toEqual(["action.created"]);
    expect(events.ofType("action.state_changed").map((e) => e.payload)).toMatchObject([
      { from: null, to: "PENDING" },
    ]);
  });

  it("applies a suspend at PayPal, keeps the debug id, then confirms it", async () => {
    const action = await suspend("maya");
    expect(await engine.execute(M, action.id)).toBe("applied");
    expect(statusAtPayPal("maya")).toBe("SUSPENDED");
    const applied = await engine.get(M, action.id);
    expect(applied).toMatchObject({ state: "APPLIED", attempts: 1 });
    expect(applied?.paypalDebugIds[0]).toMatch(/^[0-9a-f]{13}$/);
    expect(await engine.execute(M, action.id)).toBe("skipped");
    expect(await engine.confirm(M, action.id)).toBe("confirmed");
    expect(audit.entries.map((e) => e.payload.to)).toEqual(["PENDING", "EXECUTING", "APPLIED", "CONFIRMED"]);
  });

  it("waits after a 5xx and retries once the wait is over", async () => {
    mock.failures.add({ path: /\/suspend$/, status: 503 });
    const action = await suspend("lena");
    expect(await engine.execute(M, action.id)).toBe("retry_scheduled");
    expect(await engine.get(M, action.id)).toMatchObject({
      state: "RETRY_WAIT",
      error: { code: "UNAVAILABLE" },
    });
    expect(await engine.execute(M, action.id)).toBe("skipped");
    now = new Date(now.getTime() + 61_000);
    expect(await engine.execute(M, action.id)).toBe("applied");
    expect(statusAtPayPal("lena")).toBe("SUSPENDED");
  });

  it("reads before retrying, so a change PayPal made but never confirmed isn't made twice", async () => {
    mock.failures.add({ path: /\/suspend$/, status: 500, apply: true });
    const action = await suspend("chloe");
    expect(await engine.execute(M, action.id)).toBe("retry_scheduled");
    expect(statusAtPayPal("chloe")).toBe("SUSPENDED");
    now = new Date(now.getTime() + 61_000);
    expect(await engine.execute(M, action.id)).toBe("applied");
    expect(calls.filter((c) => c.startsWith("suspend"))).toHaveLength(1);
    expect(await engine.get(M, action.id)).toMatchObject({ state: "APPLIED" });
  });

  it("counts a 422 as done when PayPal is already there, and fails it otherwise", async () => {
    // Tom already cancelled inside PayPal (fixtures), so PayPal answers our cancel with a 422.
    const again = await cancel("tom");
    expect(await engine.execute(M, again.id)).toBe("applied");

    const impossible = await suspend("tom");
    expect(await engine.execute(M, impossible.id)).toBe("failed");
    expect(await engine.get(M, impossible.id)).toMatchObject({
      state: "FAILED",
      error: { code: "SUBSCRIPTION_STATUS_INVALID" },
    });
  });

  it("gives up after the retry budget", async () => {
    mock.failures.add({ path: /\/suspend$/, status: 503, times: 10 });
    const action = await suspend("priya");
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect(await engine.execute(M, action.id)).toBe("retry_scheduled");
      now = new Date(now.getTime() + 61_000);
    }
    expect(await engine.execute(M, action.id)).toBe("failed");
    expect(await engine.get(M, action.id)).toMatchObject({
      state: "FAILED",
      attempts: 3,
      error: { code: "RETRIES_EXHAUSTED" },
    });
  });

  it("lets a cancel supersede what hasn't started, including the resume", async () => {
    const pause = await suspend("raj");
    const resumeId = await engine.scheduleResume({
      merchantId: M,
      subscriptionId: subId.raj,
      dueAt: new Date(now.getTime() + 86_400_000).toISOString(),
      afterActionId: pause.id,
    });
    await cancel("raj");
    expect(await engine.get(M, pause.id)).toMatchObject({ state: "SUPERSEDED" });
    expect(await resume(resumeId)).toMatchObject({ status: "cancelled" });
    expect(await engine.execute(M, pause.id)).toBe("skipped");
  });

  it("runs a pause as one saga: suspend and resume written together, the resume due only once applied", async () => {
    const dueAt = new Date(now.getTime() + 3 * 86_400_000);
    // One transaction, as the sessions module's accept does it.
    const { pauseId, resumeId } = await db.forMerchant(M, async (tx) => {
      const pause = await engine.create(
        {
          merchantId: M,
          subscriptionId: subId.maya,
          type: "suspend",
          origin: "session",
          params: { reason: "Pause" },
        },
        tx,
      );
      const id = await engine.scheduleResume(
        { merchantId: M, subscriptionId: subId.maya, dueAt: dueAt.toISOString(), afterActionId: pause.id },
        tx,
      );
      return { pauseId: pause.id, resumeId: id };
    });
    expect(await resume(resumeId)).toMatchObject({ status: "waiting" });
    expect(await engine.runDueResumes()).toEqual([]);

    await engine.execute(M, pauseId);
    expect(await resume(resumeId)).toMatchObject({ status: "scheduled" });
    expect(await engine.runDueResumes()).toEqual([]);

    now = new Date(dueAt.getTime() + 1000);
    const [activateId] = await engine.runDueResumes();
    expect(await engine.runDueResumes()).toEqual([]);
    expect(await resume(resumeId)).toMatchObject({ status: "done", actionId: activateId });
    expect(await engine.execute(M, activateId ?? "")).toBe("applied");
    expect(statusAtPayPal("maya")).toBe("ACTIVE");
  });

  it("cancels the waiting resume when the suspend fails", async () => {
    mock.state.cancelInPayPal(fixtureSubscriptionId("lena"));
    const pause = await suspend("lena");
    const resumeId = await engine.scheduleResume({
      merchantId: M,
      subscriptionId: subId.lena,
      dueAt: new Date(now.getTime() + 86_400_000).toISOString(),
      afterActionId: pause.id,
    });
    expect(await engine.execute(M, pause.id)).toBe("failed");
    expect(await resume(resumeId)).toMatchObject({ status: "cancelled" });
  });

  it("runs one Action per subscription at a time", async () => {
    const action = await suspend("priya");
    const holder = await testDb.appPool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [subId.priya]);
      expect(await engine.execute(M, action.id)).toBe("busy");
      await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [subId.priya]);
    } finally {
      holder.release();
    }
    expect(await engine.execute(M, action.id)).toBe("applied");
  });

  it("writes every transition into the real audit chain, in the same transaction", async () => {
    const chain = new DbAudit(db, () => now);
    const audited = makeEngine({ audit: chain });
    const action = await audited.create({
      merchantId: M,
      subscriptionId: subId.lena,
      type: "suspend",
      origin: "session",
      params: { reason: "Pause" },
    });
    await audited.execute(M, action.id);
    const result = await chain.verify(M);
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(3);
  });

  it("lists due work and hides other merchants' Actions", async () => {
    const action = await suspend("chloe");
    expect((await engine.due()).map((d) => d.actionId)).toContain(action.id);
    expect(await engine.get("0199b000-0000-7000-8000-0000000000ff", action.id)).toBeNull();
  });

  it("recovers an Action whose worker was killed mid-call, without calling PayPal twice", async () => {
    // The worker reaches PayPal through this proxy. It passes the suspend on, so PayPal applies it,
    // then never answers the worker: the moment to kill it, with the change made and unrecorded.
    let applied: () => void = () => {};
    const suspendApplied = new Promise<void>((resolve) => (applied = resolve));
    const proxy = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        void fetch(`${mockUrl}${req.url ?? ""}`, {
          method: req.method ?? "GET",
          headers: Object.fromEntries(
            Object.entries(req.headers).filter(
              (e): e is [string, string] => typeof e[1] === "string" && e[0] !== "host",
            ),
          ),
          ...(body && { body }),
        }).then(async (upstream) => {
          const text = await upstream.text();
          if (req.url?.endsWith("/suspend")) return applied();
          res
            .writeHead(upstream.status, {
              "content-type": upstream.headers.get("content-type") ?? "text/plain",
            })
            .end(text);
        });
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

    const action = await suspend("raj");
    let stderr = "";
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./testing/execute-in-child.ts", import.meta.url))],
      {
        env: { ...process.env, DATABASE: testDb.url, PAYPAL: proxyUrl, MERCHANT_ID: M, ACTION_ID: action.id },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const early = exited.then((code) => {
      throw new Error(`worker exited (${code}) before calling PayPal: ${stderr}`);
    });
    await Promise.race([suspendApplied, early]);
    child.kill("SIGKILL");
    await exited.catch(() => null);
    early.catch(() => {});
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));

    expect(statusAtPayPal("raj")).toBe("SUSPENDED");
    expect(await engine.get(M, action.id)).toMatchObject({ state: "EXECUTING" });

    // The dead worker's session closed, so its advisory lock is gone and recovery can take it.
    const recovering = makeEngine({ executingLeaseMs: 0, clock: () => new Date() });
    expect(await recovering.recoverStuck()).toEqual([action.id]);
    expect(await recovering.execute(M, action.id)).toBe("applied");
    expect(calls).toEqual([]);
    const done = await db.forMerchant(M, (tx) => tx.select().from(actions).where(eq(actions.id, action.id)));
    expect(done[0]).toMatchObject({ state: "APPLIED", attempts: 2, result: { via: "read_before_retry" } });
  });
});
