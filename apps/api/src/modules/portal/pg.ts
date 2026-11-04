import { and, asc, eq, isNull } from "drizzle-orm";
import { DelegationScope } from "@keepwell/contracts";
import { delegations, magicLinks, merchants, subscriptions, type Db } from "@keepwell/db";
import type {
  DelegationRecord,
  DelegationStore,
  MagicLinkRecord,
  MagicLinkStore,
  PortalDirectory,
} from "./ports.js";

// Postgres versions of the portal's ports (Arnav, M1, for Aditya's module). Links and delegations
// must survive a Render restart, which the in-memory ones don't.
//
// Tenancy: writes and anything keyed by a merchant run in db.forMerchant. Lookups by a bearer
// secret (a link's or a delegation's token hash) or by a public slug run in db.acrossMerchants,
// because they arrive before we know the merchant: that lookup is how we find out. Each such query
// matches one unique key, so it can't return another tenant's rows by accident.

export class PgMagicLinkStore implements MagicLinkStore {
  constructor(private readonly db: Db) {}

  async put(record: MagicLinkRecord): Promise<void> {
    await this.db.forMerchant(record.merchantId, (tx) =>
      tx.insert(magicLinks).values({
        tokenHash: record.tokenHash,
        merchantId: record.merchantId,
        emailHash: record.emailHash,
        expiresAt: record.expiresAt,
      }),
    );
  }

  /**
   * One UPDATE marks the link used and returns it, so two clicks racing can't both get it. An
   * expired link is spent too (and then refused), the same as the in-memory store.
   */
  async consume(tokenHash: string, now: Date): Promise<MagicLinkRecord | null> {
    const [row] = await this.db.acrossMerchants((tx) =>
      tx
        .update(magicLinks)
        .set({ usedAt: now })
        .where(and(eq(magicLinks.tokenHash, tokenHash), isNull(magicLinks.usedAt)))
        .returning(),
    );
    if (row === undefined || row.expiresAt.getTime() <= now.getTime()) return null;
    return {
      tokenHash: row.tokenHash,
      merchantId: row.merchantId,
      emailHash: row.emailHash,
      expiresAt: row.expiresAt,
    };
  }
}

type DelegationRow = typeof delegations.$inferSelect;

function toRecord(row: DelegationRow): DelegationRecord {
  return {
    id: row.id,
    merchantId: row.merchantId,
    subscriptionId: row.subscriptionId,
    // Written only from DelegationScope values; parsed so a hand-edited row can't widen a grant.
    scopes: row.scopes.map((scope) => DelegationScope.parse(scope)),
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export class PgDelegationStore implements DelegationStore {
  constructor(private readonly db: Db) {}

  async insert(record: DelegationRecord): Promise<void> {
    await this.db.forMerchant(record.merchantId, (tx) =>
      tx.insert(delegations).values({
        id: record.id,
        merchantId: record.merchantId,
        subscriptionId: record.subscriptionId,
        scopes: record.scopes,
        tokenHash: record.tokenHash,
        expiresAt: record.expiresAt,
        revokedAt: record.revokedAt,
        createdAt: record.createdAt,
      }),
    );
  }

  /** By id alone (the port has no merchant): DelegationService checks the merchant before acting. */
  async get(id: string): Promise<DelegationRecord | null> {
    const [row] = await this.db.acrossMerchants((tx) =>
      tx.select().from(delegations).where(eq(delegations.id, id)).limit(1),
    );
    return row === undefined ? null : toRecord(row);
  }

  async findByTokenHash(tokenHash: string): Promise<DelegationRecord | null> {
    const [row] = await this.db.acrossMerchants((tx) =>
      tx.select().from(delegations).where(eq(delegations.tokenHash, tokenHash)).limit(1),
    );
    return row === undefined ? null : toRecord(row);
  }

  /** Only the first revoke sets the time; later ones change nothing. */
  async revoke(id: string, at: Date): Promise<void> {
    await this.db.acrossMerchants((tx) =>
      tx
        .update(delegations)
        .set({ revokedAt: at })
        .where(and(eq(delegations.id, id), isNull(delegations.revokedAt))),
    );
  }
}

export class PgPortalDirectory implements PortalDirectory {
  constructor(private readonly db: Db) {}

  async merchantBySlug(slug: string): Promise<string | null> {
    const [row] = await this.db.acrossMerchants((tx) =>
      tx.select({ id: merchants.id }).from(merchants).where(eq(merchants.slug, slug)).limit(1),
    );
    return row?.id ?? null;
  }

  /** Oldest first, so the portal lists a subscriber's subscriptions in a stable order. */
  async subscriptionsFor(merchantId: string, emailHash: string): Promise<string[]> {
    const rows = await this.db.forMerchant(merchantId, (tx) =>
      tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(
          and(eq(subscriptions.merchantId, merchantId), eq(subscriptions.subscriberEmailHash, emailHash)),
        )
        .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id)),
    );
    return rows.map((row) => row.id);
  }
}
