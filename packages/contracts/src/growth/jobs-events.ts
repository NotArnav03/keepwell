import { z } from "zod";
import { Id } from "../shared.js";
import { NotificationChannel, TemplateId } from "./notifications.js";

// M5 job queues (CONTRACTS.md §3), same shape as platformJobs and brainJobs.

/** "2026-10-29T17" style hour bucket, in UTC. */
function hourBucket(now: Date): string {
  return now.toISOString().slice(0, 13);
}

export const growthJobs = {
  "dunning.evaluate": {
    // failedCount is part of the key (CONTRACTS.md §3), so it travels in the payload.
    payload: z.object({ subscriptionId: Id, failedCount: z.number().int().min(1) }),
    idempotencyKey: (p: { subscriptionId: string; failedCount: number }): string =>
      `${p.subscriptionId}:${p.failedCount}`,
  },
  "notify.dispatch": {
    payload: z.object({ notificationId: Id }),
    idempotencyKey: (p: { notificationId: string }): string => p.notificationId,
  },
  "winback.start": {
    payload: z.object({ subscriptionId: Id }),
    idempotencyKey: (p: { subscriptionId: string }): string => p.subscriptionId,
  },
  "insights.extract": {
    // Exactly one source id, so the idempotency key is unambiguous.
    payload: z.union([z.strictObject({ sessionId: Id }), z.strictObject({ replyId: Id })]),
    idempotencyKey: (p: { sessionId: string } | { replyId: string }): string =>
      "sessionId" in p ? p.sessionId : p.replyId,
  },
  "insights.refresh_views": {
    payload: z.strictObject({}),
    idempotencyKey: (_p: Record<string, never>, now: Date): string => hourBucket(now),
  },
} as const;

export type GrowthJobName = keyof typeof growthJobs;
export type GrowthJobPayload<N extends GrowthJobName> = z.infer<(typeof growthJobs)[N]["payload"]>;

/** Payloads of the domain events M5 produces (CONTRACTS.md §2). Spread into domainEventPayloads. */
export const growthEventPayloads = {
  "notification.sent": z.object({
    notificationId: Id,
    template: TemplateId,
    channel: NotificationChannel,
  }),
  "insight_action.proposed": z.object({ insightActionId: Id }),
} as const;
