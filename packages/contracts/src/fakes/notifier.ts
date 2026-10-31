import { Notification, NotificationRequest } from "../growth/notifications.js";
import type { Notifier } from "../growth/notifier.js";
import { uuidv7 } from "./uuidv7.js";

/**
 * In-memory Notifier for tests and offline development. It validates every request
 * against the contract, so a test that enqueues a bad payload fails loudly.
 * It does not apply frequency caps: that is the real dispatcher's job.
 */
export class FakeNotifier implements Notifier {
  readonly queued: Notification[] = [];

  constructor(private readonly clock: () => Date = () => new Date()) {}

  enqueue(n: NotificationRequest): Promise<string> {
    // Wrapped so a validation throw becomes a rejection, like the real async Notifier.
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
