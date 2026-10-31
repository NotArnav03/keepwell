import type { NotificationRequest } from "./notifications.js";

// M5 → everyone (CONTRACTS.md §5). Inserts an outbox row inside the caller's transaction;
// the notify.dispatch job sends it later. Returns the notification id.
export interface Notifier<Tx = unknown> {
  enqueue(n: NotificationRequest, tx?: Tx): Promise<string>;
}
