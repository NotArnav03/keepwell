import type { FastifyBaseLogger } from "fastify";
import { NotificationRequest, type Audit, type Notifier } from "@keepwell/contracts";
import { notifications, type Db, type Tx } from "@keepwell/db";
import { normalizeEmail } from "./unsubscribe-token.js";

export type NotifyLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

export interface NotifierDeps {
  db: Db;
  audit: Audit<Tx>;
  log: NotifyLogger;
  now?: () => Date;
}

/**
 * The transactional outbox. It only records the message; the notify.dispatch job (picked up by the
 * due-work sweep) sends it. Pass the caller's `tx` so the row commits or rolls back with the
 * business change that wanted the email.
 */
export function createNotifier({ db, audit, log, now = () => new Date() }: NotifierDeps): Notifier<Tx> {
  async function insert(tx: Tx, request: ReturnType<typeof NotificationRequest.parse>): Promise<string> {
    const dueAt = request.dueAt ? new Date(request.dueAt) : now();
    const [row] = await tx
      .insert(notifications)
      .values({
        merchantId: request.merchantId,
        subscriptionId: request.subscriptionId,
        to: normalizeEmail(request.to),
        channel: "email",
        template: request.content.template,
        payload: request.content.payload,
        dueAt,
        status: "queued",
        simulated: request.simulated,
      })
      .returning({ id: notifications.id });
    if (!row) throw new Error("notification insert returned no row");
    await audit.append(
      {
        merchantId: request.merchantId,
        actor: "system",
        kind: "notification.enqueued",
        subjectIds: {
          notificationId: row.id,
          ...(request.subscriptionId ? { subscriptionId: request.subscriptionId } : {}),
        },
        // No address in the audit log: it is covered by the notification row itself.
        payload: { template: request.content.template, dueAt: dueAt.toISOString() },
        simulated: request.simulated,
      },
      tx,
    );
    log.info(
      { merchantId: request.merchantId, subscriptionId: request.subscriptionId, notificationId: row.id },
      "notification enqueued",
    );
    return row.id;
  }

  return {
    async enqueue(n, tx) {
      const request = NotificationRequest.parse(n);
      if (tx) return insert(tx, request);
      return db.forMerchant(request.merchantId, (scoped) => insert(scoped, request));
    },
  };
}
