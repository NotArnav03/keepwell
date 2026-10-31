import { and, asc, eq } from "drizzle-orm";
import { insights, messages, sessions, subscriptions, type Db, type Tx } from "@keepwell/db";
import type { InsightRecord } from "@keepwell/contracts";
import type { InsightStore, SessionReader, SourceRef, SourceText } from "./extractor.js";

// Postgres-backed InsightStore and SessionReader. Every query runs in forMerchant; the one
// cross-tenant read is finding which merchant owns a session, because job payloads carry only the id.

export class DrizzleSessionReader implements SessionReader {
  constructor(private readonly db: Db) {}

  async load(sessionId: string): Promise<SourceText | null> {
    const owner = await this.db.acrossMerchants(async (tx) => {
      const rows = await tx
        .select({ merchantId: sessions.merchantId })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      return rows[0];
    });
    if (!owner) return null;

    return this.db.forMerchant(owner.merchantId, async (tx) => {
      const [session] = await tx
        .select({ reason: sessions.reason, subscriptionId: sessions.subscriptionId })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      if (!session) return null;
      const [subscriber] = await tx
        .select({ firstName: subscriptions.subscriberFirstName })
        .from(subscriptions)
        .where(eq(subscriptions.id, session.subscriptionId));
      const turns = await tx
        .select({ role: messages.role, text: messages.text })
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(asc(messages.createdAt), asc(messages.id));
      return {
        merchantId: owner.merchantId,
        turns,
        knownNames: subscriber?.firstName ? [subscriber.firstName] : [],
        knownReason: session.reason,
      };
    });
  }
}

export class DrizzleInsightStore implements InsightStore {
  constructor(private readonly db: Db) {}

  async exists(merchantId: string, ref: SourceRef): Promise<boolean> {
    return this.db.forMerchant(merchantId, async (tx) => {
      const where =
        "sessionId" in ref ? eq(insights.sessionId, ref.sessionId) : eq(insights.replyId, ref.replyId);
      const rows = await tx
        .select({ id: insights.id })
        .from(insights)
        .where(and(eq(insights.merchantId, merchantId), where));
      return rows.length > 0;
    });
  }

  async save(
    merchantId: string,
    record: InsightRecord,
    onStored: (tx: unknown) => Promise<void>,
  ): Promise<boolean> {
    return this.db.forMerchant(merchantId, async (tx: Tx) => {
      // The unique indexes on session_id and reply_id make a duplicate extraction a no-op.
      const rows = await tx
        .insert(insights)
        .values({
          merchantId,
          sessionId: record.sessionId,
          replyId: record.replyId,
          source: record.source,
          reason: record.reason,
          subReason: record.subReason,
          featureRequests: record.featureRequests,
          competitor: record.competitor,
          sentiment: record.sentiment,
          quote: record.quote,
        })
        .onConflictDoNothing()
        .returning({ id: insights.id });
      if (rows.length === 0) return false;
      await onStored(tx);
      return true;
    });
  }
}
