import { randomUUID } from "node:crypto";
import {
  CreateDelegationRequest,
  DELEGATION_TTL_SECONDS,
  type CreateDelegationResponse,
  type DelegationScope,
} from "@keepwell/contracts";
import type { DelegationStore, PortalDirectory } from "./ports.js";
import { hashToken, newToken } from "./tokens.js";

// Delegation tokens (§6.7): what a subscriber hands their own AI agent. Scoped, hashed at rest,
// revocable, and gone after 7 days. Only a portal session can mint or revoke one, and only for
// subscriptions that session's email owns.

export class DelegationError extends Error {
  constructor(
    readonly status: 403 | 404,
    readonly code: "forbidden" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

/** Who is acting in the portal: the merchant and the hash of the email they proved they hold. */
export interface PortalPrincipal {
  merchantId: string;
  emailHash: string;
}

/** What a valid delegation token grants an agent. */
export interface DelegationGrant {
  merchantId: string;
  subscriptionId: string;
  scopes: DelegationScope[];
}

/** The prefix makes a leaked token recognisable in logs and secret scanners. */
export const DELEGATION_TOKEN_PREFIX = "kwd_";

export class DelegationService {
  private readonly clock: () => Date;

  constructor(
    private readonly deps: { store: DelegationStore; directory: PortalDirectory; clock?: () => Date },
  ) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async create(who: PortalPrincipal, input: CreateDelegationRequest): Promise<CreateDelegationResponse> {
    const { subscriptionId, scopes } = CreateDelegationRequest.parse(input);
    await this.requireOwnership(who, subscriptionId);
    const now = this.clock();
    const token = newToken(DELEGATION_TOKEN_PREFIX);
    const record = {
      id: randomUUID(),
      merchantId: who.merchantId,
      subscriptionId,
      scopes,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + DELEGATION_TTL_SECONDS * 1000),
      revokedAt: null,
      createdAt: now,
    };
    await this.deps.store.insert(record);
    return { id: record.id, token, scopes, expiresAt: record.expiresAt.toISOString() };
  }

  /** Someone else's delegation is "not found", not "forbidden", so ids can't be probed. */
  async revoke(who: PortalPrincipal, id: string): Promise<void> {
    const record = await this.deps.store.get(id);
    if (record === null || record.merchantId !== who.merchantId) throw notFound();
    const owned = await this.deps.directory.subscriptionsFor(who.merchantId, who.emailHash);
    if (!owned.includes(record.subscriptionId)) throw notFound();
    await this.deps.store.revoke(id, this.clock());
  }

  /** The grant for a token that is known, unexpired, unrevoked and carries `scope`; otherwise null. */
  async authenticate(token: string, scope: DelegationScope): Promise<DelegationGrant | null> {
    if (!token.startsWith(DELEGATION_TOKEN_PREFIX)) return null;
    const record = await this.deps.store.findByTokenHash(hashToken(token));
    if (record === null || record.revokedAt !== null) return null;
    if (record.expiresAt.getTime() <= this.clock().getTime()) return null;
    if (!record.scopes.includes(scope)) return null;
    return { merchantId: record.merchantId, subscriptionId: record.subscriptionId, scopes: record.scopes };
  }

  private async requireOwnership(who: PortalPrincipal, subscriptionId: string): Promise<void> {
    const owned = await this.deps.directory.subscriptionsFor(who.merchantId, who.emailHash);
    if (!owned.includes(subscriptionId)) {
      throw new DelegationError(403, "forbidden", "That subscription isn't on your account");
    }
  }
}

function notFound(): DelegationError {
  return new DelegationError(404, "not_found", "No such delegation");
}
