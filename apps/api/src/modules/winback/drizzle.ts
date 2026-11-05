import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { subscriptions, sessions, winbackCases, winbackReplies, type Db, type Tx } from "@keepwell/db";
import type {
  SubscriptionDirectory,
  WinbackCase,
  WinbackRepo,
  WinbackReply,
  WinbackStore,
  WinbackSubscriptionView,
} from "./ports.js";

// Postgres-backed ports. Every query runs inside db.forMerchant, except the two cross-tenant
// lookups, which use db.acrossMerchants because a job carries only a subscriptionId.

function toCase(row: typeof winbackCases.$inferSelect): WinbackCase {
  return {
    id: row.id,
    merchantId: row.merchantId,
    subscriptionId: row.subscriptionId,
    state: row.state,
    skipReason: row.skipReason,
    dueAt: row.dueAt,
    sentAt: row.sentAt,
    notificationId: row.notificationId,
    simulated: row.simulated,
  };
}

function repo(tx: Tx): WinbackRepo {
  return {
    async openCase(input) {
      const [inserted] = await tx.insert(winbackCases).values(input).onConflictDoNothing().returning();
      if (inserted) return { case: toCase(inserted), created: true };
      const [existing] = await tx
        .select()
        .from(winbackCases)
        .where(eq(winbackCases.subscriptionId, input.subscriptionId));
      if (!existing) throw new Error("winback case vanished after a conflict");
      return { case: toCase(existing), created: false };
    },
    async openCases(inputs) {
      if (inputs.length === 0) return [];
      const inserted = await tx.insert(winbackCases).values(inputs).onConflictDoNothing().returning();
      const createdBySub = new Map(inserted.map((row) => [row.subscriptionId, toCase(row)]));
      const missing = inputs.map((input) => input.subscriptionId).filter((id) => !createdBySub.has(id));
      const existingRows =
        missing.length === 0
          ? []
          : await tx.select().from(winbackCases).where(inArray(winbackCases.subscriptionId, missing));
      const existingBySub = new Map(existingRows.map((row) => [row.subscriptionId, toCase(row)]));
      return inputs.map((input) => {
        const created = createdBySub.get(input.subscriptionId);
        if (created) return { case: created, created: true };
        const existing = existingBySub.get(input.subscriptionId);
        // The unique (merchant, subscription) fired, so the winner is visible in this transaction.
        if (!existing) throw new Error("winback case vanished after a conflict");
        return { case: existing, created: false };
      });
    },
    async inspect(subscriptionIds) {
      // One read for the batch. Status is the synced snapshot column, not a PayPal GET per id.
      if (subscriptionIds.length === 0) return [];
      const rows = await tx
        .select({
          subscriptionId: subscriptions.id,
          status: subscriptions.status,
          caseId: winbackCases.id,
          caseMerchantId: winbackCases.merchantId,
          caseState: winbackCases.state,
          caseSkipReason: winbackCases.skipReason,
          caseDueAt: winbackCases.dueAt,
          caseSentAt: winbackCases.sentAt,
          caseNotificationId: winbackCases.notificationId,
          caseSimulated: winbackCases.simulated,
        })
        .from(subscriptions)
        .leftJoin(winbackCases, eq(winbackCases.subscriptionId, subscriptions.id))
        .where(inArray(subscriptions.id, subscriptionIds));
      return rows.map((row) => ({
        subscriptionId: row.subscriptionId,
        status: asViewStatus(row.status),
        winback: caseFromJoin(row),
      }));
    },
    async getCase(caseId) {
      const [row] = await tx.select().from(winbackCases).where(eq(winbackCases.id, caseId));
      return row ? toCase(row) : null;
    },
    async getCaseBySubscription(subscriptionId) {
      const [row] = await tx
        .select()
        .from(winbackCases)
        .where(eq(winbackCases.subscriptionId, subscriptionId));
      return row ? toCase(row) : null;
    },
    async transition(caseId, from, to) {
      const rows = await tx
        .update(winbackCases)
        .set(to)
        .where(and(eq(winbackCases.id, caseId), eq(winbackCases.state, from)))
        .returning({ id: winbackCases.id });
      return rows.length === 1;
    },
    async insertReply(input): Promise<WinbackReply> {
      const [row] = await tx.insert(winbackReplies).values(input).returning();
      if (!row) throw new Error("reply insert returned no row");
      return row;
    },
  };
}

