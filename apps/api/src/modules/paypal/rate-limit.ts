// A token bucket per merchant (ARCHITECTURE.md §6.1), so the reconciler's sweeps can't use up
// PayPal's rate limit and starve a subscriber's live Action.

export interface RateLimit {
  /** Sustained requests per second. */
  perSecond: number;
  /** How many can go at once after a quiet spell. */
  burst: number;
}

export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Resolves when `key` may make one more request. */
  async take(key: string): Promise<void> {
    for (;;) {
      const now = this.now();
      const bucket = this.buckets.get(key) ?? { tokens: this.limit.burst, at: now };
      bucket.tokens = Math.min(
        this.limit.burst,
        bucket.tokens + ((now - bucket.at) / 1000) * this.limit.perSecond,
      );
      bucket.at = now;
      this.buckets.set(key, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      await this.sleep(((1 - bucket.tokens) / this.limit.perSecond) * 1000);
    }
  }
}
