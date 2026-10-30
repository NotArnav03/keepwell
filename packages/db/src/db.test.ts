import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type Tx } from "./client.js";
import { runMigrations } from "./migrate.js";
import { auditLog, merchants, policies, subscriptions } from "./schema/index.js";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "./test-database.js";

// Runs against a real Postgres 18: CI's database job, or KEEPWELL_TEST_DATABASE_URL locally.

const A = "0199b000-0000-7000-8000-00000000000a";
const B = "0199b000-0000-7000-8000-00000000000b";

let testDb: TestDatabase;
let db: Db;

async function seedMerchant(id: string, slug: string): Promise<void> {
  await db.forMerchant(id, async (tx) => {
    await tx.insert(merchants).values({ id, slug, name: slug });
    await tx.insert(subscriptions).values({
      merchantId: id,
      paypalSubscriptionId: `I-${slug.toUpperCase()}`,
      paypalPlanId: "P-STANDARD",
      planName: "Standard",
      status: "ACTIVE",
      intervalUnit: "MONTH",
      intervalCount: 1,
      priceValue: "12.00",
      priceCurrency: "USD",
      startedAt: new Date("2026-03-01T00:00:00Z"),
      snapshot: {},
      syncedAt: new Date(),
    });
  });
}

const appendAudit = (tx: Tx, merchantId: string, seq: number) =>
  tx.insert(auditLog).values({
    merchantId,
    seq,
    actor: "system",
    kind: "test.appended",
    subjectIds: {},
    payload: {},
    prevHash: "0".repeat(64),
    hash: "1".repeat(64),
  });

/** The Postgres error code of a rejected statement: 42501 for RLS, a missing grant or the trigger. */
async function errorCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ?? (err as { code?: string }).code ?? "unknown";
  }
  return "none";
}

