import type { Action, ActionCreateInput } from "./actions.js";
import type { AuditAppendInput, AuditEntry } from "./audit.js";
import type { DomainEvent, DomainEventPayload, DomainEventType } from "./events.js";
import type { Page, PayPalSubscription } from "./paypal.js";

// M1 → everyone (CONTRACTS.md §5). `Tx` is the caller's database transaction, so a side effect
// commits or rolls back with the caller's own writes. Fakes ignore it.

export interface ListSubscriptionsQuery {
  /** ISO-8601; PayPal's `status_updated_after` filter. */
  statusUpdatedAfter?: string;
  planIds?: string[];
  /** 1-based. */
  page?: number;
}

/** Reads only. Mutations go through ActionEngine. Throws PayPalGatewayError. */
export interface PayPalGateway {
  getSubscription(merchantId: string, paypalSubscriptionId: string): Promise<PayPalSubscription>;
  listSubscriptions(merchantId: string, query: ListSubscriptionsQuery): Promise<Page<PayPalSubscription>>;
}

export interface ActionEngine<Tx = unknown> {
  /** Creates a PENDING Action (or returns the existing one for the same idempotencyKey). */
  create(input: ActionCreateInput, tx?: Tx): Promise<Action>;
  /** null if it doesn't exist or belongs to another merchant. */
  get(merchantId: string, actionId: string): Promise<Action | null>;
  /** Writes a scheduled_resumes row; returns its id (the resume.due job and time machine use it). */
  scheduleResume(
    input: { merchantId: string; subscriptionId: string; dueAt: string },
    tx?: Tx,
  ): Promise<string>;
}

export interface Audit<Tx = unknown> {
  append(entry: AuditAppendInput, tx?: Tx): Promise<AuditEntry>;
}

export interface DomainEvents<Tx = unknown> {
  emit<T extends DomainEventType>(
    event: { type: T; merchantId: string; payload: DomainEventPayload<T>; simulated?: boolean },
    tx?: Tx,
  ): Promise<void>;
  /** `handlerName` is stable and unique per event type: it keys the domain.dispatch job. */
  on<T extends DomainEventType>(
    type: T,
    handlerName: string,
    fn: (event: DomainEvent<T>) => Promise<void>,
  ): void;
}
