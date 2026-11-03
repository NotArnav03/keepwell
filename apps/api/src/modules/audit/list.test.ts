import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, merchants, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { auditHash, AuditInvalidCursor, DbAudit } from "./log.js";

// DbAudit.list (GET /v1/m/audit) against a real Postgres: newest first, stable cursors, the kind
// and subject filters, and one merchant never seeing another's entries. Its own database, so the
// chain counts in log.test.ts stay exact.

const A = "0199c000-0000-7000-8000-0000000000aa";
const B = "0199c000-0000-7000-8000-0000000000bb";

let testDb: TestDatabase;
let db: Db;
let audit: DbAudit;

const append = (
  merchantId: string,
  n: number,
  kind = "test.listed",
  subjectIds: Record<string, string> = { subscriptionId: `sub-${n}` },
) => audit.append({ merchantId, actor: "system", kind, subjectIds, payload: { n } });

describe.skipIf(TEST_DATABASE_URL === undefined)("DbAudit.list", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    audit = new DbAudit(db);
    for (const [id, slug] of [
      [A, "alpha"],
      [B, "bravo"],
    ] as const) {
      await db.forMerchant(id, (tx) => tx.insert(merchants).values({ id, slug, name: slug }));
    }
    for (let n = 1; n <= 7; n++) await append(A, n);
    await append(A, 8, "pool.leased", { subscriptionId: "sub-8", paypalSubscriptionId: "I-POOL123" });
    for (let n = 1; n <= 3; n++) await append(B, n);
  }, 120_000);

  afterAll(async () => {
    await testDb.drop();
  }, 60_000);

  it("pages newest first with no gaps or repeats, and says when it's done", async () => {
    const seen: number[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (;;) {
      const page = await audit.list(A, { limit: 3, cursor });
      sizes.push(page.entries.length);
      seen.push(...page.entries.map((e) => e.seq));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(sizes).toEqual([3, 3, 2]);
    expect(seen).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("keeps the next page stable when new entries arrive in between", async () => {
    const first = await audit.list(B, { limit: 2 });
    expect(first.entries.map((e) => e.seq)).toEqual([3, 2]);
    await append(B, 4);
    const second = await audit.list(B, { limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.entries.map((e) => e.seq)).toEqual([1]);
    expect(second.nextCursor).toBeNull();
  });

  it("filters by exact kind, and by any subject id (here a PayPal subscription id)", async () => {
    expect((await audit.list(A, { kind: "pool.leased" })).entries.map((e) => e.seq)).toEqual([8]);
    expect((await audit.list(A, { subject: "I-POOL123" })).entries.map((e) => e.seq)).toEqual([8]);
    expect((await audit.list(A, { subject: "sub-3" })).entries.map((e) => e.seq)).toEqual([3]);
    expect((await audit.list(A, { kind: "pool", subject: "nothing" })).entries).toEqual([]);
  });

  it("never shows another merchant's entries, even for a matching subject", async () => {
    const b = await audit.list(B, { subject: "sub-1" });
    expect(b.entries.map((e) => [e.merchantId, e.seq])).toEqual([[B, 1]]);
  });

  it("returns entries exactly as they were hashed, so the page can be checked against the chain", async () => {
    const [newest] = (await audit.list(A, { limit: 1 })).entries;
    if (!newest) throw new Error("expected an entry");
    const { hash, ...unsigned } = newest;
    expect(auditHash(unsigned)).toBe(hash);
  });

  it("refuses a cursor that isn't one of ours, and clamps the page size", async () => {
    for (const bad of ["abc", "0", "-3", "1.5", "99999999999999999999"]) {
      await expect(audit.list(A, { cursor: bad })).rejects.toBeInstanceOf(AuditInvalidCursor);
    }
    expect((await audit.list(A, { limit: 0 })).entries).toHaveLength(1);
    expect((await audit.list(A, { limit: 10_000 })).entries).toHaveLength(8);
  });
});
