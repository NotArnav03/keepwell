import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PayPalGatewayError } from "@keepwell/contracts";
import { PANTRY_PLAN } from "@keepwell/contracts/fakes";
import {
  createPayPalMock,
  fixtureSubscriptionId,
  PANTRY_PLAN_CREDENTIALS,
  type PayPalMock,
} from "@keepwell/paypal-mock";
import { PayPalClient } from "./client.js";
import { singleAppCredentials } from "./credentials.js";
import { toMoney } from "./money.js";
import { TokenBuckets } from "./rate-limit.js";

// The gateway against paypal-mock over real HTTP, failures injected the way PayPal fails.

const M = PANTRY_PLAN.merchantId;
const MAYA = fixtureSubscriptionId("maya");
const ANA = fixtureSubscriptionId("ana");

let mock: PayPalMock;
let baseUrl: string;
let logs: { level: string; obj: Record<string, unknown>; msg: string }[];
let oauthCalls: number;

function client(overrides: Partial<ConstructorParameters<typeof PayPalClient>[0]> = {}) {
  return new PayPalClient({
    baseUrl,
    credentials: singleAppCredentials(PANTRY_PLAN_CREDENTIALS),
    log: {
      info: (obj, msg) => logs.push({ level: "info", obj: obj as Record<string, unknown>, msg }),
      warn: (obj, msg) => logs.push({ level: "warn", obj: obj as Record<string, unknown>, msg }),
    },
    // Count token requests, and don't really wait between retries.
    fetch: (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/oauth2/token")) oauthCalls++;
      return fetch(input, init);
    },
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}

async function failure(run: () => Promise<unknown>): Promise<PayPalGatewayError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof PayPalGatewayError) return err;
    throw err;
  }
  throw new Error("expected a PayPalGatewayError");
}

beforeEach(async () => {
  mock = createPayPalMock();
  baseUrl = await mock.listen();
  logs = [];
  oauthCalls = 0;
});

afterEach(async () => {
  await mock.close();
});