// A remote Neon branch is a few hundred ms per round trip, hence the generous timeout.
describe.skipIf(TEST_DATABASE_URL === undefined)("packages/db against Postgres", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    await seedMerchant(A, "alpha");
    await seedMerchant(B, "bravo");
  }, 120_000);

  afterAll(async () => {
    await testDb.drop();
  }, 60_000);

  it("runs app queries as keepwell_app, which row-level security binds", async () => {
    const role = await db.forMerchant(A, (tx) =>
      tx
        .execute<{ name: string; bypass: boolean; superuser: boolean }>(
          sql`SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`,
        )
        .then((r) => r.rows[0]),
    );
    expect(role).toEqual({ name: "keepwell_app", bypass: false, superuser: false });
    const raw = await testDb.appPool.query<{ name: string }>("SELECT current_user AS name");
    expect(raw.rows[0]?.name).toBe("keepwell_app");
  });

  it("re-running the migrations is a no-op", async () => {
    await expect(runMigrations(testDb.ownerPool)).resolves.toBeUndefined();
  });

  it("has RLS with a policy on every table that has merchant_id", async () => {
    const { rows } = await testDb.ownerPool.query<{
      table: string;
      rls: boolean;
      forced: boolean;
      policies: number;
    }>(`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND (c.relname = 'merchants' OR EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'merchant_id'))
    `);
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(rows.filter((r) => !r.rls || !r.forced || r.policies === 0).map((r) => r.table)).toEqual([]);
  });

  it("forMerchant sees only that merchant's rows", async () => {
    const seen = await db.forMerchant(A, (tx) => tx.select().from(subscriptions));
    expect(seen.map((s) => s.merchantId)).toEqual([A]);
    const own = await db.forMerchant(A, (tx) => tx.select().from(merchants));
    expect(own.map((m) => m.id)).toEqual([A]);
  });

  it("forMerchant can't write another merchant's rows", async () => {
    const code = await errorCode(() =>
      db.forMerchant(A, (tx) =>
        tx
          .insert(merchants)
          .values({ id: "0199b000-0000-7000-8000-0000000000cc", slug: "sneaky", name: "x" }),
      ),
    );
    expect(code).toBe("42501");
    const updated = await db.forMerchant(A, (tx) =>
      tx
        .update(subscriptions)
        .set({ status: "CANCELLED" })
        .where(eq(subscriptions.merchantId, B))
        .returning(),
    );
    expect(updated).toEqual([]);
    const deleted = await db.forMerchant(A, (tx) =>
      tx.delete(subscriptions).where(eq(subscriptions.merchantId, B)).returning(),
    );
    expect(deleted).toEqual([]);
  });

  it("a raw query on the app pool, outside the helpers, sees nothing and can't write", async () => {
    const { rows } = await testDb.appPool.query("SELECT * FROM subscriptions");
    expect(rows).toEqual([]);
    const code = await errorCode(() =>
      testDb.appPool.query("INSERT INTO merchants (id, slug, name) VALUES ($1, 'loose', 'x')", [
        "0199b000-0000-7000-8000-0000000000dd",
      ]),
    );
    expect(code).toBe("42501");
  });

  it("the scope ends with its transaction, so it never leaks to the next pooled query", async () => {
    await db.forMerchant(A, (tx) => tx.select().from(subscriptions));
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        testDb.appPool.query<{ n: number }>("SELECT count(*)::int AS n FROM subscriptions"),
      ),
    );
    expect(results.map((r) => r.rows[0]?.n)).toEqual([0, 0, 0, 0]);
  });

  it("acrossMerchants sees everyone, for the jobs that need it", async () => {
    const all = await db.acrossMerchants((tx) => tx.select().from(subscriptions));
    expect(all.map((s) => s.merchantId).sort()).toEqual([A, B]);
  });

  it("rejects a malformed merchant id before it reaches Postgres", async () => {
    await expect(db.forMerchant("not-a-uuid", (tx) => tx.select().from(merchants))).rejects.toThrow();
  });

  it("keeps money as exact decimal strings and ids in creation order", async () => {
    const rows = await db.forMerchant(A, (tx) => tx.select().from(subscriptions));
    expect(rows[0]?.priceValue).toBe("12.00");
    const ids = await db.acrossMerchants((tx) =>
      tx.select({ id: merchants.id }).from(merchants).orderBy(merchants.createdAt),
    );
    const later = await db.forMerchant(A, (tx) =>
      tx.execute<{ id: string }>(sql`SELECT uuidv7()::text AS id`).then((r) => r.rows[0]?.id ?? ""),
    );
    // Fixed test ids for A and B are older than anything uuidv7() makes now.
    expect(ids.every(({ id }) => id < later)).toBe(true);
  });

  it("audit_log is append-only: no grant for the app, and a trigger for its owner too", async () => {
    await db.forMerchant(A, (tx) => appendAudit(tx, A, 1));
    const { rows } = await testDb.ownerPool.query<{ update: boolean; del: boolean; insert: boolean }>(
      `SELECT has_table_privilege('keepwell_app', 'audit_log', 'UPDATE') AS update,
              has_table_privilege('keepwell_app', 'audit_log', 'DELETE') AS del,
              has_table_privilege('keepwell_app', 'audit_log', 'INSERT') AS insert`,
    );
    expect(rows[0]).toEqual({ update: false, del: false, insert: true });

    const asApp = () => db.forMerchant(A, (tx) => tx.update(auditLog).set({ kind: "test.changed" }));
    const asOwner = (statement: string) => () => testDb.ownerPool.query(statement);
    expect([
      await errorCode(asApp),
      await errorCode(asOwner("UPDATE audit_log SET kind = 'test.changed'")),
      await errorCode(asOwner("DELETE FROM audit_log")),
      await errorCode(asOwner("TRUNCATE audit_log")),
    ]).toEqual(["42501", "42501", "42501", "42501"]);
    expect(await db.forMerchant(A, (tx) => tx.select().from(auditLog))).toHaveLength(1);
  });

  it("policy versions are immutable, and a duplicate version is refused", async () => {
    const publish = (version: number) =>
      db.forMerchant(A, (tx) =>
        tx.insert(policies).values({ merchantId: A, version, document: {}, publishedBy: "system" }),
      );
    await publish(1);
    expect(await errorCode(() => publish(1))).toBe("23505");
    const change = () => testDb.ownerPool.query("UPDATE policies SET change_note = 'edited'");
    expect(await errorCode(change)).toBe("42501");
  });
});
