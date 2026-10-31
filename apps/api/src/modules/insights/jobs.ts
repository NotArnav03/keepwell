import { growthJobs, type DomainEvents } from "@keepwell/contracts";
import type { ExtractOutcome, InsightExtractor, InsightsLogger, SourceRef } from "./extractor.js";

/** The slice of the pg-boss wrapper (M1) this module needs; a duplicate singletonKey is a no-op. */
export interface InsightsJobQueue {
  send(
    name: "insights.extract" | "insights.refresh_views",
    payload: object,
    singletonKey: string,
  ): Promise<void>;
}

/**
 * Registration options for the insights.extract worker: a model that is down is retried with
 * growing delays for about a day, and the session it describes is never affected (§9).
 */
export const EXTRACT_JOB_OPTIONS = { retryLimit: 8, retryDelay: 60, retryBackoff: true } as const;

export const REFRESH_VIEWS_CRON = "7 * * * *"; // hourly, off the hour to avoid the due.sweep minute

/** Win-back replies call this once the reply is stored. */
export async function enqueueExtract(queue: InsightsJobQueue, ref: SourceRef): Promise<void> {
  const payload = growthJobs["insights.extract"].payload.parse(ref);
  await queue.send("insights.extract", payload, growthJobs["insights.extract"].idempotencyKey(payload));
}

/** session.closed → insights.extract. Enqueueing twice is harmless (singletonKey = session id). */
export function subscribeToSessionClosed(
  events: DomainEvents,
  queue: InsightsJobQueue,
  log: InsightsLogger,
): void {
  events.on("session.closed", "insights.enqueue_extract", async (event) => {
    await enqueueExtract(queue, { sessionId: event.payload.sessionId });
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