export function drizzleWinbackStore(db: Db): WinbackStore {
  return {
    withMerchant: (merchantId, fn) => db.forMerchant(merchantId, (tx) => fn(repo(tx), tx)),
    async locate(subscriptionId) {
      const rows = await db.acrossMerchants((tx) =>
        tx
          .select({ merchantId: winbackCases.merchantId })
          .from(winbackCases)
          .where(eq(winbackCases.subscriptionId, subscriptionId)),
      );
      return rows[0] ?? null;
    },
    listDue(now, limit) {
      return db.acrossMerchants((tx) =>
        tx
          .select({ merchantId: winbackCases.merchantId, subscriptionId: winbackCases.subscriptionId })
          .from(winbackCases)
          .where(and(eq(winbackCases.state, "pending"), lte(winbackCases.dueAt, now)))
          .orderBy(asc(winbackCases.dueAt))
          .limit(limit),
      );
    },
  };
}

/** The part of the PayPal gateway the directory uses (reads only). */
export interface SubscriberLookup {
  getSubscription(
    merchantId: string,
    paypalSubscriptionId: string,
  ): Promise<{ subscriber?: { email_address?: string | undefined } | undefined }>;
}

/**
 * The subscriber's address is never stored (ARCHITECTURE.md section 10; sync.ts drops it), so it is
 * fetched from PayPal through the gateway at send time and goes straight into the notification.
 */
export function drizzleSubscriptionDirectory(db: Db, paypal: SubscriberLookup): SubscriptionDirectory {
  return {
    async get(merchantId, subscriptionId): Promise<WinbackSubscriptionView | null> {
      const found = await db.forMerchant(merchantId, async (tx) => {
        const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
        if (!sub) return null;
        const rows = await tx
          .select({ state: sessions.state, outcome: sessions.outcome })
          .from(sessions)
          .where(eq(sessions.subscriptionId, subscriptionId));
        const session = rows.some((r) => r.outcome?.startsWith("saved_"))
          ? "saved"
          : rows.some((r) => r.state !== "closed")
            ? "open"
            : rows.length > 0
              ? "ended"
              : "none";
        return { sub, session } as const;
      });
      if (!found) return null;
      const { sub, session } = found;
      const status = asViewStatus(sub.status);
      // Only worth a PayPal call (and an address in memory) when we might actually send.
      const email =
        status === "CANCELLED" && session !== "saved" && session !== "open"
          ? ((await paypal.getSubscription(merchantId, sub.paypalSubscriptionId)).subscriber?.email_address ??
            null)
          : null;
      return { status, planName: sub.planName, firstName: sub.subscriberFirstName, email, session };
    },
  };
}

function asViewStatus(status: string): WinbackSubscriptionView["status"] {
  if (status === "ACTIVE" || status === "SUSPENDED" || status === "CANCELLED") return status;
  return "OTHER";
}

interface JoinedCase {
  subscriptionId: string;
  caseId: string | null;
  caseMerchantId: string | null;
  caseState: WinbackCase["state"] | null;
  caseSkipReason: string | null;
  caseDueAt: Date | null;
  caseSentAt: Date | null;
  caseNotificationId: string | null;
  caseSimulated: boolean | null;
}

function present<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/** A left join leaves the case columns null when this subscription has no win-back row yet. */
function caseFromJoin(row: JoinedCase): WinbackCase | null {
  const id = row.caseId;
  const merchantId = row.caseMerchantId;
  const state = row.caseState;
  const dueAt = row.caseDueAt;
  const simulated = row.caseSimulated;
  // simulated false is a real case; only null means the join missed.
  if (!present(id)) return null;
  if (!present(merchantId)) return null;
  if (!present(state)) return null;
  if (!present(dueAt)) return null;
  if (!present(simulated)) return null;
  return {
    id,
    merchantId,
    subscriptionId: row.subscriptionId,
    state,
    skipReason: row.caseSkipReason,
    dueAt,
    sentAt: row.caseSentAt,
    notificationId: row.caseNotificationId,
    simulated,
  };
}
