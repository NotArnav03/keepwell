// A fixed-window limiter for the public identity routes. In memory on purpose: one API instance
// serves the demo, and a restart only forgives a window. Keys are caller-chosen (an IP, an email
// hash, a portal session), so one limiter can't be skipped by changing the other.

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  clock?: () => Date;
  /** Expired windows are swept once the table grows past this, so memory stays bounded. */
  maxKeys?: number;
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export class RateLimiter {
  private readonly windows = new Map<string, { resetsAt: number; count: number }>();
  private readonly clock: () => Date;
  private readonly maxKeys: number;

  constructor(private readonly options: RateLimiterOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  /** Whether `key` has room left, without counting anything (for limits that count only successes). */
  check(key: string): RateLimitResult {
    const now = this.clock().getTime();
    const window = this.windows.get(key);
    if (window === undefined || window.resetsAt <= now || window.count < this.options.limit) {
      return { allowed: true };
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.resetsAt - now) / 1000)) };
  }

  /** Counts one attempt for `key`. Refused attempts don't extend the window. */
  hit(key: string): RateLimitResult {
    const now = this.clock().getTime();
    let window = this.windows.get(key);
    if (window === undefined || window.resetsAt <= now) {
      if (this.windows.size >= this.maxKeys) this.sweep(now);
      window = { resetsAt: now + this.options.windowMs, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.options.limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.resetsAt - now) / 1000)) };
    }
    window.count += 1;
    return { allowed: true };
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) if (window.resetsAt <= now) this.windows.delete(key);
  }
}
