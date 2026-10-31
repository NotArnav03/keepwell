import { z } from "zod";
import {
  PayPalGatewayError,
  PayPalSubscription,
  type ListSubscriptionsQuery,
  type Page,
  type PayPalErrorKind,
  type PayPalGateway,
  type BillingInterval,
  type Money,
} from "@keepwell/contracts";
import type { CredentialSource } from "./credentials.js";
import { toPayPalMoney } from "./money.js";
import { TokenBuckets, type RateLimit } from "./rate-limit.js";

// The only code that calls PayPal (ARCHITECTURE.md §6.1, apps/api/CLAUDE.md). Other modules get the
// read-only `PayPalGateway` view; the mutation methods are for the action engine alone.
//
// - OAuth client-credentials token per merchant, cached and refreshed 5 minutes before expiry;
//   on a 401, one refresh and one retry.
// - 10 s timeout per attempt. Network errors, 429 and 5xx retry with exponential backoff and
//   jitter, 4 attempts in all; longer waits are the action engine's (RETRY_WAIT).
// - Every response's PayPal-Debug-Id is logged and returned (results and errors alike).
// - A token bucket per merchant.

const LIVE_HOSTS = new Set(["api.paypal.com", "api-m.paypal.com"]);
const REFRESH_EARLY_MS = 5 * 60_000;

export interface PayPalClientLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface PayPalClientOptions {
  /** https://api-m.sandbox.paypal.com, or paypal-mock's URL. Live PayPal is refused (CLAUDE.md §1). */
  baseUrl: string;
  credentials: CredentialSource;
  log: PayPalClientLogger;
  fetch?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
  /** Waits between attempts; its length + 1 is the attempt count. */
  retryDelaysMs?: readonly number[];
  rateLimit?: RateLimit;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** What a mutation returns: PayPal answered 2xx. The debug id goes on the Action. */
export interface MutationResult {
  debugId: string | null;
}

export interface Transaction {
  id: string;
  status: string;
  grossAmount: { currency_code: string; value: string };
  time: string;
}

interface Request {
  method: "GET" | "POST" | "PATCH";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** A body already serialised, sent byte for byte (webhook verification). */
  rawBody?: string;
  /** PayPal-Request-Id, on the endpoints that honour it (create plan, capture, refund). */
  requestId?: string;
}

const ErrorBody = z.looseObject({
  name: z.string().optional(),
  message: z.string().optional(),
  details: z.array(z.looseObject({ issue: z.string().optional() })).optional(),
});

const SubscriptionList = z.looseObject({
  subscriptions: z.array(PayPalSubscription).default([]),
  total_items: z.number().int().optional(),
  total_pages: z.number().int().optional(),
});

const TransactionList = z.looseObject({
  transactions: z
    .array(
      z.looseObject({
        id: z.string(),
        status: z.string(),
        amount_with_breakdown: z.looseObject({
          gross_amount: z.looseObject({ currency_code: z.string(), value: z.string() }),
        }),
        time: z.string(),
      }),
    )
    .default([]),
});

/** The parts of a billing plan the snapshot needs. */
export const PayPalPlan = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  product_id: z.string().optional(),
  status: z.string(),
  billing_cycles: z.array(
    z.looseObject({
      tenure_type: z.string(),
      sequence: z.number().int(),
      frequency: z.looseObject({
        interval_unit: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]),
        interval_count: z.number().int().min(1),
      }),
      pricing_scheme: z
        .looseObject({ fixed_price: z.looseObject({ currency_code: z.string(), value: z.string() }) })
        .optional(),
    }),
  ),
});
export type PayPalPlan = z.infer<typeof PayPalPlan>;

const ReviseResponse = z.looseObject({
  links: z.array(z.looseObject({ href: z.string(), rel: z.string() })),
});
const IdBody = z.looseObject({ id: z.string().min(1) });

const VerifyResponse = z.looseObject({ verification_status: z.string() });

const TokenResponse = z.looseObject({ access_token: z.string().min(1), expires_in: z.number().int().min(1) });

export class PayPalClient implements PayPalGateway {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly buckets: TokenBuckets;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  /** One token request per merchant at a time; concurrent callers share it. */
  private readonly pendingTokens = new Map<string, Promise<string>>();

