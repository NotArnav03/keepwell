import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical-json.js";
import { AuditAppendInput, AuditEntry, GENESIS_HASH, type AuditVerifyResult } from "../platform/audit.js";
import type { Audit } from "../platform/interfaces.js";

function hashEntry(entry: Omit<AuditEntry, "hash">): string {
  return createHash("sha256")
    .update(entry.prevHash + canonicalJson(entry))
    .digest("hex");
}

/**
 * In-memory Audit with a real per-merchant hash chain (ARCHITECTURE.md §6.16), so tests can check
 * that a side effect was audited and that verify() catches tampering.
 */
export class FakeAudit implements Audit {
  readonly entries: AuditEntry[] = [];

  constructor(private readonly clock: () => Date = () => new Date()) {}

  append(entry: AuditAppendInput): Promise<AuditEntry> {
    // The executor turns a validation throw into a rejection, like the real async Audit.
    return new Promise((resolve) => resolve(this.record(entry)));
  }

  private record(input: AuditAppendInput): AuditEntry {
    const parsed = AuditAppendInput.parse(input);
    const previous = this.chain(parsed.merchantId).at(-1);
    const unsigned = {
      ...parsed,
      seq: (previous?.seq ?? 0) + 1,
      at: this.clock().toISOString(),
      prevHash: previous?.hash ?? GENESIS_HASH,
    };
    const entry = AuditEntry.parse({ ...unsigned, hash: hashEntry(unsigned) });
    this.entries.push(entry);
    return entry;
  }

  chain(merchantId: string): AuditEntry[] {
    return this.entries.filter((e) => e.merchantId === merchantId);
  }

  byKind(kind: string): AuditEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }

  verify(merchantId: string): AuditVerifyResult {
    let prevHash = GENESIS_HASH;
    let checked = 0;
    for (const entry of this.chain(merchantId)) {
      const { hash, ...unsigned } = entry;
      if (entry.prevHash !== prevHash || hashEntry(unsigned) !== hash) {
        return { ok: false, checked, brokenAtSeq: entry.seq };
      }
      prevHash = hash;
      checked++;
    }
    return { ok: true, checked, brokenAtSeq: null };
  }
}
