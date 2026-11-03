import type { JudgePool, PoolLease, PoolReturn, PoolState } from "../platform/interfaces.js";
import { uuidv7 } from "./uuidv7.js";

/** In-memory JudgePool for Judge Mode's tests: lends what `add` put in, and takes it back as asked. */
export class FakeJudgePool implements JudgePool {
  private readonly entries = new Map<
    string,
    {
      merchantId: string;
      subscriptionId: string;
      paypalSubscriptionId: string;
      state: PoolState;
      until: string | null;
    }
  >();
  /** What the next `release` reports; the real pool decides from PayPal. */
  nextReturn: PoolReturn = "available";

  constructor(private readonly clock: () => Date = () => new Date()) {}

  add(merchantId: string, subscriptionId: string, paypalSubscriptionId: string): string {
    const id = uuidv7();
    this.entries.set(id, {
      merchantId,
      subscriptionId,
      paypalSubscriptionId,
      state: "available",
      until: null,
    });
    return id;
  }

  lease(merchantId: string, input: { minutes?: number } = {}): Promise<PoolLease | null> {
    for (const [poolEntryId, entry] of this.entries) {
      if (entry.merchantId !== merchantId || entry.state !== "available") continue;
      entry.state = "leased";
      entry.until = new Date(this.clock().getTime() + (input.minutes ?? 30) * 60_000).toISOString();
      const { subscriptionId, paypalSubscriptionId, until } = entry;
      return Promise.resolve({ poolEntryId, subscriptionId, paypalSubscriptionId, leasedUntil: until });
    }
    return Promise.resolve(null);
  }

  release(merchantId: string, poolEntryId: string): Promise<PoolReturn> {
    const entry = this.entries.get(poolEntryId);
    if (!entry || entry.merchantId !== merchantId)
      return Promise.reject(new Error(`No pool entry ${poolEntryId}`));
    entry.state = this.nextReturn;
    entry.until = null;
    return Promise.resolve(this.nextReturn);
  }

  counts(merchantId: string): Promise<Record<PoolState, number>> {
    const counts: Record<PoolState, number> = { available: 0, leased: 0, restoring: 0, consumed: 0 };
    for (const entry of this.entries.values()) if (entry.merchantId === merchantId) counts[entry.state]++;
    return Promise.resolve(counts);
  }
}