  constructor(private readonly options: PayPalClientOptions) {
    const url = new URL(options.baseUrl);
    if (LIVE_HOSTS.has(url.hostname))
      throw new Error("Live PayPal is not allowed: sandbox only (CLAUDE.md §1)");
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.clock = options.clock ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retryDelaysMs = options.retryDelaysMs ?? [500, 1000, 2000];
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.buckets = new TokenBuckets(
      options.rateLimit ?? { perSecond: 10, burst: 20 },
      this.clock,
      this.sleep,
    );
  }

  /** True when PayPal issues (or has issued) this merchant a token: /readyz and /status use it. */
  async checkAuth(merchantId: string): Promise<boolean> {
    try {
      await this.token(merchantId);
      return true;
    } catch {
      // The reason is already in PayPalGatewayError's log line; here only up or down matters.
      return false;
    }
  }

  // ---------- reads: the PayPalGateway contract ----------

  /** With `fields=plan`, so a discount's fixed_price override is visible. */
  async getSubscription(merchantId: string, paypalSubscriptionId: string): Promise<PayPalSubscription> {
    const { body } = await this.request(merchantId, {
      method: "GET",
      path: `/v1/billing/subscriptions/${encodeURIComponent(paypalSubscriptionId)}`,
      query: { fields: "plan" },
    });
    return PayPalSubscription.parse(body);
  }

  async listSubscriptions(
    merchantId: string,
    query: ListSubscriptionsQuery,
  ): Promise<Page<PayPalSubscription>> {
    const page = query.page ?? 1;
    const { body } = await this.request(merchantId, {
      method: "GET",
      path: "/v1/billing/subscriptions",
      query: {
        status_updated_after: query.statusUpdatedAfter,
        plan_ids: query.planIds?.join(","),
        page_size: "20",
        page: String(page),
      },
    });
    const list = SubscriptionList.parse(body);
    return {
      items: list.subscriptions,
      page,
      totalItems: list.total_items ?? null,
      totalPages: list.total_pages ?? null,
    };
  }

  async listTransactions(
    merchantId: string,
    paypalSubscriptionId: string,
    range: { start: string; end: string },
  ): Promise<Transaction[]> {
    const { body } = await this.request(merchantId, {
      method: "GET",
      path: `/v1/billing/subscriptions/${encodeURIComponent(paypalSubscriptionId)}/transactions`,
      query: { start_time: range.start, end_time: range.end },
    });
    return TransactionList.parse(body).transactions.map((t) => ({
      id: t.id,
      status: t.status,
      grossAmount: t.amount_with_breakdown.gross_amount,
      time: t.time,
    }));
  }

  /** A billing plan: name, price and interval for the subscription snapshot. */
  async getPlan(merchantId: string, paypalPlanId: string): Promise<PayPalPlan> {
    const { body } = await this.request(merchantId, {
      method: "GET",
      path: `/v1/billing/plans/${encodeURIComponent(paypalPlanId)}`,
    });
    return PayPalPlan.parse(body);
  }

  /**
   * POST /v1/notifications/verify-webhook-signature (ARCHITECTURE.md §6.2). PayPal checks the
   * signature over the exact bytes it sent, so the received body goes in verbatim: the request JSON
   * is built as a string around it, never by re-serialising a parsed copy.
   */
  async verifyWebhookSignature(
    merchantId: string,
    input: { webhookId: string; headers: Record<string, string | undefined>; rawBody: string },
  ): Promise<boolean> {
    const header = (name: string) => JSON.stringify(input.headers[name] ?? "");
    const rawBody =
      `{"auth_algo":${header("paypal-auth-algo")},"cert_url":${header("paypal-cert-url")},` +
      `"transmission_id":${header("paypal-transmission-id")},"transmission_sig":${header("paypal-transmission-sig")},` +
      `"transmission_time":${header("paypal-transmission-time")},"webhook_id":${JSON.stringify(input.webhookId)},` +
      `"webhook_event":${input.rawBody}}`;
    const { body } = await this.request(merchantId, {
      method: "POST",
      path: "/v1/notifications/verify-webhook-signature",
      rawBody,
    });
    return VerifyResponse.parse(body).verification_status === "SUCCESS";
  }

  // ---------- mutations: only the action engine calls these ----------

  suspend(merchantId: string, paypalSubscriptionId: string, reason: string): Promise<MutationResult> {
    return this.statusChange(merchantId, paypalSubscriptionId, "suspend", reason);
  }

  activate(merchantId: string, paypalSubscriptionId: string, reason: string): Promise<MutationResult> {
    return this.statusChange(merchantId, paypalSubscriptionId, "activate", reason);
  }

