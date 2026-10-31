import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { NotificationContent, type Audit, type DomainEvents } from "@keepwell/contracts";
import { emailUnsubscribes, notifications, type Db, type Tx } from "@keepwell/db";
import type { NotifyConfig } from "./config.js";
import type { NotifyLogger } from "./notifier.js";
import { EmailProviderError, type EmailProvider } from "./providers.js";
import { renderTemplate } from "./templates.js";
import { unsubscribeUrl } from "./unsubscribe-token.js";

// The notify.dispatch job (CONTRACTS.md §3, idempotent on notificationId).
//
// Lifecycle: queued -> sending -> sent | queued again (retry) | failed | suppressed.
// "sending" is a lease: dueAt holds when the lease runs out, so a worker that died mid-send is
// picked up again by the sweep. The provider call carries the notification id as its idempotency
// key, so that second attempt can't deliver twice.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
export const MAX_PER_DAY = 1;
export const MAX_PER_WEEK = 3;
/**
 * A message the caps would delay by more than this (counted from when it was created) is suppressed
 * instead of deferred. A dunning nudge three days late is stale: the retry it described has passed.
 */
export const MAX_CAP_DEFERRAL_MS = 3 * DAY_MS;
export const MAX_ATTEMPTS = 5;
export const SEND_LEASE_MS = 5 * 60 * 1000;

/** 1, 4, 16, 64 minutes after the 1st..4th failure. */
export function backoffMs(attempts: number): number {
  return 60_000 * 4 ** (Math.max(1, attempts) - 1);
}

export type DispatchOutcome =
  | { status: "sent" }
  | { status: "suppressed"; reason: "unsubscribed" | "frequency_cap" }
  | { status: "deferred"; retryAt: Date }
  | { status: "retry_scheduled"; retryAt: Date }
  | { status: "failed" }
  /** Nothing to do: unknown id, already finished, not due yet, or another worker holds the lease. */
  | { status: "skipped" };

export interface DispatcherDeps {
  db: Db;
  provider: EmailProvider;
  audit: Audit<Tx>;
  events: DomainEvents<Tx>;
  config: NotifyConfig;
  log: NotifyLogger;
  now?: () => Date;
}

type Row = typeof notifications.$inferSelect;
type Claim =
  { kind: "done"; outcome: DispatchOutcome } | { kind: "send"; row: Row; content: NotificationContent };

