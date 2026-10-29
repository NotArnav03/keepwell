import { randomBytes } from "node:crypto";
import { Notification, NotificationRequest } from "../growth/notifications.js";
import type { Notifier } from "../growth/notifier.js";

function uuidv7(now: number): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  // Version 7 in the high nibble of byte 6, RFC 9562 variant in the top bits of byte 8.
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * In-memory Notifier for tests and offline development. It validates every request
 * against the contract, so a test that enqueues a bad payload fails loudly.
 * It does not apply frequency caps: that is the real dispatcher's job.
 */
export class FakeNotifier implements Notifier {
  readonly queued: Notification[] = [];

  constructor(private readonly clock: () => Date = () => new Date()) {}

  enqueue(n: NotificationRequest): Promise<string> {
    // The executor turns a validation throw into a rejection, like the real async Notifier.
    return new Promise((resolve) => resolve(this.record(n)));
  }

  private record(n: NotificationRequest): string {
    const request = NotificationRequest.parse(n);
    const now = this.clock();
    const notification = Notification.parse({
      id: uuidv7(now.getTime()),
      merchantId: request.merchantId,
      subscriptionId: request.subscriptionId,
      to: request.to,
      channel: "email",
      content: request.content,
      status: "queued",
      suppressedBecause: null,
      dueAt: request.dueAt ?? now.toISOString(),
      sentAt: null,
      attempts: 0,
      providerId: null,
      lastError: null,
      simulated: request.simulated,
      createdAt: now.toISOString(),
    });
    this.queued.push(notification);
    return notification.id;
  }

  byTemplate(template: Notification["content"]["template"]): Notification[] {
    return this.queued.filter((n) => n.content.template === template);
  }

  clear(): void {
    this.queued.length = 0;
  }
}
