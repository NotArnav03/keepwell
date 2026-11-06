import type { Action, ActionCreateInput } from "./actions.js";
import type { AuditAppendInput, AuditEntry } from "./audit.js";
import type { DomainEvent, DomainEventPayload, DomainEventType } from "./events.js";
import type { Page, PayPalSubscription, PayPalSubscriptionSummary } from "./paypal.js";

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
  /** Summaries only (id, status): PayPal's list has nothing else. */
  listSubscriptions(
    merchantId: string,
    query: ListSubscriptionsQuery,
  ): Promise<Page<PayPalSubscriptionSummary>>;
}

export interface ActionEngine<Tx = unknown> {
  /** Creates a PENDING Action (or returns the existing one for the same idempotencyKey). */
  create(input: ActionCreateInput, tx?: Tx): Promise<Action>;
  /** null if it doesn't exist or belongs to another merchant. */
  get(merchantId: string, actionId: string): Promise<Action | null>;
  /**
   * Writes a scheduled_resumes row; returns its id (the resume.due job and time machine use it).
   * With `afterActionId` (a pause's suspend Action), write it in the same transaction as that
   * Action: the resume only becomes due once the suspend is APPLIED, and is cancelled if the suspend
   * fails or is superseded. So a pause never leaves a resume behind, and never loses one either.
   */
  scheduleResume(
    input: { merchantId: string; subscriptionId: string; dueAt: string; afterActionId?: string },
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

/** A pooled subscription lent to one judge (ARCHITECTURE.md §6.17). */
export interface PoolLease {
  poolEntryId: string;
  /** Our subscription id; Judge Mode binds its widget token to it. */
  subscriptionId: string;
  paypalSubscriptionId: string;
  /**
   * ISO-8601, whole seconds. After this the pool takes it back on its own. With poolEntryId it
   * names this one lease: the entry is lent again later, under a new leasedUntil.
   */
  leasedUntil: string;
}

/**
 * What became of a returned subscription. "restoring": PayPal is being put back (a paused one
 * activated, a discount removed), and it rejoins the pool once that is done. "consumed": it can't
 * go back (cancelled, or moved to another plan).
 */
export type PoolReturn = "available" | "restoring" | "consumed";

export type PoolState = "available" | "leased" | "restoring" | "consumed";

/** M1 → M3 (Judge Mode). */
export interface JudgePool {
  /**
   * Leases the available ACTIVE subscription that has gone longest without a judge; one returned
   * in the last few minutes isn't lent again yet. null when none is: show the fallback.
   */
  lease(merchantId: string, input?: { minutes?: number }): Promise<PoolLease | null>;
  /**
   * True only while this exact lease is live: the entry is leased, with this leasedUntil. A lease
   * that was returned, or that ended and was lent to someone else, is false. Check it on every
   * request a lease token authorises.
   */
  holds(merchantId: string, poolEntryId: string, leasedUntil: string): Promise<boolean>;
  /**
   * Ends a lease early: the judge is done. Leases also end on their own at leasedUntil. With
   * leasedUntil, nothing happens unless that lease is still live, and the answer is null.
   */
  release(merchantId: string, poolEntryId: string, leasedUntil?: string): Promise<PoolReturn | null>;
  counts(merchantId: string): Promise<Record<PoolState, number>>;
}
