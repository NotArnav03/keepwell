import { MAGIC_LINK_TTL_SECONDS, type MagicLinkRequest } from "@keepwell/contracts";
import type { MagicLinkMailer, MagicLinkStore, PortalDirectory } from "./ports.js";
import { hashEmail, hashToken, newToken } from "./tokens.js";

// Magic links for the hosted portal (§6.7): sent to the email PayPal holds for a subscription,
// single use, 15 minutes. The caller answers 202 whatever happens here, so a stranger can't use
// this to learn which emails are subscribers.

export interface MagicLinkServiceDeps {
  directory: PortalDirectory;
  store: MagicLinkStore;
  mailer: MagicLinkMailer;
  /** Where the emailed link points: the API's GET /portal/verify with the token. */
  verifyUrl: (token: string) => string;
  clock?: () => Date;
}

export class MagicLinkService {
  private readonly clock: () => Date;

  constructor(private readonly deps: MagicLinkServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Mails a link when the email matches a subscription of that merchant, and does nothing when it
   * doesn't. Since the hash matched, the typed email is the PayPal email, so it is safe to send to.
   */
  async request(input: MagicLinkRequest): Promise<void> {
    const merchantId = await this.deps.directory.merchantBySlug(input.merchantSlug);
    if (merchantId === null) return;
    const emailHash = hashEmail(input.email);
    const subscriptions = await this.deps.directory.subscriptionsFor(merchantId, emailHash);
    if (subscriptions.length === 0) return;

    const token = newToken();
    const expiresAt = new Date(this.clock().getTime() + MAGIC_LINK_TTL_SECONDS * 1000);
    await this.deps.store.put({ tokenHash: hashToken(token), merchantId, emailHash, expiresAt });
    await this.deps.mailer.send({
      merchantId,
      to: input.email.trim(),
      url: this.deps.verifyUrl(token),
      expiresAt,
    });
  }

  /** Spends a link. Null for anything unknown, used or expired; the three look the same. */
  async redeem(token: string): Promise<{ merchantId: string; emailHash: string } | null> {
    const link = await this.deps.store.consume(hashToken(token), this.clock());
    return link === null ? null : { merchantId: link.merchantId, emailHash: link.emailHash };
  }
}
