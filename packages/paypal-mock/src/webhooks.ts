import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { crc32 } from "node:zlib";
import type { WebhookEvent, WebhookRecord } from "./records.js";
import { paypalTime } from "./units.js";

// Webhook signing, delivery and verification. PayPal signs `transmissionId|time|webhookId|crc32(body)`
// with RSA; the mock uses an HMAC over the same string, so only the mock's own verify endpoint
// accepts its signatures, just as only PayPal's verify endpoint accepts PayPal's.

// Not a secret: it only signs events this mock sends to a local URL.
const SIGNING_KEY = "keepwell-paypal-mock";
export const MOCK_CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-keepwell-mock";
export const AUTH_ALGO = "SHA256withRSA";

export interface SignedHeaders {
  "paypal-transmission-id": string;
  "paypal-transmission-time": string;
  "paypal-transmission-sig": string;
  "paypal-cert-url": string;
  "paypal-auth-algo": string;
}

function signature(transmissionId: string, time: string, webhookId: string, body: string): string {
  const message = `${transmissionId}|${time}|${webhookId}|${crc32(body)}`;
  return createHmac("sha256", SIGNING_KEY).update(message).digest("base64");
}

export function sign(webhookId: string, body: string, now: Date): SignedHeaders {
  const transmissionId = randomUUID();
  const time = paypalTime(now);
  return {
    "paypal-transmission-id": transmissionId,
    "paypal-transmission-time": time,
    "paypal-transmission-sig": signature(transmissionId, time, webhookId, body),
    "paypal-cert-url": MOCK_CERT_URL,
    "paypal-auth-algo": AUTH_ALGO,
  };
}

/**
 * The check behind POST /v1/notifications/verify-webhook-signature. `body` must be the event
 * exactly as delivered: a client that re-serialises it differently fails, as with PayPal.
 */
export function verify(input: {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  webhookId: string;
  certUrl: string;
  authAlgo: string;
  body: string;
}): boolean {
  if (input.certUrl !== MOCK_CERT_URL || input.authAlgo !== AUTH_ALGO) return false;
  const expected = Buffer.from(
    signature(input.transmissionId, input.transmissionTime, input.webhookId, input.body),
  );
  const actual = Buffer.from(input.transmissionSig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface WebhookDelivery {
  eventId: string;
  eventType: string;
  webhookId: string;
  url: string;
  /** HTTP status from the receiver, or null when it couldn't be reached. */
  status: number | null;
  error: string | null;
  deliveredAt: string;
}

/**
 * Sends events to registered webhook URLs after `delayMs` (sandbox takes 10–75 s; spike Q6).
 * No automatic retries: tests call `resend` the way the dashboard calls PayPal's resend.
 */
export class WebhookDispatcher {
  readonly deliveries: WebhookDelivery[] = [];
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly clock: () => Date,
    private readonly delayMs: number,
  ) {}

  dispatch(event: WebhookEvent, webhooks: WebhookRecord[]): void {
    for (const webhook of webhooks) {
      if (!webhook.eventTypes.includes("*") && !webhook.eventTypes.includes(event.event_type)) continue;
      const delivery = this.later(event, webhook).finally(() => this.pending.delete(delivery));
      this.pending.add(delivery);
    }
  }

  /** Resolves once every queued delivery has been attempted. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async later(event: WebhookEvent, webhook: WebhookRecord): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const body = JSON.stringify(event);
    const base = {
      eventId: event.id,
      eventType: event.event_type,
      webhookId: webhook.id,
      url: webhook.url,
      deliveredAt: paypalTime(this.clock()),
    };
    try {
      const res = await fetch(webhook.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...sign(webhook.id, body, this.clock()) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      // Drain the body so the connection is released.
      await res.arrayBuffer();
      this.deliveries.push({ ...base, status: res.status, error: null });
    } catch (err) {
      // A receiver that is down is a normal test scenario, not a mock failure: record it.
      this.deliveries.push({
        ...base,
        status: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
