import { uuidv7 } from "@keepwell/contracts/fakes";
import type {
  JobQueue,
  SendOptions,
  SubscriptionDirectory,
  WinbackCase,
  WinbackPolicy,
  WinbackRepo,
  WinbackReply,
  WinbackStore,
  WinbackSubscriptionView,
} from "./ports.js";

// In-memory ports for tests and offline development. Like the Postgres store, a case is visible
// only to its own merchant.

export class MemoryWinbackStore implements WinbackStore {
  readonly cases: WinbackCase[] = [];
  readonly replies: WinbackReply[] = [];

  withMerchant<T>(merchantId: string, fn: (repo: WinbackRepo, tx: unknown) => Promise<T>): Promise<T> {
    const mine = <R>(rows: R[], pick: (r: R) => string) => rows.filter((r) => pick(r) === merchantId);
    const repo: WinbackRepo = {
      openCase: (input) => {
        const existing = mine(this.cases, (c) => c.merchantId).find(
          (c) => c.subscriptionId === input.subscriptionId,
        );
        if (existing) return Promise.resolve({ case: existing, created: false });
        const created: WinbackCase = {
          id: uuidv7(),
          ...input,
          state: "pending",
          skipReason: null,
          sentAt: null,
          notificationId: null,
        };
        this.cases.push(created);
        return Promise.resolve({ case: created, created: true });
      },
      getCase: (id) =>
        Promise.resolve(mine(this.cases, (c) => c.merchantId).find((c) => c.id === id) ?? null),
      getCaseBySubscription: (sid) =>
        Promise.resolve(mine(this.cases, (c) => c.merchantId).find((c) => c.subscriptionId === sid) ?? null),
      transition: (id, from, to) => {
        const row = mine(this.cases, (c) => c.merchantId).find((c) => c.id === id);
        if (!row || row.state !== from) return Promise.resolve(false);
        row.state = to.state;
        if (to.skipReason !== undefined) row.skipReason = to.skipReason;
        if (to.sentAt !== undefined) row.sentAt = to.sentAt;
        if (to.notificationId !== undefined) row.notificationId = to.notificationId;
        return Promise.resolve(true);
      },
      insertReply: (input) => {
        const reply = { id: uuidv7(), ...input };
        this.replies.push(reply);
        return Promise.resolve(reply);
      },
    };
    return fn(repo, undefined);
  }

  locate(subscriptionId: string) {
    const row = this.cases.find((c) => c.subscriptionId === subscriptionId);
    return Promise.resolve(row ? { merchantId: row.merchantId } : null);
  }

  listDue(now: Date, limit: number) {
    return Promise.resolve(
      this.cases
        .filter((c) => c.state === "pending" && c.dueAt.getTime() <= now.getTime())
        .slice(0, limit)
        .map((c) => ({ merchantId: c.merchantId, subscriptionId: c.subscriptionId })),
    );
  }
}

export class MemoryDirectory implements SubscriptionDirectory {
  readonly views = new Map<string, WinbackSubscriptionView>();
  get(_merchantId: string, subscriptionId: string) {
    return Promise.resolve(this.views.get(subscriptionId) ?? null);
  }
}

export class MemoryPolicy implements WinbackPolicy {
  url: string | null = null;
  resubscribeUrl() {
    return Promise.resolve(this.url);
  }
}

export interface SentJob {
  name: string;
  payload: unknown;
  options: SendOptions;
}

/** Records jobs; a repeated singletonKey is dropped, like pg-boss. */
export class MemoryJobs implements JobQueue {
  readonly sent: SentJob[] = [];
  send(name: string, payload: unknown, options: SendOptions) {
    if (!this.sent.some((j) => j.name === name && j.options.singletonKey === options.singletonKey)) {
      this.sent.push({ name, payload, options });
    }
    return Promise.resolve();
  }
}
