import { z } from "zod";
import { Id } from "../shared.js";
import { NotificationChannel, TemplateId } from "./notifications.js";

// M5 job payloads (CONTRACTS.md §3). The queue registry itself lives with the platform types.
export const DunningEvaluateJob = z.object({ subscriptionId: Id });
export const NotifyDispatchJob = z.object({ notificationId: Id });
export const WinbackStartJob = z.object({ subscriptionId: Id });
// Exactly one source id, so the idempotency key is unambiguous.
export const InsightsExtractJob = z.union([
  z.strictObject({ sessionId: Id }),
  z.strictObject({ replyId: Id }),
]);
export const InsightsRefreshViewsJob = z.strictObject({});

export const growthJobPayloads = {
  "dunning.evaluate": DunningEvaluateJob,
  "notify.dispatch": NotifyDispatchJob,
  "winback.start": WinbackStartJob,
  "insights.extract": InsightsExtractJob,
  "insights.refresh_views": InsightsRefreshViewsJob,
} as const;
export type GrowthJobName = keyof typeof growthJobPayloads;
export type GrowthJobPayload<N extends GrowthJobName> = z.infer<(typeof growthJobPayloads)[N]>;

// Payloads of the domain events M5 produces (CONTRACTS.md §2).
export const NotificationSentEvent = z.object({
  notificationId: Id,
  template: TemplateId,
  channel: NotificationChannel,
});
export const InsightActionProposedEvent = z.object({ insightActionId: Id });

export const growthEventPayloads = {
  "notification.sent": NotificationSentEvent,
  "insight_action.proposed": InsightActionProposedEvent,
} as const;
