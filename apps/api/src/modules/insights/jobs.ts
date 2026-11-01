import { sql } from "drizzle-orm";
import { growthJobs, type DomainEvents, type GrowthJobPayload } from "@keepwell/contracts";
import type { Db } from "@keepwell/db";
import type { ExtractOutcome, InsightExtractor, InsightsLogger, SourceRef } from "./extractor.js";

type ExtractPayload = GrowthJobPayload<"insights.extract">;
type RefreshPayload = GrowthJobPayload<"insights.refresh_views">;

/**
 * Sent with every insights.extract job: a model that is down is retried with growing delays for
 * about a day (60 s, doubling, 8 tries), and the session it describes is never affected (§9).
 */
export const EXTRACT_JOB_OPTIONS = { retryLimit: 8, retryDelay: 60, retryBackoff: true } as const;

export const REFRESH_VIEWS_CRON = "7 * * * *"; // hourly, off the minute due.sweep uses

/**
 * The slice of the M1 `Jobs` class this module uses. A duplicate send with the same idempotency
 * key is a no-op there (it returns null).
 */
export interface InsightsJobs {
  send(
    name: "insights.extract",
    payload: ExtractPayload,
    options?: { retryLimit?: number; retryDelay?: number; retryBackoff?: boolean },
  ): Promise<string | null>;
  work(name: "insights.extract", handler: (payload: ExtractPayload) => Promise<void>): Promise<void>;
  work(name: "insights.refresh_views", handler: (payload: RefreshPayload) => Promise<void>): Promise<void>;
  schedule(name: "insights.refresh_views", cron: string, payload: RefreshPayload): Promise<void>;
}

/** Win-back replies call this once the reply is stored. */
export async function enqueueExtract(jobs: Pick<InsightsJobs, "send">, ref: SourceRef): Promise<void> {
  await jobs.send("insights.extract", growthJobs["insights.extract"].payload.parse(ref), EXTRACT_JOB_OPTIONS);
}

/** session.closed -> insights.extract. Enqueueing twice is harmless (the job key is the session id). */
export function subscribeToSessionClosed(
  events: DomainEvents,
  jobs: Pick<InsightsJobs, "send">,
  log: InsightsLogger,
): void {
  events.on("session.closed", "insights.enqueue_extract", async (event) => {
    await enqueueExtract(jobs, { sessionId: event.payload.sessionId });
    log.info(
      { merchantId: event.merchantId, sessionId: event.payload.sessionId },
      "insight extraction queued",
    );
  });
}

/** Worker body. Throws InsightsRetryLater when the model is down, so pg-boss backs off. */
export async function handleExtractJob(
  extractor: InsightExtractor,
  rawPayload: unknown,
): Promise<ExtractOutcome> {
  const payload = growthJobs["insights.extract"].payload.parse(rawPayload);
  return extractor.extract(payload);
}

/** Worker body, hourly. Safe to run twice: refreshing a materialized view twice is the same as once. */
export async function handleRefreshViewsJob(db: Db, log: InsightsLogger): Promise<void> {
  // Cross-tenant by nature: the view covers every merchant, and the definer function from
  // migration 0005 is the only way for the app role to refresh it. It rebuilds a derived cache
  // rather than changing merchant data, so it is logged, not audited per merchant.
  await db.acrossMerchants((tx) => tx.execute(sql`select refresh_insight_views()`));
  log.info({}, "insight views refreshed");
}

export interface RegisterInsightsOptions {
  db: Db;
  jobs: InsightsJobs;
  events: DomainEvents;
  extractor: InsightExtractor;
  log: InsightsLogger;
}

/**
 * Plugs the module into the platform: the session.closed handler (call before the events worker
 * starts), the extract worker, and the hourly view refresh.
 */
export async function registerInsights({
  db,
  jobs,
  events,
  extractor,
  log,
}: RegisterInsightsOptions): Promise<void> {
  subscribeToSessionClosed(events, jobs, log);
  await jobs.work("insights.extract", async (payload) => {
    await handleExtractJob(extractor, payload);
  });
  await jobs.work("insights.refresh_views", () => handleRefreshViewsJob(db, log));
  await jobs.schedule("insights.refresh_views", REFRESH_VIEWS_CRON, {});
}
