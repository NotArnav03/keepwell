import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAudit } from "@keepwell/contracts/fakes";
import { createDb, merchants, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { auditHash, DbAudit } from "./log.js";
import { auditRoutes, AuditUnauthorized } from "./routes.js";

// The audit chain against a real Postgres: serialised appends, verify, and tamper detection.

const A = "0199c000-0000-7000-8000-00000000000a";
const B = "0199c000-0000-7000-8000-00000000000b";
const FIXED = new Date("2026-11-01T12:00:00.123Z");

let testDb: TestDatabase;
let db: Db;
let audit: DbAudit;

const entry = (merchantId: string, n: number) => ({
  merchantId,
  actor: "system" as const,
  kind: "test.appended",
  subjectIds: { subscriptionId: `sub-${n}` },
  payload: { n, note: "naïve café ✓", nested: { b: 2, a: [1, "x", null] } },
});

/** Tampering needs the owner role and the append-only trigger switched off: two locks to pick. */
async function tamper(statement: string): Promise<void> {
  const client = await testDb.ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only");
    await client.query(statement);
    await client.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// CI's database job sets KEEPWELL_REQUIRE_DATABASE_TESTS, so a missing URL fails there instead of
// silently skipping the audit tests.
it.runIf(process.env.KEEPWELL_REQUIRE_DATABASE_TESTS === "1" && TEST_DATABASE_URL === undefined)(
  "has a test database when the database tests are required",
  () => {
    expect.fail("KEEPWELL_REQUIRE_DATABASE_TESTS is set but KEEPWELL_TEST_DATABASE_URL is not");
  },
);

describe.skipIf(TEST_DATABASE_URL === undefined)("DbAudit", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    audit = new DbAudit(db, () => FIXED);
    for (const [id, slug] of [
      [A, "alpha"],
      [B, "bravo"],
    ] as const) {
      await db.forMerchant(id, (tx) => tx.insert(merchants).values({ id, slug, name: slug }));
    }
  }, 120_000);

  afterAll(async () => {
    await testDb.drop();
  }, 60_000);

  it("chains entries per merchant, from the genesis hash", async () => {
    const first = await audit.append(entry(A, 1));
    const second = await audit.append(entry(A, 2));
    const other = await audit.append(entry(B, 1));
    expect(first).toMatchObject({ seq: 1, prevHash: "0".repeat(64) });
    expect(second).toMatchObject({ seq: 2, prevHash: first.hash });
    expect(other).toMatchObject({ seq: 1, prevHash: "0".repeat(64) });
    expect(await audit.verify(A)).toEqual({ ok: true, checked: 2, brokenAtSeq: null });
  });

  it("hashes exactly as FakeAudit does, so both kinds of chain verify alike", async () => {
    const fake = new FakeAudit(() => FIXED);
    const fromFake = await fake.append(entry(B, 99));
    const { hash, ...unsigned } = fromFake;
    expect(auditHash(unsigned)).toBe(hash);
  });

  it("keeps the chain linear when many appends race", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => audit.append(entry(B, 100 + i))));
    expect(await audit.verify(B)).toEqual({ ok: true, checked: 13, brokenAtSeq: null });
  });

  it("rolls back with the caller's transaction, leaving no gap", async () => {
    await expect(
      db.forMerchant(A, async (tx) => {
        await audit.append(entry(A, 3), tx);
        throw new Error("the side effect failed");
      }),
    ).rejects.toThrow("the side effect failed");
    const next = await audit.append(entry(A, 3));
    expect(next.seq).toBe(3);
    expect(await audit.verify(A)).toMatchObject({ ok: true, checked: 3 });
  });

  // Each kind of edit someone could make if they got past the grants and the trigger.
  const edits: [string, string][] = [
    ["the kind", "UPDATE audit_log SET kind = 'test.edited' WHERE seq = 2 AND merchant_id = '$A'"],
    [
      "the payload",
      `UPDATE audit_log SET payload = jsonb_set(payload, '{n}', '42') WHERE seq = 2 AND merchant_id = '$A'`,
    ],
    [
      "the subjects",
      `UPDATE audit_log SET subject_ids = '{"subscriptionId":"other"}' WHERE seq = 2 AND merchant_id = '$A'`,
    ],
    ["the actor", "UPDATE audit_log SET actor = 'merchant' WHERE seq = 2 AND merchant_id = '$A'"],
    ["the time", "UPDATE audit_log SET at = at + interval '1 second' WHERE seq = 2 AND merchant_id = '$A'"],
    ["the simulated flag", "UPDATE audit_log SET simulated = true WHERE seq = 2 AND merchant_id = '$A'"],
    [
      "the hash too (recomputed)",
      "UPDATE audit_log SET kind = 'test.edited', hash = repeat('a', 64) WHERE seq = 2 AND merchant_id = '$A'",
    ],
  ];

  for (const [what, statement] of edits) {
    it(`detects an edit to ${what}`, async () => {
      const before = await testDb.ownerPool.query(
        "SELECT * FROM audit_log WHERE seq = 2 AND merchant_id = $1",
        [A],
      );
      await tamper(statement.replaceAll("$A", A));
      expect(await audit.verify(A)).toMatchObject({ ok: false, brokenAtSeq: 2 });
      // Put the row back exactly, for the next case.
      const row = before.rows[0] as Record<string, unknown>;
      await tamper(
        `UPDATE audit_log SET kind = '${String(row.kind)}', payload = '${JSON.stringify(row.payload)}', subject_ids = '${JSON.stringify(row.subject_ids)}', actor = '${String(row.actor)}', at = '${(row.at as Date).toISOString()}', simulated = ${String(row.simulated)}, hash = '${String(row.hash)}' WHERE seq = 2 AND merchant_id = '${A}'`,
      );
      expect(await audit.verify(A)).toMatchObject({ ok: true });
    });
  }

  it("detects a deleted entry", async () => {
    await tamper(`DELETE FROM audit_log WHERE seq = 2 AND merchant_id = '${A}'`);
    expect(await audit.verify(A)).toMatchObject({ ok: false, brokenAtSeq: 2 });
  });

  it("refuses edits through the app role and the trigger before anything reaches the chain", async () => {
    await expect(
      db.forMerchant(B, (tx) =>
        tx.execute(sql.raw("UPDATE audit_log SET kind = 'test.edited' WHERE seq = 1")),
      ),
    ).rejects.toThrow();
    await expect(testDb.ownerPool.query("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
    expect(await audit.verify(B)).toMatchObject({ ok: true });
  });

  it("serves GET /audit/verify for the signed-in merchant", async () => {
    const app = Fastify();
    await app.register(auditRoutes, {
      prefix: "/v1/m",
      audit,
      authenticate: (request) => {
        if (request.headers.authorization !== "Bearer bravo") throw new AuditUnauthorized("Sign in first");
        return Promise.resolve({ merchantId: B });
      },
    });
    const ok = await app.inject({ url: "/v1/m/audit/verify", headers: { authorization: "Bearer bravo" } });
    expect(ok.json()).toEqual({ ok: true, checked: 13, brokenAtSeq: null });
    const denied = await app.inject({ url: "/v1/m/audit/verify" });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({ error: { code: "unauthorized" } });
    await app.close();
  });
});
