// Per-IP rate limits for the session routes that can cost money (#26, ARCHITECTURE.md §9 "LLM cost
// runaway", §10). Fixed one-minute windows in memory: the API runs as one Render instance, and a
// restart resetting the counts is harmless next to the daily LLM budget guard behind it.
// Cancel is never limited: it doesn't touch the LLM, and it must always work.

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastPrune = 0;

  constructor(
    readonly rule: RateLimitRule,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one request. Returns 0 if it's allowed, else the seconds until the window resets. */
  hit(key: string): number {
    const t = this.now();
    this.prune(t);
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.rule.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      return 0;
    }
    w.count++;
    if (w.count <= this.rule.limit) return 0;
    return Math.max(1, Math.ceil((w.start + this.rule.windowMs - t) / 1000));
  }

  /** Drops finished windows now and then, so a flood of distinct IPs can't grow the map forever. */
  private prune(t: number): void {
    if (t - this.lastPrune < this.rule.windowMs) return;
    this.lastPrune = t;
    for (const [key, w] of this.windows) if (t - w.start >= this.rule.windowMs) this.windows.delete(key);
  }
}

export interface SessionRateLimits {
  /** POST /sessions: starting a conversation. */
  create: FixedWindowLimiter;
  /** POST /sessions/:id/messages and /reason: the calls that reach the agent. */
  talk: FixedWindowLimiter;
}

const MINUTE = 60_000;

/**
 * Generous for people (one session is at most 3 messages), tight for a script. A shared office or
 * mobile-carrier IP still gets 10 new conversations a minute.
 */
export function defaultSessionRateLimits(now?: () => number): SessionRateLimits {
  return {
    create: new FixedWindowLimiter({ limit: 10, windowMs: MINUTE }, now),
    talk: new FixedWindowLimiter({ limit: 30, windowMs: MINUTE }, now),
  };
}
