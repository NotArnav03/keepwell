// Failure injection: make the next matching PayPal call fail, hang or fail after applying, so the
// gateway's retries and the action engine's read-before-retry can be tested (ARCHITECTURE.md §6.1).

export interface FailureRule {
  /** e.g. "POST". Any method when absent. */
  method?: string;
  /** Matched against the request path: a substring, or a regular expression. */
  path?: string | RegExp;
  /** How many matching requests it affects. Default 1. */
  times?: number;
  /** Respond with this HTTP status (and PayPal error body) instead of the real answer. */
  status?: number;
  /** PayPal `details[].issue` for the error body, e.g. "SUBSCRIPTION_STATUS_INVALID". */
  issue?: string;
  /**
   * Apply the change, then still answer with `status`: PayPal did it but the response was lost.
   * This is the case read-before-retry exists for.
   */
  apply?: boolean;
  /** Wait this long before answering, e.g. longer than the gateway's 10 s timeout. */
  delayMs?: number;
}

export interface ArmedFailure {
  status: number | null;
  issue: string | null;
  apply: boolean;
  delayMs: number;
}

export class FailureInjector {
  private rules: (FailureRule & { left: number })[] = [];

  add(rule: FailureRule): void {
    if (rule.status === undefined && rule.delayMs === undefined) {
      throw new Error("A failure rule needs a status, a delayMs, or both");
    }
    this.rules.push({ ...rule, left: rule.times ?? 1 });
  }

  clear(): void {
    this.rules = [];
  }

  /** The first rule matching this request, used up by one. */
  take(method: string, path: string): ArmedFailure | null {
    const rule = this.rules.find(
      (r) =>
        r.left > 0 &&
        (r.method === undefined || r.method.toUpperCase() === method) &&
        (r.path === undefined || (typeof r.path === "string" ? path.includes(r.path) : r.path.test(path))),
    );
    if (!rule) return null;
    rule.left--;
    this.rules = this.rules.filter((r) => r.left > 0);
    return {
      status: rule.status ?? null,
      issue: rule.issue ?? null,
      apply: rule.apply ?? false,
      delayMs: rule.delayMs ?? 0,
    };
  }
}
