import { and, asc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  Action,
  AuditEntry,
  DomainEventEnvelope,
  ErrorEnvelope,
  Id,
  MerchantAuditQuery,
  MerchantAuditResponse,
  MerchantSubscriptionDetailResponse,
  MerchantSubscriptionListQuery,
  MerchantSubscriptionListResponse,
  MerchantTimelineQuery,
  MerchantTimelineResponse,
  SessionStreamEvent,
  SubscriptionSnapshot,
} from "@keepwell/contracts";
import {
  actions,
  auditLog,
  domainEvents,
  sessions,
  sessionEvents,
  subscriptions,
  type Db,
} from "@keepwell/db";
import { MERCHANT_FEED_CHANNEL } from "../jobs/domain-events.js";
import { MerchantAuthError, type MerchantAuthenticator } from "./auth.js";
import { listAtRisk } from "../insights/risk/query.js";

const PAGE_SIZE = 50;
const FIRST_EVENT_ID = "00000000-0000-0000-0000-000000000000";
const ClientError = new Map<number, string>([
  [400, "invalid_request"],
  [401, "unauthorized"],
  [403, "forbidden"],
  [404, "not_found"],
]);

export interface MerchantDataRoutesOptions {
  db: Db;
  pool: Pool;
  authenticator: MerchantAuthenticator;
}

