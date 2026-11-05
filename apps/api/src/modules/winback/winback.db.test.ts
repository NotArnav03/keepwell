import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Audit } from "@keepwell/contracts";
import { FakeAudit, FakeNotifier, uuidv7 } from "@keepwell/contracts/fakes";
import {
  auditLog,
  createDb,
  merchants,
  sessions,
  subscriptions,
  winbackReplies,
  type Db,
  type Tx,
} from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { DbAudit } from "../audit/log.js";
import { drizzleSubscriptionDirectory, drizzleWinbackStore } from "./drizzle.js";
import { MemoryJobs } from "./memory.js";
import { recordReply } from "./replies.js";
import { WinbackService } from "./service.js";
import { signReplyToken } from "./tokens.js";

// The Postgres adapters against a real database: the compare-and-set, the unique case, row-level
// isolation between merchants, and the directory's reads.

const A = uuidv7();
const B = uuidv7();
const SUB_A = uuidv7();

let testDb: TestDatabase;
let db: Db;

const SECRET = "test-secret-not-real";
const BATCH_AT = new Date("2026-11-05T10:00:00.000Z");

function batchHarness(audit: Audit<Tx> = new FakeAudit(() => BATCH_AT)) {
  const jobs = new MemoryJobs();
  const service = new WinbackService({
    store: drizzleWinbackStore(db),
    directory: drizzleSubscriptionDirectory(db, {
      getSubscription: () => Promise.reject(new Error("batch must not call PayPal")),
    }),
    policy: { resubscribeUrl: () => Promise.resolve(null) },
    notifier: new FakeNotifier(() => BATCH_AT),
    audit,
    jobs,
    log: Fastify({ logger: false }).log,
    portalUrl: "https://portal.example.test",
    tokenSecret: SECRET,
    clock: () => BATCH_AT,
  });
  return { service, jobs };
}

async function addSubscription(
  merchantId: string,
  id: string,
  status: "CANCELLED" | "ACTIVE" | "SUSPENDED" | "EXPIRED",
) {
  await db.forMerchant(merchantId, (tx) =>
    tx.insert(subscriptions).values({
      id,
      merchantId,
      paypalSubscriptionId: `I-${id.slice(-8)}`,
      paypalPlanId: "P-1",
      planName: "Standard",
      status,
      intervalUnit: "MONTH",
      intervalCount: 1,
      priceValue: "12.00",
      priceCurrency: "USD",
      startedAt: new Date(),
      subscriberFirstName: "Maya",
      snapshot: {},
      syncedAt: new Date(),
    }),
  );
}

