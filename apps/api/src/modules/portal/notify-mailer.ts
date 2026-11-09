import { MAGIC_LINK_TTL_SECONDS, type Notifier } from "@keepwell/contracts";
import type { Db, Tx } from "@keepwell/db";
import type { MagicLink, MagicLinkMailer } from "./ports.js";

/**
 * Sends the portal's sign-in link through the notify outbox, so it is retried, audited and shows in
 * the Demo Inbox like every other message. The `portal.sign_in` template is exempt from the
 * frequency cap and the unsubscribe list (notify/dispatcher.ts): the subscriber just asked for it.
 */
export class NotifyMagicLinkMailer implements MagicLinkMailer {
  constructor(
    private readonly deps: {
      db: Db;
      notifier: Notifier<Tx>;
      /** The demo merchant's mail is flagged simulated, as everything its sandbox buyers receive. */
      simulated: (merchantId: string) => boolean;
    },
  ) {}

  async send(link: MagicLink): Promise<void> {
    await this.deps.db.forMerchant(link.merchantId, async (tx) => {
      await this.deps.notifier.enqueue(
        {
          merchantId: link.merchantId,
          subscriptionId: null,
          to: link.to,
          content: {
            template: "portal.sign_in",
            payload: { signInUrl: link.url, expiresInMinutes: Math.round(MAGIC_LINK_TTL_SECONDS / 60) },
          },
          simulated: this.deps.simulated(link.merchantId),
        },
        tx,
      );
    });
  }
}
