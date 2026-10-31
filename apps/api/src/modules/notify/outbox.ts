import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { Id, NotificationContent, type OutboxItem, type OutboxResponse } from "@keepwell/contracts";
import { notifications, type Db } from "@keepwell/db";
import type { NotifyConfig } from "./config.js";
import type { NotifyLogger } from "./notifier.js";
import { renderTemplate } from "./templates.js";
import { unsubscribeUrl } from "./unsubscribe-token.js";

// Demo Inbox: GET /v1/m/outbox. Messages are rendered on read from template + payload with the same
// code the dispatcher uses, so the inbox shows exactly what was (or will be) sent, even while the
// email provider is down.

export const OutboxQuery = z.object({
  cursor: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export class InvalidCursorError extends Error {
  constructor() {
    super("cursor is not valid");
    this.name = "InvalidCursorError";
  }
}

// Ids are UUIDv7, so id order is creation order and the last id seen is a complete cursor.
const encodeCursor = (id: string): string => Buffer.from(id).toString("base64url");
function decodeCursor(cursor: string): string {
  const id = Id.safeParse(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!id.success) throw new InvalidCursorError();
  return id.data;
}

export interface OutboxDeps {
  db: Db;
  config: NotifyConfig;
  log: NotifyLogger;
}

export async function listOutbox(
  { db, config, log }: OutboxDeps,
  merchantId: string,
  query: z.infer<typeof OutboxQuery>,
): Promise<OutboxResponse> {
  const before = query.cursor ? decodeCursor(query.cursor) : null;
  const rows = await db.forMerchant(merchantId, (tx) =>
    tx
      .select()
      .from(notifications)
      .where(and(eq(notifications.merchantId, merchantId), before ? lt(notifications.id, before) : undefined))
      .orderBy(desc(notifications.id))
      .limit(query.limit + 1),
  );
  const page = rows.slice(0, query.limit);
  const items = page.map((row): OutboxItem => {
    const content = NotificationContent.safeParse({ template: row.template, payload: row.payload });
    const rendered = content.success
      ? renderTemplate(
          content.data,
          unsubscribeUrl(config.publicUrl, config.unsubscribeSecret, { merchantId, email: row.to }),
        )
      : { subject: "(message could not be rendered)", bodyText: "" };
    if (!content.success)
      log.error({ merchantId, notificationId: row.id }, "stored notification does not parse");
    return {
      id: row.id,
      subscriptionId: row.subscriptionId,
      to: row.to,
      // The contract needs a TemplateId, so an unparseable row falls back to the generic one.
      template: content.success ? content.data.template : "dunning.generic",
      subject: rendered.subject,
      bodyText: rendered.bodyText,
      status: row.status,
      suppressedBecause: row.suppressedBecause,
      dueAt: row.dueAt.toISOString(),
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      simulated: row.simulated,
    };
  });
  const last = page.at(-1);
  return { items, nextCursor: rows.length > query.limit && last ? encodeCursor(last.id) : null };
}