describe.skipIf(TEST_DATABASE_URL === undefined)("winback Postgres adapters", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    for (const [id, slug] of [
      [A, "a"],
      [B, "b"],
    ] as const) {
      await db.forMerchant(id, (tx) => tx.insert(merchants).values({ id, slug, name: slug }));
    }
    await addSubscription(A, SUB_A, "CANCELLED");
  });
  afterAll(async () => {
    await testDb.drop();
  });

  it("opens one case per subscription, and only one caller can move it out of pending", async () => {
    const store = drizzleWinbackStore(db);
    const dueAt = new Date("2026-11-01T10:00:00Z");
    const [first, second] = await store.withMerchant(A, async (repo) => [
      await repo.openCase({ merchantId: A, subscriptionId: SUB_A, dueAt, simulated: false }),
      await repo.openCase({ merchantId: A, subscriptionId: SUB_A, dueAt, simulated: false }),
    ]);
    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(second?.case.id).toBe(first?.case.id);

    const caseId = first?.case.id ?? "";
    const wins = await store.withMerchant(A, async (repo) => [
      await repo.transition(caseId, "pending", { state: "sent", sentAt: new Date() }),
      await repo.transition(caseId, "pending", { state: "sent", sentAt: new Date() }),
    ]);
    expect(wins).toEqual([true, false]);
  });

  it("keeps cases invisible to other merchants but findable by the cross-tenant lookups", async () => {
    const store = drizzleWinbackStore(db);
    const seenByB = await store.withMerchant(B, (repo) => repo.getCaseBySubscription(SUB_A));
    expect(seenByB).toBeNull();
    expect(await store.locate(SUB_A)).toEqual({ merchantId: A });
  });

  it("lists only pending cases whose timer has passed", async () => {
    const store = drizzleWinbackStore(db);
    const sub = uuidv7();
    await addSubscription(A, sub, "CANCELLED");
    await store.withMerchant(A, (repo) =>
      repo.openCase({
        merchantId: A,
        subscriptionId: sub,
        dueAt: new Date("2026-11-01T12:00:00Z"),
        simulated: false,
      }),
    );
    expect(await store.listDue(new Date("2026-11-01T11:00:00Z"), 10)).toEqual([]);
    expect(await store.listDue(new Date("2026-11-01T12:00:00Z"), 10)).toEqual([
      { merchantId: A, subscriptionId: sub },
    ]);
  });

  it("reads the address from PayPal at send time and reports a saved session", async () => {
    const asked: string[] = [];
    const directory = drizzleSubscriptionDirectory(db, {
      getSubscription: (_m, paypalId) => {
        asked.push(paypalId);
        return Promise.resolve({ subscriber: { email_address: "maya@example.test" } });
      },
    });
    const view = await directory.get(A, SUB_A);
    expect(view).toMatchObject({ status: "CANCELLED", email: "maya@example.test", session: "none" });
    expect(asked).toHaveLength(1);

    await db.forMerchant(A, (tx) =>
      tx.insert(sessions).values({
        merchantId: A,
        subscriptionId: SUB_A,
        channel: "widget",
        state: "closed",
        outcome: "saved_pause",
        policyVersion: 1,
      }),
    );
    const saved = await directory.get(A, SUB_A);
    expect(saved).toMatchObject({ session: "saved", email: null });
    expect(asked).toHaveLength(1);
  });

  it("queues a cancelled subscription, skips the rest, audits once, and a second call does not queue", async () => {
    const cancelled = uuidv7();
    const active = uuidv7();
    const suspended = uuidv7();
    const expired = uuidv7();
    const sentSub = uuidv7();
    const repliedSub = uuidv7();
    const skippedSub = uuidv7();
    const unknown = uuidv7();
    await addSubscription(A, cancelled, "CANCELLED");
    await addSubscription(A, active, "ACTIVE");
    await addSubscription(A, suspended, "SUSPENDED");
    await addSubscription(A, expired, "EXPIRED");
    await addSubscription(A, sentSub, "CANCELLED");
    await addSubscription(A, repliedSub, "CANCELLED");
    await addSubscription(A, skippedSub, "CANCELLED");

    const store = drizzleWinbackStore(db);
    await store.withMerchant(A, async (repo) => {
      const open = (subscriptionId: string) =>
        repo.openCase({ merchantId: A, subscriptionId, dueAt: BATCH_AT, simulated: false });
      const sent = await open(sentSub);
      await repo.transition(sent.case.id, "pending", { state: "sent", sentAt: BATCH_AT });
      const replied = await open(repliedSub);
      await repo.transition(replied.case.id, "pending", { state: "sent", sentAt: BATCH_AT });
      await repo.transition(replied.case.id, "sent", { state: "replied" });
      const skipped = await open(skippedSub);
      await repo.transition(skipped.case.id, "pending", { state: "skipped", skipReason: "session_saved" });
    });

    const audit = new DbAudit(db, () => BATCH_AT);
    const { service, jobs } = batchHarness(audit);
    const ids = [cancelled, active, suspended, expired, unknown, sentSub, repliedSub, skippedSub];
    const first = await service.startBatch(A, ids);
    expect(first).toEqual({
      queued: 1,
      skipped: [
        { subscriptionId: active, reason: "not_cancelled" },
        { subscriptionId: suspended, reason: "not_cancelled" },
        { subscriptionId: expired, reason: "not_cancelled" },
        { subscriptionId: unknown, reason: "not_found" },
        { subscriptionId: sentSub, reason: "already_sent" },
        { subscriptionId: repliedSub, reason: "already_replied" },
        { subscriptionId: skippedSub, reason: "already_skipped" },
      ],
    });

    const opened = await store.withMerchant(A, (repo) => repo.getCaseBySubscription(cancelled));
    expect(opened).toMatchObject({ state: "pending", simulated: false, merchantId: A });
    expect(opened?.dueAt.toISOString()).toBe(BATCH_AT.toISOString());
    expect(jobs.sent).toMatchObject([{ name: "winback.start", payload: { subscriptionId: cancelled } }]);
    expect(jobs.sent[0]?.options.startAfter?.toISOString()).toBe(BATCH_AT.toISOString());

    const second = await service.startBatch(A, ids);
    expect(second.queued).toBe(0);
    expect(second.skipped).toContainEqual({ subscriptionId: cancelled, reason: "already_pending" });
    expect(jobs.sent).toHaveLength(1);
    const still = await store.withMerchant(A, (repo) => repo.getCaseBySubscription(cancelled));
    expect(still?.id).toBe(opened?.id);

    const entries = await db.forMerchant(A, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.kind, "winback.batch_queued")),
    );
    const mine = entries.filter((entry) => {
      const payload = entry.payload as { subscriptionIds?: string[] };
      return payload.subscriptionIds?.includes(cancelled) === true;
    });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ actor: "system", simulated: false, kind: "winback.batch_queued" });
    expect(mine[0]?.payload).toMatchObject({ queued: 1, subscriptionIds: [cancelled] });
  });

  it("does not open a case for another merchant's subscription", async () => {
    const own = uuidv7();
    const theirs = uuidv7();
    await addSubscription(A, own, "CANCELLED");
    await addSubscription(B, theirs, "CANCELLED");
    const { service, jobs } = batchHarness();
    const asA = await service.startBatch(A, [own, theirs]);
    expect(asA).toEqual({
      queued: 1,
      skipped: [{ subscriptionId: theirs, reason: "not_found" }],
    });
    const store = drizzleWinbackStore(db);
    expect(await store.withMerchant(B, (repo) => repo.getCaseBySubscription(theirs))).toBeNull();
    expect(await store.withMerchant(B, (repo) => repo.getCaseBySubscription(own))).toBeNull();
    expect(await store.withMerchant(A, (repo) => repo.getCaseBySubscription(own))).toMatchObject({
      state: "pending",
      simulated: false,
    });

    const asB = await service.startBatch(B, [own, theirs]);
    expect(asB).toEqual({
      queued: 1,
      skipped: [{ subscriptionId: own, reason: "not_found" }],
    });
    expect(await store.withMerchant(A, (repo) => repo.getCaseBySubscription(theirs))).toBeNull();
    expect(await store.withMerchant(B, (repo) => repo.getCaseBySubscription(theirs))).toMatchObject({
      state: "pending",
    });
    expect(jobs.sent).toMatchObject([
      { name: "winback.start", payload: { subscriptionId: own } },
      { name: "winback.start", payload: { subscriptionId: theirs } },
    ]);
  });

  it("rejects a batch larger than 500", async () => {
    const { service } = batchHarness();
    const ids = Array.from({ length: 501 }, () => uuidv7());
    await expect(service.startBatch(A, ids)).rejects.toThrow();
  });

  it("stores a reply with emails, phones and card numbers redacted", async () => {
    const sub = uuidv7();
    await addSubscription(A, sub, "CANCELLED");
    const store = drizzleWinbackStore(db);
    const caseId = await store.withMerchant(A, async (repo) => {
      const opened = await repo.openCase({
        merchantId: A,
        subscriptionId: sub,
        dueAt: BATCH_AT,
        simulated: false,
      });
      await repo.transition(opened.case.id, "pending", { state: "sent", sentAt: BATCH_AT });
      return opened.case.id;
    });
    const raw =
      "I was away for 2 months and paid 12 dollars on 3 March. Reach me at maya@example.test or +1 415 555 0100. Card 4111-1111-1111-1111.";
    const { replyId } = await recordReply(
      {
        store,
        audit: new FakeAudit(() => BATCH_AT),
        jobs: new MemoryJobs(),
        log: Fastify({ logger: false }).log,
        tokenSecret: SECRET,
        clock: () => BATCH_AT,
      },
      { token: signReplyToken(SECRET, { merchantId: A, caseId }, BATCH_AT), text: raw },
    );
    const [row] = await db.forMerchant(A, (tx) =>
      tx.select().from(winbackReplies).where(eq(winbackReplies.id, replyId)),
    );
    expect(row?.text).toBe(
      "I was away for 2 months and paid 12 dollars on 3 March. Reach me at [email] or [phone]. Card [number].",
    );
    expect(row?.text).not.toContain("maya@example.test");
    expect(row?.text).not.toContain("4111");
    expect(row?.text).not.toContain("415");
  });
});
