import type { JudgePool, PoolLease, PoolReturn, PoolState } from "../platform/interfaces.js";
import { uuidv7 } from "./uuidv7.js";

/**
 * In-memory JudgePool for Judge Mode's tests: lends what `add` put in, and takes it back as asked.
 * Like the real pool, a lease is (entry, leasedUntil), and a returned entry goes to the back of the
 * line. Unlike it, there is no rest after a return, so a test can lease the same entry again at once.
 */
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
      const ms = this.clock().getTime() + (input.minutes ?? 30) * 60_000;
      entry.until = new Date(Math.floor(ms / 1000) * 1000).toISOString();
      const { subscriptionId, paypalSubscriptionId, until } = entry;
      return Promise.resolve({ poolEntryId, subscriptionId, paypalSubscriptionId, leasedUntil: until });
    }
    return Promise.resolve(null);
  }

  holds(merchantId: string, poolEntryId: string, leasedUntil: string): Promise<boolean> {
    const entry = this.entries.get(poolEntryId);
    return Promise.resolve(
      entry !== undefined &&
        entry.merchantId === merchantId &&
        entry.state === "leased" &&
        entry.until !== null &&
        Date.parse(entry.until) === Date.parse(leasedUntil) &&
        Date.parse(leasedUntil) > this.clock().getTime(),
    );
  }

  async release(merchantId: string, poolEntryId: string, leasedUntil?: string): Promise<PoolReturn | null> {
    const entry = this.entries.get(poolEntryId);
    if (!entry || entry.merchantId !== merchantId) throw new Error(`No pool entry ${poolEntryId}`);
    if (leasedUntil !== undefined && !(await this.holds(merchantId, poolEntryId, leasedUntil))) return null;
    entry.state = this.nextReturn;
    entry.until = null;
    // To the back of the line, as the real pool lends the longest-unused entry first.
    this.entries.delete(poolEntryId);
    this.entries.set(poolEntryId, entry);
    return this.nextReturn;
  }

  counts(merchantId: string): Promise<Record<PoolState, number>> {
    const counts: Record<PoolState, number> = { available: 0, leased: 0, restoring: 0, consumed: 0 };
    for (const entry of this.entries.values()) if (entry.merchantId === merchantId) counts[entry.state]++;
    return Promise.resolve(counts);
  }
}