describe("PayPalClient", () => {
  it("refuses live PayPal outright", () => {
    expect(() => client({ baseUrl: "https://api-m.paypal.com" })).toThrow(/sandbox only/);
    expect(() => client({ baseUrl: "https://api-m.sandbox.paypal.com" })).not.toThrow();
  });

  it("reads a subscription and logs PayPal's debug id", async () => {
    const maya = await client().getSubscription(M, MAYA);
    expect(maya).toMatchObject({ id: MAYA, status: "ACTIVE", plan_id: PANTRY_PLAN.standard.planId });
    expect(logs.find((l) => l.msg === "paypal call")?.obj.debugId).toMatch(/^[0-9a-f]{13}$/);
  });

  it("reuses one token, and asks for it once even when calls race", async () => {
    const paypal = client();
    await Promise.all([paypal.getSubscription(M, MAYA), paypal.getSubscription(M, ANA)]);
    await paypal.getSubscription(M, MAYA);
    expect(oauthCalls).toBe(1);
  });

  it("refreshes the token once on a 401 and retries", async () => {
    const paypal = client();
    await paypal.getSubscription(M, MAYA);
    mock.state.expireTokens();
    await expect(paypal.getSubscription(M, MAYA)).resolves.toMatchObject({ id: MAYA });
    expect(oauthCalls).toBe(2);
  });

  it("reports wrong credentials as unauthorized", async () => {
    const paypal = client({ credentials: singleAppCredentials({ clientId: "x", clientSecret: "y" }) });
    const error = await failure(() => paypal.getSubscription(M, MAYA));
    expect(error.kind).toBe("unauthorized");
    expect(error.retryable).toBe(false);
  });

  it("retries 5xx with backoff and succeeds", async () => {
    mock.failures.add({ method: "GET", path: MAYA, status: 503, times: 2 });
    await expect(client().getSubscription(M, MAYA)).resolves.toMatchObject({ id: MAYA });
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(2);
  });

  it("gives up after 4 attempts with a retryable error that carries the debug id", async () => {
    mock.failures.add({ method: "GET", path: MAYA, status: 503, times: 4 });
    const error = await failure(() => client().getSubscription(M, MAYA));
    expect(error).toMatchObject({ kind: "unavailable", retryable: true });
    expect(error.details).toMatchObject({ status: 503 });
    expect(error.details.debugId).toMatch(/^[0-9a-f]{13}$/);
    expect(logs.filter((l) => l.msg === "paypal call")).toHaveLength(4);
  });

  it("treats a timeout as unavailable", async () => {
    mock.failures.add({ method: "GET", path: MAYA, delayMs: 300, times: 4 });
    const error = await failure(() => client({ timeoutMs: 100 }).getSubscription(M, MAYA));
    expect(error.kind).toBe("unavailable");
  });

  it("does not retry a business error, and keeps PayPal's issue code", async () => {
    const error = await failure(() => client().suspend(M, ANA, "Pause"));
    expect(error).toMatchObject({ kind: "unprocessable", retryable: false });
    expect(error.details.issue).toBe("SUBSCRIPTION_STATUS_INVALID");
    expect(logs.filter((l) => l.msg === "paypal call")).toHaveLength(1);
  });

  it("maps an unknown subscription to not_found", async () => {
    const error = await failure(() => client().getSubscription(M, "I-NOPE"));
    expect(error.kind).toBe("not_found");
  });

  it("suspends, activates and cancels, returning the debug id for the Action", async () => {
    const paypal = client();
    const result = await paypal.suspend(M, MAYA, "Paused at the subscriber's request");
    expect(result.debugId).toMatch(/^[0-9a-f]{13}$/);
    expect(await paypal.getSubscription(M, MAYA)).toMatchObject({ status: "SUSPENDED" });
    await paypal.activate(M, MAYA, "Pause over");
    await paypal.cancel(M, MAYA, "Cancelled by the subscriber");
    expect(await paypal.getSubscription(M, MAYA)).toMatchObject({ status: "CANCELLED" });
  });

  it("pages subscriptions and lists transactions", async () => {
    const paypal = client();
    const page = await paypal.listSubscriptions(M, { page: 1 });
    expect(page).toMatchObject({ page: 1, totalItems: 12, totalPages: 1 });
    const transactions = await paypal.listTransactions(M, MAYA, {
      start: "2025-01-01T00:00:00Z",
      end: "2026-12-31T00:00:00Z",
    });
    expect(transactions).toHaveLength(8);
    expect(transactions[0]?.id).toMatch(/^[A-Z0-9]{17}$/);
  });
});

describe("toMoney", () => {
  it("normalises PayPal's amounts to two decimals (spike Q1 saw '1.0')", () => {
    expect(toMoney({ currency_code: "USD", value: "1.0" })).toEqual({ value: "1.00", currency: "USD" });
    expect(toMoney({ currency_code: "USD", value: "12" })).toEqual({ value: "12.00", currency: "USD" });
    expect(toMoney({ currency_code: "USD", value: "9.99" })).toEqual({ value: "9.99", currency: "USD" });
    expect(() => toMoney({ currency_code: "USD", value: "1.234" })).toThrow();
  });
});

describe("TokenBuckets", () => {
  it("allows a burst, then paces to the sustained rate", async () => {
    let now = 0;
    const waits: number[] = [];
    const buckets = new TokenBuckets(
      { perSecond: 2, burst: 3 },
      () => now,
      (ms) => {
        waits.push(ms);
        now += ms;
        return Promise.resolve();
      },
    );
    for (let i = 0; i < 5; i++) await buckets.take("m1");
    expect(waits).toEqual([500, 500]);
    // Another merchant has its own bucket.
    await buckets.take("m2");
    expect(waits).toHaveLength(2);
  });
});