export function createDispatcher(deps: DispatcherDeps) {
  const { db, provider, audit, events, config, log, now = () => new Date() } = deps;

  async function auditRow(tx: Tx, row: Row, kind: string, payload: Record<string, unknown>): Promise<void> {
    await audit.append(
      {
        merchantId: row.merchantId,
        actor: "system",
        kind,
        subjectIds: {
          notificationId: row.id,
          ...(row.subscriptionId ? { subscriptionId: row.subscriptionId } : {}),
        },
        payload,
        simulated: row.simulated,
      },
      tx,
    );
  }

  /** Decides what to do with the row and, if it is going out, takes the lease. One transaction. */
  async function claim(merchantId: string, notificationId: string): Promise<Claim> {
    return db.forMerchant(merchantId, async (tx) => {
      const at = now();
      const [row] = await tx
        .select()
        .from(notifications)
        .where(eq(notifications.id, notificationId))
        .for("update");
      const skipped: Claim = { kind: "done", outcome: { status: "skipped" } };
      if (!row) return skipped;
      // finished rows, rows not due yet, and rows another worker is sending right now
      if (!["queued", "sending"].includes(row.status) || row.dueAt > at) return skipped;

      const suppress = async (reason: "unsubscribed" | "frequency_cap"): Promise<Claim> => {
        await tx
          .update(notifications)
          .set({ status: "suppressed", suppressedBecause: reason })
          .where(eq(notifications.id, row.id));
        await auditRow(tx, row, "notification.suppressed", { reason });
        log.info({ merchantId, notificationId, reason }, "notification suppressed");
        return { kind: "done", outcome: { status: "suppressed", reason } };
      };

      const [unsubscribed] = await tx
        .select({ id: emailUnsubscribes.id })
        .from(emailUnsubscribes)
        .where(and(eq(emailUnsubscribes.merchantId, merchantId), eq(emailUnsubscribes.email, row.to)));
      if (unsubscribed) return suppress("unsubscribed");

      const nextAllowed = await nextAllowedSendTime(tx, row, at);
      if (nextAllowed) {
        if (nextAllowed.getTime() - row.createdAt.getTime() > MAX_CAP_DEFERRAL_MS) {
          return suppress("frequency_cap");
        }
        await tx
          .update(notifications)
          .set({ status: "queued", dueAt: nextAllowed })
          .where(eq(notifications.id, row.id));
        await auditRow(tx, row, "notification.deferred", {
          reason: "frequency_cap",
          retryAt: nextAllowed.toISOString(),
        });
        return { kind: "done", outcome: { status: "deferred", retryAt: nextAllowed } };
      }

      const content = NotificationContent.safeParse({ template: row.template, payload: row.payload });
      if (!content.success) {
        // A row that can never render must not retry forever.
        const error = { code: "invalid_content", message: z.prettifyError(content.error) };
        await tx
          .update(notifications)
          .set({ status: "failed", lastError: error })
          .where(eq(notifications.id, row.id));
        await auditRow(tx, row, "notification.failed", error);
        log.error({ merchantId, notificationId }, "notification content invalid");
        return { kind: "done", outcome: { status: "failed" } };
      }

      const [leased] = await tx
        .update(notifications)
        .set({
          status: "sending",
          attempts: row.attempts + 1,
          dueAt: new Date(at.getTime() + SEND_LEASE_MS),
        })
        .where(eq(notifications.id, row.id))
        .returning();
      if (!leased) throw new Error("notification disappeared while leased");
      return { kind: "send", row: leased, content: content.data };
    });
  }

  /** Caps count messages actually sent to the same address for this merchant, in the last 24 h / 7 days. */
  async function nextAllowedSendTime(tx: Tx, row: Row, at: Date): Promise<Date | null> {
    const sent = await tx
      .select({ sentAt: notifications.sentAt })
      .from(notifications)
      .where(
        and(
          eq(notifications.merchantId, row.merchantId),
          eq(notifications.to, row.to),
          eq(notifications.status, "sent"),
          gte(notifications.sentAt, new Date(at.getTime() - WEEK_MS)),
        ),
      )
      .orderBy(asc(notifications.sentAt));
    const times = sent.flatMap((s) => (s.sentAt ? [s.sentAt.getTime()] : []));
    let next = 0;
    const lastDay = times.filter((t) => t > at.getTime() - DAY_MS);
    if (lastDay.length >= MAX_PER_DAY)
      next = Math.max(next, (lastDay[lastDay.length - MAX_PER_DAY] ?? 0) + DAY_MS);
    if (times.length >= MAX_PER_WEEK) {
      next = Math.max(next, (times[times.length - MAX_PER_WEEK] ?? 0) + WEEK_MS);
    }
    return next > 0 ? new Date(next) : null;
  }

  async function dispatch(notificationId: string): Promise<DispatchOutcome> {
    // The job payload has only the id, so finding the owner is the one cross-tenant read.
    const [found] = await db.acrossMerchants((tx) =>
      tx
        .select({ merchantId: notifications.merchantId })
        .from(notifications)
        .where(eq(notifications.id, notificationId)),
    );
    if (!found) {
      log.warn({ notificationId }, "notify.dispatch for an unknown notification");
      return { status: "skipped" };
    }
    const { merchantId } = found;

    const claimed = await claim(merchantId, notificationId);
    if (claimed.kind === "done") return claimed.outcome;
    const { row, content } = claimed;

    const unsub = unsubscribeUrl(config.publicUrl, config.unsubscribeSecret, {
      merchantId,
      email: row.to,
    });
    const message = renderTemplate(content, unsub);

    let providerId: string | null = null;
    let failure: EmailProviderError | null = null;
    if (row.simulated) {
      // Simulated notifications never leave the building; the Demo Inbox is where they appear.
      providerId = `simulated:${row.id}`;
    } else {
      try {
        providerId = (
          await provider.send({
            id: row.id,
            to: row.to,
            subject: message.subject,
            text: message.bodyText,
            unsubscribeUrl: unsub,
          })
        ).providerId;
      } catch (err) {
        failure =
          err instanceof EmailProviderError
            ? err
            : new EmailProviderError("unexpected", err instanceof Error ? err.message : "send failed", true);
        log.warn({ merchantId, notificationId, err, attempt: row.attempts }, "email send failed");
      }
    }

    return db.forMerchant(merchantId, async (tx): Promise<DispatchOutcome> => {
      const at = now();
      if (!failure) {
        await tx
          .update(notifications)
          .set({ status: "sent", sentAt: at, providerId, lastError: null })
          .where(eq(notifications.id, row.id));
        await auditRow(tx, row, "notification.sent", { template: content.template, providerId });
        await events.emit(
          {
            type: "notification.sent",
            merchantId,
            payload: { notificationId: row.id, template: content.template, channel: "email" },
            simulated: row.simulated,
          },
          tx,
        );
        return { status: "sent" };
      }
      const lastError = { code: failure.code, message: failure.message };
      if (failure.retryable && row.attempts < MAX_ATTEMPTS) {
        const retryAt = new Date(at.getTime() + backoffMs(row.attempts));
        await tx
          .update(notifications)
          .set({ status: "queued", dueAt: retryAt, lastError })
          .where(eq(notifications.id, row.id));
        await auditRow(tx, row, "notification.send_failed", {
          ...lastError,
          attempt: row.attempts,
          retryAt: retryAt.toISOString(),
        });
        return { status: "retry_scheduled", retryAt };
      }
      await tx.update(notifications).set({ status: "failed", lastError }).where(eq(notifications.id, row.id));
      await auditRow(tx, row, "notification.failed", { ...lastError, attempt: row.attempts });
      return { status: "failed" };
    });
  }

  return { dispatch };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;

/**
 * For M1's due.sweep job: finds notifications whose time has come (including retries and expired
 * send leases) and hands each id to `enqueue`, which should enqueue notify.dispatch.
 * Cross-tenant by nature. Returns how many were enqueued.
 */
export async function enqueueDueNotifications(
  db: Db,
  enqueue: (payload: { notificationId: string }) => Promise<void>,
  now: Date = new Date(),
  limit = 100,
): Promise<number> {
  const due = await db.acrossMerchants((tx) =>
    tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(inArray(notifications.status, ["queued", "sending"]), lte(notifications.dueAt, now)))
      .orderBy(asc(notifications.dueAt))
      .limit(limit),
  );
  for (const { id } of due) await enqueue({ notificationId: id });
  return due.length;
}
