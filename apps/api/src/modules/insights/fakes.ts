import type { InsightRecord } from "@keepwell/contracts";
import type { InsightStore, ReplyReader, SessionReader, SourceRef, SourceText } from "./extractor.js";

// In-memory stand-ins so the extractor, jobs and route tests need no database.

export class FakeSessionReader implements SessionReader {
  private readonly sources = new Map<string, SourceText>();
  set(sessionId: string, source: SourceText): this {
    this.sources.set(sessionId, source);
    return this;
  }
  load(sessionId: string): Promise<SourceText | null> {
    return Promise.resolve(this.sources.get(sessionId) ?? null);
  }
}

/** Stands in for the win-back module's reply table, which isn't on main yet. */
export class FakeReplyReader implements ReplyReader {
  private readonly sources = new Map<string, SourceText>();
  set(replyId: string, source: SourceText): this {
    this.sources.set(replyId, source);
    return this;
  }
  load(replyId: string): Promise<SourceText | null> {
    return Promise.resolve(this.sources.get(replyId) ?? null);
  }
}

const keyOf = (ref: SourceRef): string => ("sessionId" in ref ? `s:${ref.sessionId}` : `r:${ref.replyId}`);

export class FakeInsightStore implements InsightStore {
  readonly rows = new Map<string, { merchantId: string; record: InsightRecord }>();

  exists(_merchantId: string, ref: SourceRef): Promise<boolean> {
    return Promise.resolve(this.rows.has(keyOf(ref)));
  }

  async save(
    merchantId: string,
    record: InsightRecord,
    onStored: (tx: unknown) => Promise<void>,
  ): Promise<boolean> {
    const key = record.sessionId ? `s:${record.sessionId}` : `r:${String(record.replyId)}`;
    if (this.rows.has(key)) return false;
    this.rows.set(key, { merchantId, record });
    await onStored(undefined);
    return true;
  }
}
