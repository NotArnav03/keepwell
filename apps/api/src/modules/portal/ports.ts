import type { DelegationScope, PortalSubscription } from "@keepwell/contracts";

// What the identity services need from the outside world. Postgres-backed versions arrive with the
// sessions module (#32); memory.ts holds the in-process ones the fake server and the tests use.

/** Who a portal login can match. Postgres: `merchants.slug` and `subscriptions.subscriber_email_hash`. */
export interface PortalDirectory {
  merchantBySlug(slug: string): Promise<string | null>;
  /** Our ids of the merchant's subscriptions whose PayPal email hashes to `emailHash`. */
  subscriptionsFor(merchantId: string, emailHash: string): Promise<string[]>;
  /** What the portal shows for one subscription; null if it is gone. */
  summary(merchantId: string, subscriptionId: string): Promise<PortalSubscription | null>;
}

export interface MagicLinkRecord {
  tokenHash: string;
  merchantId: string;
  emailHash: string;
  expiresAt: Date;
}

export interface MagicLinkStore {
  put(record: MagicLinkRecord): Promise<void>;
  /** Marks the link used and returns it, atomically: a second call gets null. Expired links too. */
  consume(tokenHash: string, now: Date): Promise<MagicLinkRecord | null>;
}

export interface MagicLink {
  merchantId: string;
  to: string;
  url: string;
  expiresAt: Date;
}

/** Sends the link. The real one rides the notification outbox (M5); the demo one logs it. */
export interface MagicLinkMailer {
  send(link: MagicLink): Promise<void>;
}

/** The `delegations` table row (packages/db/src/schema/surfaces.ts). */
export interface DelegationRecord {
  id: string;
  merchantId: string;
  subscriptionId: string;
  scopes: DelegationScope[];
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface DelegationStore {
  insert(record: DelegationRecord): Promise<void>;
  get(id: string): Promise<DelegationRecord | null>;
  findByTokenHash(tokenHash: string): Promise<DelegationRecord | null>;
  /** Every delegation (live or not) on these subscriptions, newest first. */
  listFor(merchantId: string, subscriptionIds: string[]): Promise<DelegationRecord[]>;
  /** Sets revokedAt once; revoking twice keeps the first time. */
  revoke(id: string, at: Date): Promise<void>;
}
