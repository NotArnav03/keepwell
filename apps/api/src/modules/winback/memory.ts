import type { Tx } from "@keepwell/db";
import { uuidv7 } from "@keepwell/contracts/fakes";
import type {
  BatchSubscription,
  JobQueue,
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
  /** Synced snapshot statuses. Scoped by merchant so a batch cannot see another tenant. */
  readonly subscriptions: {
    merchantId: string;
    subscriptionId: string;
    status: WinbackSubscriptionView["status"];
  }[] = [];

  withMerchant<T>(merchantId: string, fn: (repo: WinbackRepo, tx: Tx | undefined) => Promise<T>): Promise<T> {
    const mine = <R>(rows: R[], pick: (r: R) => string) => rows.filter((r) => pick(r) === merchantId);
    const openCase: WinbackRepo["openCase"] = (input) => {
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
    };
    const repo: WinbackRepo = {
      openCase,
      openCases: (inputs) => Promise.all(inputs.map((input) => openCase(input))),
      inspect: (subscriptionIds) => {
        const wanted = new Set(subscriptionIds);
        const cases = new Map(mine(this.cases, (c) => c.merchantId).map((c) => [c.subscriptionId, c]));
        const seen = new Set<string>();
        const found: BatchSubscription[] = [];
        for (const row of this.subscriptions) {
          if (
            row.merchantId !== merchantId ||
            !wanted.has(row.subscriptionId) ||
            seen.has(row.subscriptionId)
          ) {
            continue;
          }
          seen.add(row.subscriptionId);
          found.push({
            subscriptionId: row.subscriptionId,
            status: row.status,
            winback: cases.get(row.subscriptionId) ?? null,
          });
        }
        return Promise.resolve(found);
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
  options: { startAfter?: Date };
}

/** Records jobs. Like the real queue, a repeat of the same name and payload is dropped. */
export class MemoryJobs implements JobQueue {
  readonly sent: SentJob[] = [];
  send(name: string, payload: unknown, options: { startAfter?: Date } = {}) {
    const key = JSON.stringify([name, payload]);
    if (this.sent.some((j) => JSON.stringify([j.name, j.payload]) === key)) return Promise.resolve(null);
    this.sent.push({ name, payload, options: options.startAfter ? { startAfter: options.startAfter } : {} });
    return Promise.resolve("job-id");
  }
}
