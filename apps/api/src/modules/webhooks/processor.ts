import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { merchants, webhookEvents, type Db } from "@keepwell/db";
import type { SubscriptionSync } from "../reconcile/sync.js";

// The webhook.process job (ARCHITECTURE.md §6.2): verify the signature with PayPal, then treat the
// event only as a hint. The subscription it mentions is fetched and diffed (SubscriptionSync), so the
// event body is never trusted as state. A rejected signature is recorded and alerted, never acted on.

export interface WebhookVerifier {
  verifyWebhookSignature(
    merchantId: string,
    input: { webhookId: string; headers: Record<string, string | undefined>; rawBody: string },
  ): Promise<boolean>;
}

export interface ProcessorLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export type ProcessOutcome = "processed" | "rejected" | "skipped";

const Event = z.looseObject({
  event_type: z.string(),
  resource_type: z.string().optional(),
  resource: z
    .looseObject({ id: z.string().optional(), billing_agreement_id: z.string().optional() })
    .optional(),
});

export class WebhookProcessor {
  constructor(
    private readonly db: Db,
    private readonly paypal: WebhookVerifier,
    private readonly sync: SubscriptionSync,
    private readonly log: ProcessorLogger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async process(webhookEventId: string): Promise<ProcessOutcome> {
    // The job knows the row, not the merchant: look the row up across merchants, then scope.
    const [row] = await this.db.acrossMerchants((tx) =>
      tx.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId)),
    );
    if (!row || row.status !== "received") return "skipped";
    const { merchantId } = row;
    const log = { merchantId, webhookEventId, eventId: row.eventId, eventType: row.eventType };
    await this.update(merchantId, webhookEventId, { attempts: sql`${webhookEvents.attempts} + 1` });

    const [merchant] = await this.db.forMerchant(merchantId, (tx) =>
      tx.select({ webhookId: merchants.webhookId }).from(merchants).where(eq(merchants.id, merchantId)),
    );
    const headers = row.headers as Record<string, string | undefined>;
    const verified =
      merchant?.webhookId != null &&
      (await this.paypal.verifyWebhookSignature(merchantId, {
        webhookId: merchant.webhookId,
        headers,
        rawBody: row.rawBody,
      }));
    if (!verified) {
      this.log.error(log, "paypal webhook signature rejected");
      await this.update(merchantId, webhookEventId, {
        verification: "REJECTED",
        status: "rejected",
        processedAt: this.clock(),
        error:
          merchant?.webhookId == null
            ? "merchant has no webhook registered"
            : "signature verification failed",
      });
      return "rejected";
    }

    const event = Event.parse(JSON.parse(row.rawBody));
    const subscriptionId = subscriptionIdOf(event);
    if (subscriptionId !== null) await this.sync.sync(merchantId, subscriptionId);
    await this.update(merchantId, webhookEventId, {
      verification: "VERIFIED",
      status: "processed",
      processedAt: this.clock(),
      error: null,
    });
    this.log.info({ ...log, subscriptionId }, "paypal webhook processed");
    return "processed";
  }

  private async update(
    merchantId: string,
    id: string,
    set: Partial<typeof webhookEvents.$inferInsert> | { attempts: ReturnType<typeof sql> },
  ): Promise<void> {
    await this.db.forMerchant(merchantId, (tx) =>
      tx.update(webhookEvents).set(set).where(eq(webhookEvents.id, id)),
    );
  }
}

/** The subscription an event is about: the resource itself, or the sale's billing agreement. */
function subscriptionIdOf(event: z.infer<typeof Event>): string | null {
  if (event.event_type.startsWith("BILLING.SUBSCRIPTION.") || event.resource_type === "subscription") {
    return event.resource?.id ?? null;
  }
  if (event.event_type.startsWith("PAYMENT.SALE.")) return event.resource?.billing_agreement_id ?? null;
  return null;
}
