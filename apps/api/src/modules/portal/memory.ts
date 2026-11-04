import type { PortalSubscription } from "@keepwell/contracts";
import type {
  DelegationRecord,
  DelegationStore,
  MagicLink,
  MagicLinkMailer,
  MagicLinkRecord,
  MagicLinkStore,
  PortalDirectory,
} from "./ports.js";

// In-process versions of the ports: for tests and the fake server. Not for production, which
// needs links and delegations to survive a restart.

export class MemoryMagicLinkStore implements MagicLinkStore {
  private readonly links = new Map<string, MagicLinkRecord>();

  put(record: MagicLinkRecord): Promise<void> {
    this.links.set(record.tokenHash, record);
    return Promise.resolve();
  }

  consume(tokenHash: string, now: Date): Promise<MagicLinkRecord | null> {
    const link = this.links.get(tokenHash);
    // Deleting first is what makes it single use, even for an expired link.
    this.links.delete(tokenHash);
    return Promise.resolve(link !== undefined && link.expiresAt.getTime() > now.getTime() ? link : null);
  }
}

export class MemoryDelegationStore implements DelegationStore {
  private readonly rows = new Map<string, DelegationRecord>();

  insert(record: DelegationRecord): Promise<void> {
    this.rows.set(record.id, record);
    return Promise.resolve();
  }

  get(id: string): Promise<DelegationRecord | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  findByTokenHash(tokenHash: string): Promise<DelegationRecord | null> {
    for (const row of this.rows.values()) if (row.tokenHash === tokenHash) return Promise.resolve(row);
    return Promise.resolve(null);
  }

  listFor(merchantId: string, subscriptionIds: string[]): Promise<DelegationRecord[]> {
    const rows = [...this.rows.values()].filter(
      (row) => row.merchantId === merchantId && subscriptionIds.includes(row.subscriptionId),
    );
    return Promise.resolve(rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()));
  }

  revoke(id: string, at: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row !== undefined && row.revokedAt === null) row.revokedAt = at;
    return Promise.resolve();
  }
}

export class MemoryPortalDirectory implements PortalDirectory {
  private readonly merchants = new Map<string, string>();
  private readonly subscriptions = new Map<string, string[]>();
  private readonly summaries = new Map<string, PortalSubscription>();

  addMerchant(slug: string, merchantId: string): this {
    this.merchants.set(slug, merchantId);
    return this;
  }

  addSubscription(
    merchantId: string,
    emailHash: string,
    subscriptionId: string,
    summary?: PortalSubscription,
  ): this {
    if (summary !== undefined) this.summaries.set(`${merchantId}:${subscriptionId}`, summary);
    const key = `${merchantId}:${emailHash}`;
    this.subscriptions.set(key, [...(this.subscriptions.get(key) ?? []), subscriptionId]);
    return this;
  }

  merchantBySlug(slug: string): Promise<string | null> {
    return Promise.resolve(this.merchants.get(slug) ?? null);
  }

  summary(merchantId: string, subscriptionId: string): Promise<PortalSubscription | null> {
    return Promise.resolve(this.summaries.get(`${merchantId}:${subscriptionId}`) ?? null);
  }

  subscriptionsFor(merchantId: string, emailHash: string): Promise<string[]> {
    return Promise.resolve(this.subscriptions.get(`${merchantId}:${emailHash}`) ?? []);
  }
}

/** Remembers what it was asked to send, so tests (and the demo's server log) can read the link. */
export class RecordingMailer implements MagicLinkMailer {
  readonly sent: MagicLink[] = [];

  constructor(private readonly onSend?: (link: MagicLink) => void) {}

  send(link: MagicLink): Promise<void> {
    this.sent.push(link);
    this.onSend?.(link);
    return Promise.resolve();
  }
}