  cancel(merchantId: string, paypalSubscriptionId: string, reason: string): Promise<MutationResult> {
    return this.statusChange(merchantId, paypalSubscriptionId, "cancel", reason);
  }

  private async statusChange(
    merchantId: string,
    paypalSubscriptionId: string,
    action: "suspend" | "activate" | "cancel",
    reason: string,
  ): Promise<MutationResult> {
    const { debugId } = await this.request(merchantId, {
      method: "POST",
      path: `/v1/billing/subscriptions/${encodeURIComponent(paypalSubscriptionId)}/${action}`,
      body: { reason },
    });
    return { debugId };
  }

  /**
   * Starts a plan change. Nothing changes until the buyer approves on the returned link; PayPal
   * then sends them to returnUrl (or cancelUrl). Re-running only makes a fresh link (§6.1).
   */
  async revise(
    merchantId: string,
    paypalSubscriptionId: string,
    input: { planId: string; returnUrl: string; cancelUrl: string },
  ): Promise<MutationResult & { approveUrl: string }> {
    const { body, debugId } = await this.request(merchantId, {
      method: "POST",
      path: `/v1/billing/subscriptions/${encodeURIComponent(paypalSubscriptionId)}/revise`,
      body: {
        plan_id: input.planId,
        application_context: {
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
          user_action: "CONTINUE",
        },
      },
    });
    const approve = ReviseResponse.parse(body).links.find((l) => l.rel === "approve");
    if (!approve)
      throw new PayPalGatewayError("invalid_request", "PayPal's revise answer had no approve link");
    return { debugId, approveUrl: approve.href };
  }

  /** Sets the next cycles' price (a discount), or puts the plan's price back. */
  async patchPrice(
    merchantId: string,
    paypalSubscriptionId: string,
    fixedPrice: Money,
  ): Promise<MutationResult> {
    const { debugId } = await this.request(merchantId, {
      method: "PATCH",
      path: `/v1/billing/subscriptions/${encodeURIComponent(paypalSubscriptionId)}`,
      body: [
        {
          op: "replace",
          path: "/plan/billing_cycles/@sequence==1/pricing_scheme/fixed_price",
          value: toPayPalMoney(fixedPrice),
        },
      ],
    });
    return { debugId };
  }

  /**
   * Refunds part of a subscription payment. Spike Q1: the transactions' ids are v2 capture ids, and a
   * repeated PayPal-Request-Id answers 200 with the first refund, so a retry can't refund twice.
   */
  async refund(
    merchantId: string,
    input: { transactionId: string; amount: Money; requestId: string },
  ): Promise<MutationResult & { refundId: string }> {
    const { body, debugId } = await this.request(merchantId, {
      method: "POST",
      path: `/v2/payments/captures/${encodeURIComponent(input.transactionId)}/refund`,
      body: { amount: toPayPalMoney(input.amount) },
      requestId: input.requestId,
    });
    return { debugId, refundId: IdBody.parse(body).id };
  }

  /** Collects the outstanding balance now; PayPal-Request-Id makes it safe to retry. */
  async capture(
    merchantId: string,
    paypalSubscriptionId: string,
    input: { amount: Money; requestId: string },
  ): Promise<MutationResult & { transactionId: string }> {
    const { body, debugId } = await this.request(merchantId, {
      method: "POST",
      path: `/v1/billing/subscriptions/${encodeURIComponent(paypalSubscriptionId)}/capture`,
      body: {
        note: "Outstanding balance",
        capture_type: "OUTSTANDING_BALANCE",
        amount: toPayPalMoney(input.amount),
      },
      requestId: input.requestId,
    });
    return { debugId, transactionId: IdBody.parse(body).id };
  }

  /** A new plan on an existing product (insight-to-action). PayPal-Request-Id makes it safe to retry. */
  async createPlan(
    merchantId: string,
    input: { productId: string; name: string; price: Money; interval: BillingInterval; requestId: string },
  ): Promise<MutationResult & { planId: string }> {
    const { body, debugId } = await this.request(merchantId, {
      method: "POST",
      path: "/v1/billing/plans",
      body: {
        product_id: input.productId,
        name: input.name,
        status: "ACTIVE",
        billing_cycles: [
          {
            frequency: { interval_unit: input.interval.unit, interval_count: input.interval.count },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: { fixed_price: toPayPalMoney(input.price) },
          },
        ],
        payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
      },
      requestId: input.requestId,
    });
    return { debugId, planId: IdBody.parse(body).id };
  }

