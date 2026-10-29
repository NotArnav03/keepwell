import { z } from "zod";
import { Id, IsoDateTime, Money } from "../shared.js";
import { ActionError, ActionState, ActionType } from "./actions.js";
import { SubscriptionSnapshot, SubscriptionStatus } from "./subscriptions.js";

// Domain events (CONTRACTS.md §2). Producers own their payloads; consumers ignore unknown fields.

/** Payloads of the events M1 produces. Subscription events come from a diff of fetched truth. */
export const platformEventPayloads = {
  "subscription.synced": z.object({ subscriptionId: Id, snapshot: SubscriptionSnapshot }),
  "subscription.status_changed": z.object({
    subscriptionId: Id,
    from: SubscriptionStatus,
    to: SubscriptionStatus,
  }),
  "subscription.plan_changed": z.object({
    subscriptionId: Id,
    fromPlanId: z.string().min(1),
    toPlanId: z.string().min(1),
  }),
  "subscription.payment_failed": z.object({
    subscriptionId: Id,
    reasonCode: z.string(),
    failedCount: z.number().int().min(1),
    nextRetryTime: IsoDateTime.nullable(),
  }),
  "subscription.payment_completed": z.object({ subscriptionId: Id, amount: Money }),
  /** Status became CANCELLED with no Keepwell cancel Action: cancelled inside PayPal. */
  "subscription.cancelled_externally": z.object({ subscriptionId: Id }),
  "action.state_changed": z.object({
    actionId: Id,
    subscriptionId: Id.nullable(),
    type: ActionType,
    /** null when the Action was just created. */
    from: ActionState.nullable(),
    to: ActionState,
    approveUrl: z.url().nullable(),
    error: ActionError.nullable(),
  }),
} as const;

/**
 * Every domain event's payload schema. Each workstream spreads its own map in here when its
 * contracts land (growthEventPayloads, the session events, policy.published).
 */
export const domainEventPayloads = {
  ...platformEventPayloads,
} as const;

export type DomainEventType = keyof typeof domainEventPayloads;
export type DomainEventPayload<T extends DomainEventType> = z.infer<(typeof domainEventPayloads)[T]>;

export const DomainEventType = z.enum(
  Object.keys(domainEventPayloads) as [DomainEventType, ...DomainEventType[]],
);

/** As stored in `domain_events` and delivered to handlers. */
export const DomainEventEnvelope = z.object({
  id: Id,
  type: DomainEventType,
  merchantId: Id,
  occurredAt: IsoDateTime,
  simulated: z.boolean(),
  payload: z.unknown(),
});

export interface DomainEvent<T extends DomainEventType = DomainEventType> {
  id: string;
  type: T;
  merchantId: string;
  occurredAt: string;
  simulated: boolean;
  payload: DomainEventPayload<T>;
}

export function parseDomainEventPayload<T extends DomainEventType>(
  type: T,
  payload: unknown,
): DomainEventPayload<T> {
  return domainEventPayloads[type].parse(payload) as DomainEventPayload<T>;
}
