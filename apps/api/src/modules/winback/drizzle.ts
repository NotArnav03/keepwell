import { and, asc, eq, lte } from "drizzle-orm";
import { z } from "zod";
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

// PayPal's raw subscriber block inside subscriptions.snapshot; the only place the email lives.
const RawSnapshot = z.object({ subscriber: z.object({ email_address: z.string().optional() }).optional() });

export function drizzleSubscriptionDirectory(db: Db): SubscriptionDirectory {
  return {
    async get(merchantId, subscriptionId): Promise<WinbackSubscriptionView | null> {
      return db.forMerchant(merchantId, async (tx) => {
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
        const raw = RawSnapshot.safeParse(sub.snapshot);
        return {
          status:
            sub.status === "ACTIVE" || sub.status === "SUSPENDED" || sub.status === "CANCELLED"
              ? sub.status
              : "OTHER",
          planName: sub.planName,
          firstName: sub.subscriberFirstName,
          email: (raw.success && raw.data.subscriber?.email_address) || null,
          session,
        };
      });
    },
  };
}
