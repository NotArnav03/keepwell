import type { GrowthJobName, GrowthJobPayload } from "@keepwell/contracts";

// What win-back needs from the rest of the platform. Each port is a small interface so the real
// implementation (jobs: M1, policy: M2, sessions and subscriptions: M1/M3) can be plugged in
// later and tests can use the in-memory versions.

export type WinbackState = "pending" | "sent" | "replied" | "skipped";

export interface WinbackCase {
  id: string;
  merchantId: string;
  subscriptionId: string;
  state: WinbackState;
  skipReason: string | null;
  dueAt: Date;
  sentAt: Date | null;
  notificationId: string | null;
  simulated: boolean;
}

export interface WinbackReply {
  id: string;
  merchantId: string;
  caseId: string;
  subscriptionId: string;
  text: string;
}

/** Every method runs inside one `db.forMerchant` transaction (the store opens it). */
export interface WinbackRepo {
  /** Inserts the case unless one exists for this subscription. `created` is false on a duplicate. */
  openCase(input: {
    merchantId: string;
    subscriptionId: string;
    dueAt: Date;
    simulated: boolean;
  }): Promise<{ case: WinbackCase; created: boolean }>;
  getCase(caseId: string): Promise<WinbackCase | null>;
  getCaseBySubscription(subscriptionId: string): Promise<WinbackCase | null>;
  /**
   * Moves a case out of `from` only if it is still there. False means someone else got there
   * first; that compare-and-set is what keeps "one message per cancellation" under retries.
   */
  transition(
    caseId: string,
    from: WinbackState,
    to: { state: WinbackState; skipReason?: string; sentAt?: Date; notificationId?: string },
  ): Promise<boolean>;
  insertReply(input: {
    merchantId: string;
    caseId: string;
    subscriptionId: string;
    text: string;
  }): Promise<WinbackReply>;
}

export interface WinbackStore {
  /** `tx` is the database transaction, passed on to Notifier, Audit and the job queue. */
  withMerchant<T>(merchantId: string, fn: (repo: WinbackRepo, tx: unknown) => Promise<T>): Promise<T>;
  /** Cross-tenant by nature: which merchant owns the case for a job that only carries subscriptionId. */
  locate(subscriptionId: string): Promise<{ merchantId: string } | null>;
  /** Cross-tenant: pending cases whose timer has passed (for the due-work sweep). */
  listDue(now: Date, limit: number): Promise<{ merchantId: string; subscriptionId: string }[]>;
}

/** Facts about the subscription at send time, from our read model (never from the event body). */
export interface WinbackSubscriptionView {
  status: "ACTIVE" | "SUSPENDED" | "CANCELLED" | "OTHER";
  planName: string;
  firstName: string | null;
  email: string | null;
  /** "open": a widget/portal session is still running. "saved": one ended with a saved_* outcome. */
  session: "none" | "open" | "saved" | "ended";
}

export interface SubscriptionDirectory {
  get(merchantId: string, subscriptionId: string): Promise<WinbackSubscriptionView | null>;
}

/** The merchant policy seam: a link to subscribe again, or null when the policy says don't invite back. */
export interface WinbackPolicy {
  resubscribeUrl(merchantId: string, subscriptionId: string): Promise<string | null>;
}

export interface SendOptions {
  /** Earliest time the job may run (pg-boss startAfter). */
  startAfter?: Date;
  singletonKey: string;
}

/** Thin view of pg-boss. `tx` lets the enqueue commit with the caller's own writes. */
export interface JobQueue {
  send<N extends GrowthJobName>(
    name: N,
    payload: GrowthJobPayload<N>,
    options: SendOptions,
    tx?: unknown,
  ): Promise<void>;
}