export const merchantDataRoutes: FastifyPluginCallback<MerchantDataRoutesOptions> = (app, options, done) => {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof MerchantAuthError) return sendError(request, reply, error.status, error.message);
    if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number") {
      return sendError(request, reply, error.statusCode, error.message);
    }
    request.log.error({ err: error }, "merchant data route failed");
    return sendError(request, reply, 500, "Something went wrong on our side");
  });

  app.get("/subscriptions", async (request, reply) => {
    const principal = await options.authenticator.authenticate(request);
    const parsed = MerchantSubscriptionListQuery.safeParse(request.query);
    if (!parsed.success) return sendError(request, reply, 400, "Invalid subscriber filters.");
    const cursor = parsed.data.cursor ? Id.safeParse(parsed.data.cursor) : null;
    if (parsed.data.cursor && !cursor?.success)
      return sendError(request, reply, 400, "Invalid subscriber cursor.");
    const search = parsed.data.query?.trim();
    const rows = await options.db.forMerchant(principal.merchantId, (tx) =>
      tx
        .select()
        .from(subscriptions)
        .where(
          and(
            parsed.data.status ? eq(subscriptions.status, parsed.data.status) : undefined,
            search
              ? sql`(${subscriptions.subscriberFirstName} ILIKE ${`%${escapeLike(search)}%`} OR ${subscriptions.planName} ILIKE ${`%${escapeLike(search)}%`} OR ${subscriptions.paypalSubscriptionId} ILIKE ${`%${escapeLike(search)}%`})`
              : undefined,
            cursor?.success ? gt(subscriptions.id, cursor.data) : undefined,
          ),
        )
        .orderBy(asc(subscriptions.id))
        .limit(PAGE_SIZE + 1),
    );
    const page = rows.slice(0, PAGE_SIZE);
    const risk = await listAtRisk(options.db, principal.merchantId, { minScore: 0, limit: 200 });
    const riskById = new Map(
      risk.map((item) => [item.subscriptionId, { score: item.score, band: item.band }]),
    );
    const subscriptionsForResponse = page
      .map((row) => ({ subscription: snapshotFromRow(row), risk: riskById.get(row.id) ?? null }))
      .filter((item) => !parsed.data.risk || item.risk?.band === parsed.data.risk);
    const result = MerchantSubscriptionListResponse.parse({
      subscriptions: subscriptionsForResponse,
      nextCursor: rows.length > PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
    });
    return reply.send(result);
  });

  app.get("/subscriptions/:id", async (request, reply) => {
    const principal = await options.authenticator.authenticate(request);
    const params = Id.safeParse((request.params as { id?: unknown }).id);
    if (!params.success) return sendError(request, reply, 400, "Invalid subscription id.");
    const subscriptionId = params.data;
    const result = await options.db.forMerchant(principal.merchantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.merchantId, principal.merchantId)))
        .limit(1);
      if (!row) return null;
      const sessionRows = await tx
        .select()
        .from(sessions)
        .where(
          and(eq(sessions.merchantId, principal.merchantId), eq(sessions.subscriptionId, subscriptionId)),
        )
        .orderBy(asc(sessions.startedAt));
      const sessionIds = sessionRows.map((session) => session.id);
      const eventRows = sessionIds.length
        ? await tx
            .select()
            .from(sessionEvents)
            .where(
              and(
                eq(sessionEvents.merchantId, principal.merchantId),
                inArray(sessionEvents.sessionId, sessionIds),
              ),
            )
            .orderBy(asc(sessionEvents.seq))
        : [];
      const eventsBySession = new Map<string, ReturnType<typeof SessionStreamEvent.parse>[]>();
      for (const event of eventRows) {
        const list = eventsBySession.get(event.sessionId) ?? [];
        list.push(SessionStreamEvent.parse(event.event));
        eventsBySession.set(event.sessionId, list);
      }
      const actionRows = await tx
        .select()
        .from(actions)
        .where(and(eq(actions.merchantId, principal.merchantId), eq(actions.subscriptionId, subscriptionId)))
        .orderBy(asc(actions.createdAt));
      return {
        subscription: snapshotFromRow(row),
        sessions: sessionRows.map((session) => ({
          ...sessionToContract(session),
          events: eventsBySession.get(session.id) ?? [],
        })),
        actions: actionRows.map((action) =>
          Action.parse({
            ...action,
            paypalDebugIds: action.paypalDebugIds,
            error: action.error,
            approveUrl: action.approveUrl,
            createdAt: action.createdAt.toISOString(),
            updatedAt: action.updatedAt.toISOString(),
          }),
        ),
      };
    });
    if (!result) return sendError(request, reply, 404, "Subscriber not found.");
    return reply.send(MerchantSubscriptionDetailResponse.parse(result));
  });

  app.get("/audit", async (request, reply) => {
    const principal = await options.authenticator.authenticate(request);
    const parsed = MerchantAuditQuery.safeParse(request.query);
    if (!parsed.success) return sendError(request, reply, 400, "Invalid audit filters.");
    const cursor = parsed.data.cursor === undefined ? undefined : Number(parsed.data.cursor);
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1)) {
      return sendError(request, reply, 400, "Invalid audit cursor.");
    }
    const rows = await options.db.forMerchant(principal.merchantId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.merchantId, principal.merchantId),
            parsed.data.kind ? eq(auditLog.kind, parsed.data.kind) : undefined,
            parsed.data.subject
              ? sql`${auditLog.subjectIds}::text ILIKE ${`%${escapeLike(parsed.data.subject)}%`}`
              : undefined,
            cursor === undefined ? undefined : gt(auditLog.seq, cursor),
          ),
        )
        .orderBy(asc(auditLog.seq))
        .limit(PAGE_SIZE + 1),
    );
    const page = rows.slice(0, PAGE_SIZE);
    return reply.send(
      MerchantAuditResponse.parse({
        entries: page.map((row) => AuditEntry.parse({ ...row, at: row.at.toISOString() })),
        nextCursor: rows.length > PAGE_SIZE ? String(page.at(-1)?.seq ?? "") : null,
      }),
    );
  });

  app.get("/timeline", async (request, reply) => {
    const principal = await options.authenticator.authenticate(request);
    const parsed = MerchantTimelineQuery.safeParse(request.query);
    if (!parsed.success) return sendError(request, reply, 400, "Invalid timeline range.");
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    const [auditRows, subscriptionRows] = await Promise.all([
      options.db.forMerchant(principal.merchantId, (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(
            and(eq(auditLog.merchantId, principal.merchantId), gte(auditLog.at, from), lte(auditLog.at, to)),
          )
          .orderBy(asc(auditLog.at))
          .limit(5000),
      ),
      options.db.forMerchant(principal.merchantId, (tx) =>
        tx.select().from(subscriptions).where(eq(subscriptions.merchantId, principal.merchantId)),
      ),
    ]);
    const byId = new Map(subscriptionRows.map((row) => [row.id, row]));
    const resources = new Map<string, { id: string; name: string; subscriptionId: string }>();
    const events = [];
    for (const entry of auditRows) {
      const subjects = entry.subjectIds as Record<string, string>;
      const subscriptionId = subjects.subscriptionId;
      const subscription = subscriptionId ? byId.get(subscriptionId) : undefined;
      if (!subscription) continue;
      resources.set(subscription.id, {
        id: subscription.id,
        name: subscription.subscriberFirstName ?? "Subscriber",
        subscriptionId: subscription.id,
      });
      events.push({
        id: `${subscription.id.slice(0, 23)}-${String(entry.seq).padStart(12, "0")}`,
        resourceId: subscription.id,
        startDate: entry.at.toISOString(),
        endDate: null,
        name: entry.kind,
        kind: entry.kind,
        auditSeq: entry.seq,
        paypalSubscriptionId: subscription.paypalSubscriptionId,
        simulated: entry.simulated,
      });
    }
    return reply.send(MerchantTimelineResponse.parse({ resources: [...resources.values()], events }));
  });

  app.get("/feed", async (request, reply) => {
    const principal = await options.authenticator.authenticate(request);
    const lastEventHeader = request.headers["last-event-id"];
    const lastEventId = typeof lastEventHeader === "string" ? Id.safeParse(lastEventHeader) : null;
    if (lastEventHeader && !lastEventId?.success) {
      return sendError(request, reply, 400, "Invalid event cursor.");
    }
    const client = await options.pool.connect();
    try {
      await client.query(`LISTEN ${MERCHANT_FEED_CHANNEL}`);
    } catch (error) {
      client.release();
      request.log.error({ err: error }, "merchant feed LISTEN failed");
      return sendError(request, reply, 503, "Live activity is temporarily unavailable.");
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.flushHeaders();

    let cursor: string | null = lastEventId?.success ? lastEventId.data : null;
    let draining = false;
    let notificationPending = false;
    let closed = false;
    const drain = async (): Promise<void> => {
      if (closed) return;
      if (draining) {
        notificationPending = true;
        return;
      }
      draining = true;
      try {
        if (cursor === null) {
          const [latest] = await options.db.forMerchant(principal.merchantId, (tx) =>
            tx
              .select({ id: domainEvents.id })
              .from(domainEvents)
              .where(eq(domainEvents.merchantId, principal.merchantId))
              .orderBy(sql`${domainEvents.id} DESC`)
              .limit(1),
          );
          cursor = latest?.id ?? FIRST_EVENT_ID;
          return;
        }
        for (;;) {
          if (cursor === null) break;
          const after: string = cursor;
          const rows: (typeof domainEvents.$inferSelect)[] = await options.db.forMerchant(
            principal.merchantId,
            (tx) =>
              tx
                .select()
                .from(domainEvents)
                .where(and(eq(domainEvents.merchantId, principal.merchantId), gt(domainEvents.id, after)))
                .orderBy(asc(domainEvents.id))
                .limit(100),
          );
          if (rows.length === 0) break;
          for (const row of rows) {
            if (closed) return;
            const event = DomainEventEnvelope.parse({
              id: row.id,
              type: row.type,
              merchantId: row.merchantId,
              occurredAt: row.occurredAt.toISOString(),
              simulated: row.simulated,
              payload: row.payload,
            });
            if (!reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)) {
              await new Promise<void>((resolve) => reply.raw.once("drain", resolve));
            }
            cursor = row.id;
          }
          if (rows.length < 100) break;
        }
      } catch (error) {
        request.log.warn(
          { err: error, merchantId: principal.merchantId },
          "merchant feed event query failed",
        );
        if (!closed)
          reply.raw.write(
            `event: error\ndata: ${JSON.stringify({ message: "Live activity temporarily interrupted." })}\n\n`,
          );
      } finally {
        draining = false;
        if (notificationPending && !closed) {
          notificationPending = false;
          void drain();
        }
      }
    };
    const Notification = z.object({ merchantId: Id, eventId: Id });
    const onNotification = (notification: { channel?: string | null; payload?: string | null }) => {
      if (notification.channel !== MERCHANT_FEED_CHANNEL || !notification.payload) return;
      let payload: unknown;
      try {
        payload = JSON.parse(notification.payload) as unknown;
      } catch (error) {
        request.log.warn({ err: error }, "malformed merchant feed notification");
        return;
      }
      const message = Notification.safeParse(payload);
      if (!message.success || message.data.merchantId !== principal.merchantId) return;
      void drain();
    };
    client.on("notification", onNotification);
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(": keep-alive\n\n");
    }, 15_000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      client.removeListener("notification", onNotification);
      client
        .query(`UNLISTEN ${MERCHANT_FEED_CHANNEL}`)
        .catch((error: unknown) => {
          request.log.warn({ err: error }, "merchant feed UNLISTEN failed");
        })
        .finally(() => client.release());
    };
    reply.raw.once("close", cleanup);
    await drain();
  });

  done();
};

