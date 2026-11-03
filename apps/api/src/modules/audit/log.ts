import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import {
  AuditAppendInput,
  AuditEntry,
  GENESIS_HASH,
  canonicalJson,
  type Audit,
  type AuditVerifyResult,
} from "@keepwell/contracts";
import { auditLog, type Db, type Tx } from "@keepwell/db";

// The audit log (ARCHITECTURE.md §6.16): append-only and hash-chained per merchant. Each entry's
// hash = sha256(prevHash ‖ canonicalJson(entry without hash)), the same rule as FakeAudit, so a
// chain written by either verifies the same way. Postgres keeps it append-only (no UPDATE/DELETE
// grant for the app role, plus a trigger for every role), and the chain makes any edit that gets
// past both visible to verify().

type AuditRow = typeof auditLog.$inferSelect;
const VERIFY_BATCH = 1000;

export function auditHash(unsigned: Omit<AuditEntry, "hash">): string {
  return createHash("sha256")
    .update(unsigned.prevHash + canonicalJson(unsigned))
    .digest("hex");
}

export class DbAudit implements Audit<Tx> {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Appends inside the caller's transaction, so the entry commits or rolls back with the side
   * effect it records. Appends for one merchant are serialised by a transaction-scoped advisory
   * lock, so the chain stays linear; other merchants aren't held up.
   */
  async append(input: AuditAppendInput, tx?: Tx): Promise<AuditEntry> {
    if (!tx) return this.db.forMerchant(input.merchantId, (t) => this.append(input, t));
    const parsed = AuditAppendInput.parse(input);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`audit:${parsed.merchantId}`}, 0))`);
    const [last] = await tx
      .select({ seq: auditLog.seq, hash: auditLog.hash })
      .from(auditLog)
      .where(eq(auditLog.merchantId, parsed.merchantId))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    const unsigned: Omit<AuditEntry, "hash"> = {
      ...parsed,
      seq: (last?.seq ?? 0) + 1,
      at: this.clock().toISOString(),
      prevHash: last?.hash ?? GENESIS_HASH,
    };
    const entry = AuditEntry.parse({ ...unsigned, hash: auditHash(unsigned) });
    await tx.insert(auditLog).values({
      merchantId: entry.merchantId,
      seq: entry.seq,
      at: new Date(entry.at),
      actor: entry.actor,
      kind: entry.kind,
      subjectIds: entry.subjectIds,
      payload: entry.payload,
      simulated: entry.simulated,
      prevHash: entry.prevHash,
      hash: entry.hash,
    });
    return entry;
  }

  /**
   * Recomputes the merchant's chain from the first entry (GET /v1/m/audit/verify). Reports the first
   * entry whose seq, prevHash or hash doesn't follow: an edited, deleted or reordered row.
   */
  async verify(merchantId: string): Promise<AuditVerifyResult> {
    let prevHash = GENESIS_HASH;
    let expectedSeq = 1;
    let checked = 0;
    for (;;) {
      const after = expectedSeq - 1;
      const rows = await this.db.forMerchant(merchantId, (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.merchantId, merchantId), gt(auditLog.seq, after)))
          .orderBy(asc(auditLog.seq))
          .limit(VERIFY_BATCH),
      );
      for (const row of rows) {
        if (row.seq !== expectedSeq || row.prevHash !== prevHash || auditHash(unsignedOf(row)) !== row.hash) {
          return { ok: false, checked, brokenAtSeq: row.seq === expectedSeq ? row.seq : expectedSeq };
        }
        prevHash = row.hash;
        expectedSeq++;
        checked++;
      }
      if (rows.length < VERIFY_BATCH) return { ok: true, checked, brokenAtSeq: null };
    }
  }

  /**
   * One page of the merchant's log, newest first (GET /v1/m/audit). The cursor is the last seq
   * shown, so pages stay stable while new entries are appended at the top, and the query walks
   * the (merchant_id, seq) primary key.
   */
  async list(merchantId: string, query: AuditListQuery = {}): Promise<AuditPage> {
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? LIST_DEFAULT), 1), LIST_MAX);
    let before: number | null = null;
    if (query.cursor !== undefined) {
      before = /^[1-9]\d{0,15}$/.test(query.cursor) ? Number(query.cursor) : NaN;
      if (!Number.isSafeInteger(before)) throw new AuditInvalidCursor("That page link is no longer valid");
    }
    const rows = await this.db.forMerchant(merchantId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.merchantId, merchantId),
            before === null ? undefined : lt(auditLog.seq, before),
            query.kind === undefined ? undefined : eq(auditLog.kind, query.kind),
            query.subject === undefined
              ? undefined
              : sql`exists (select 1 from jsonb_each_text(${auditLog.subjectIds}) s where s.value = ${query.subject})`,
          ),
        )
        .orderBy(desc(auditLog.seq))
        // One extra row says whether there is a next page without a count.
        .limit(limit + 1),
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((row) => AuditEntry.parse({ ...unsignedOf(row), hash: row.hash })),
      nextCursor: rows.length > limit && last ? String(last.seq) : null,
    };
  }
}

export interface AuditListQuery {
  /** From a previous page's nextCursor. */
  cursor?: string | undefined;
  /** Exact kind, e.g. "pool.leased". */
  kind?: string | undefined;
  /** Any entry with this value among its subjectIds (a subscription, session, action or PayPal id). */
  subject?: string | undefined;
  /** 1–100, default 50. */
  limit?: number | undefined;
}

export interface AuditPage {
  /** Newest first. */
  entries: AuditEntry[];
  nextCursor: string | null;
}

/** A cursor that isn't one of ours: the route answers 400. */
export class AuditInvalidCursor extends Error {
  override readonly name = "AuditInvalidCursor";
  readonly statusCode = 400;
}

const LIST_DEFAULT = 50;
const LIST_MAX = 100;

/** A stored row back in the exact shape that was hashed. */
function unsignedOf(row: AuditRow): Omit<AuditEntry, "hash"> {
  return {
    merchantId: row.merchantId,
    seq: row.seq,
    at: row.at.toISOString(),
    actor: row.actor,
    kind: row.kind,
    subjectIds: row.subjectIds as Record<string, string>,
    payload: row.payload as Record<string, unknown>,
    simulated: row.simulated,
    prevHash: row.prevHash,
  };
}