  // ---------- transport ----------

  private async request(
    merchantId: string,
    req: Request,
  ): Promise<{ body: unknown; debugId: string | null }> {
    await this.buckets.take(merchantId);
    const url = new URL(`${this.baseUrl}${req.path}`);
    for (const [key, value] of Object.entries(req.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, value);
    const log = { merchantId, method: req.method, path: req.path };

    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.token(merchantId);
      const started = this.clock();
      let res: Response;
      try {
        res = await this.fetch(url, {
          method: req.method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            prefer: "return=representation",
            ...(req.requestId && { "paypal-request-id": req.requestId }),
          },
          ...(req.rawBody !== undefined
            ? { body: req.rawBody }
            : req.body !== undefined && { body: JSON.stringify(req.body) }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // Network error or timeout. PayPal may or may not have acted: callers that change state
        // read before retrying (the action engine does).
        const error = new PayPalGatewayError("unavailable", `PayPal unreachable: ${message(err)}`);
        if (await this.backoff(attempt, { ...log, error: error.message })) continue;
        throw error;
      }

      const debugId = res.headers.get("paypal-debug-id");
      const ms = this.clock() - started;
      this.options.log.info({ ...log, status: res.status, debugId, attempt, ms }, "paypal call");
      const text = await res.text();
      const body: unknown = text ? safeJson(text) : null;

      if (res.ok) return { body, debugId };
      if (res.status === 401 && !refreshed) {
        // The token was revoked or expired early: refresh once and retry, without using an attempt.
        refreshed = true;
        this.tokens.delete(merchantId);
        attempt--;
        continue;
      }
      const error = toError(res.status, body, debugId);
      if (error.retryable && (await this.backoff(attempt, { ...log, status: res.status, debugId }))) continue;
      throw error;
    }
  }

  /** Waits before the next attempt, or returns false when attempts are used up. */
  private async backoff(attempt: number, log: object): Promise<boolean> {
    const base = this.retryDelaysMs[attempt - 1];
    if (base === undefined) return false;
    // ±25% jitter, so many retries don't arrive at PayPal in lockstep.
    const delay = Math.round(base * (0.75 + this.random() * 0.5));
    this.options.log.warn({ ...log, attempt, retryInMs: delay }, "paypal call failed, retrying");
    await this.sleep(delay);
    return true;
  }

  private token(merchantId: string): Promise<string> {
    const cached = this.tokens.get(merchantId);
    if (cached && cached.expiresAt - REFRESH_EARLY_MS > this.clock()) return Promise.resolve(cached.token);
    const pending = this.pendingTokens.get(merchantId);
    if (pending) return pending;
    const fresh = this.fetchToken(merchantId).finally(() => this.pendingTokens.delete(merchantId));
    this.pendingTokens.set(merchantId, fresh);
    return fresh;
  }

  private async fetchToken(merchantId: string): Promise<string> {
    const { clientId, clientSecret } = await this.options.credentials.forMerchant(merchantId);
    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new PayPalGatewayError("unavailable", `PayPal OAuth unreachable: ${message(err)}`);
    }
    const debugId = res.headers.get("paypal-debug-id");
    const body: unknown = safeJson(await res.text());
    if (!res.ok) {
      // Wrong credentials are a 401 here; refreshing again won't help.
      throw new PayPalGatewayError(
        res.status === 401 ? "unauthorized" : kindOf(res.status),
        "PayPal OAuth failed",
        {
          status: res.status,
          issue: null,
          debugId,
        },
      );
    }
    const { access_token, expires_in } = TokenResponse.parse(body);
    this.tokens.set(merchantId, { token: access_token, expiresAt: this.clock() + expires_in * 1000 });
    return access_token;
  }
}

function kindOf(status: number): PayPalErrorKind {
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status === 422) return "unprocessable";
  if (status >= 500) return "unavailable";
  return "invalid_request";
}

function toError(status: number, body: unknown, debugId: string | null): PayPalGatewayError {
  const parsed = ErrorBody.safeParse(body);
  const issue = parsed.success ? (parsed.data.details?.[0]?.issue ?? null) : null;
  const name = parsed.success ? (parsed.data.name ?? `HTTP ${status}`) : `HTTP ${status}`;
  return new PayPalGatewayError(kindOf(status), issue ? `${name}: ${issue}` : name, {
    status,
    issue,
    debugId,
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A proxy's HTML error page, say. The status code still says what happened.
    return { message: text.slice(0, 200) };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
