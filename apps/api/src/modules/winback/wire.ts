import type { FastifyInstance } from "fastify";
import type { Audit, Notifier } from "@keepwell/contracts";
import type { Db, Tx } from "@keepwell/db";
import type { DbDomainEvents } from "../jobs/domain-events.js";
import type { Jobs } from "../jobs/jobs.js";
import type { Reconciler } from "../reconcile/reconciler.js";
import { drizzleSubscriptionDirectory, drizzleWinbackStore, type SubscriberLookup } from "./drizzle.js";
import type { WinbackPolicy } from "./ports.js";
import { winbackRoutes } from "./routes.js";
import { WinbackService } from "./service.js";

export interface WinbackWiring {
  app: FastifyInstance;
  db: Db;
  jobs: Jobs;
  events: DbDomainEvents;
  audit: Audit<Tx>;
  reconciler: Reconciler;
  paypal: SubscriberLookup;
  /** The real outbox (modules/notify, PR #91). Absent: cases are still recorded, nothing is sent. */
  notifier?: Notifier<Tx>;
  /** PORTAL_URL and MAGIC_LINK_SECRET. Absent: same as above. */
  portalUrl?: string;
  tokenSecret?: string;
  /** Until the policy document has an invite-back setting, nobody is invited back. */
  policy?: WinbackPolicy;
}

const NEVER_INVITE: WinbackPolicy = { resubscribeUrl: () => Promise.resolve(null) };

/**
 * Mounts win-back on the platform. Registering the event handler is unconditional, so a
 * cancellation is never lost; the durable case row waits (pg-boss holds the delayed job too)
 * until sending is configured. Call before the domain-events worker starts.
 */
export async function registerWinback(w: WinbackWiring): Promise<WinbackService> {
  const log = w.app.log;
  const canSend = Boolean(w.notifier && w.portalUrl && w.tokenSecret);
  const service = new WinbackService({
    store: drizzleWinbackStore(w.db),
    directory: drizzleSubscriptionDirectory(w.db, w.paypal),
    policy: w.policy ?? NEVER_INVITE,
    // Never reached when canSend is false: the worker and the sweep below are not registered.
    notifier: w.notifier ?? { enqueue: () => Promise.reject(new Error("no Notifier mounted")) },
    audit: w.audit,
    jobs: w.jobs,
    log,
    portalUrl: w.portalUrl ?? "http://localhost",
    tokenSecret: w.tokenSecret ?? "",
  });
  service.register(w.events);

  if (!canSend || !w.portalUrl || !w.tokenSecret) {
    log.warn(
      "winback: recording cancellations only; sending needs the notify module, PORTAL_URL and MAGIC_LINK_SECRET",
    );
    return service;
  }
  await w.jobs.work("winback.start", async ({ subscriptionId }) => {
    await service.start(subscriptionId);
  });
  // A lost winback.start job is caught here, on the same minute as the rest of the due work.
  w.reconciler.registerDueWork("winback", async () => {
    await service.sweepDue();
  });
  const portalOrigin = new URL(w.portalUrl).origin;
  await w.app.register(winbackRoutes, {
    prefix: "/v1",
    deps: {
      store: drizzleWinbackStore(w.db),
      audit: w.audit,
      jobs: w.jobs,
      log,
      tokenSecret: w.tokenSecret,
    },
    allowOrigin: (origin) => origin === portalOrigin,
  });
  return service;
}