function snapshotFromRow(row: typeof subscriptions.$inferSelect) {
  const money = (value: string | null, currency: string | null) =>
    value === null || currency === null ? null : { value, currency };
  return SubscriptionSnapshot.parse({
    id: row.id,
    merchantId: row.merchantId,
    paypalSubscriptionId: row.paypalSubscriptionId,
    paypalPlanId: row.paypalPlanId,
    planName: row.planName,
    price: { value: row.priceValue, currency: row.priceCurrency },
    priceOverride: money(row.overrideValue, row.overrideCurrency),
    interval: { unit: row.intervalUnit, count: row.intervalCount },
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    nextBillingTime: row.nextBillingTime?.toISOString() ?? null,
    lastPayment:
      row.lastPaymentAt && row.lastPaymentValue && row.lastPaymentCurrency
        ? {
            amount: { value: row.lastPaymentValue, currency: row.lastPaymentCurrency },
            time: row.lastPaymentAt.toISOString(),
          }
        : null,
    outstandingBalance: money(row.outstandingValue, row.outstandingCurrency),
    failedPaymentsCount: row.failedPaymentsCount,
    lastFailure:
      row.lastFailureAt && row.lastFailureReason
        ? {
            reasonCode: row.lastFailureReason,
            time: row.lastFailureAt.toISOString(),
            nextRetryTime: row.nextRetryTime?.toISOString() ?? null,
          }
        : null,
    subscriberFirstName: row.subscriberFirstName,
    syncedAt: row.syncedAt.toISOString(),
  });
}

function sessionToContract(session: typeof sessions.$inferSelect) {
  return {
    id: session.id,
    merchantId: session.merchantId,
    subscriptionId: session.subscriptionId,
    channel: session.channel,
    state: session.state,
    fallbackLevel: session.fallbackLevel,
    reason: session.reason,
    presentedOfferId: session.presentedOfferId,
    policyVersion: session.policyVersion,
    outcome: session.outcome,
    startedAt: session.startedAt.toISOString(),
    closedAt: session.closedAt?.toISOString() ?? null,
    simulated: session.simulated,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  message: string,
): FastifyReply {
  const code = ClientError.get(status) ?? "internal";
  return reply.code(status).send(ErrorEnvelope.parse({ error: { code, message, requestId: request.id } }));
}
