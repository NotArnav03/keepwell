import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PayPalSubscription } from "@keepwell/contracts";
import { fixtureSubscriptionId, PANTRY_PLAN_CREDENTIALS, pantryPlanFixture } from "./fixtures.js";
import { createPayPalMock, type PayPalMock } from "./server.js";

// Everything over real HTTP, the way the gateway (#8) will call it.

const NOW = new Date("2026-11-01T12:00:00Z");
const MAYA = fixtureSubscriptionId("maya");
const RAJ = fixtureSubscriptionId("raj");
const OTHER = { id: "other-merchant", name: "Other", clientId: "other-client", clientSecret: "other-secret" };

let mock: PayPalMock;
let base: string;
let token: string;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    redirect: "manual",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined && { "content-type": "application/json" }),
      ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

async function login(clientId: string, clientSecret: string) {
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const subscription = async (id: string) => (await call("GET", `/v1/billing/subscriptions/${id}`)).body;
const issue = (body: Record<string, unknown> | null) =>
  (body?.details as { issue: string }[] | undefined)?.[0]?.issue;

beforeEach(async () => {
  mock = createPayPalMock({
    clock: () => NOW,
    fixtures: (now) => [
      pantryPlanFixture(now),
      { merchant: OTHER, plans: [], subscriptions: [], transactions: [] },
    ],
  });
  base = await mock.listen();
  const { body } = await login(PANTRY_PLAN_CREDENTIALS.clientId, PANTRY_PLAN_CREDENTIALS.clientSecret);
  token = String(body.access_token);
});

afterEach(async () => {
  await mock.close();
});

describe("OAuth and auth", () => {
  it("issues a token for the merchant's credentials and refuses others", async () => {
    expect((await login("pantry-plan-mock-client", "wrong")).status).toBe(401);
    token = "nope";
    const res = await call("GET", `/v1/billing/subscriptions/${MAYA}`);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ name: "AUTHENTICATION_FAILURE" });
    expect(res.headers.get("paypal-debug-id")).toMatch(/^[0-9a-f]{13}$/);
  });

  it("answers 401 once tokens expire, and a fresh token works", async () => {
    mock.state.expireTokens();
    expect((await call("GET", `/v1/billing/subscriptions/${MAYA}`)).status).toBe(401);
    token = String(
      (await login(PANTRY_PLAN_CREDENTIALS.clientId, PANTRY_PLAN_CREDENTIALS.clientSecret)).body.access_token,
    );
    expect((await call("GET", `/v1/billing/subscriptions/${MAYA}`)).status).toBe(200);
  });

  it("keeps merchants apart: another merchant's subscription is a 404", async () => {
    token = String((await login(OTHER.clientId, OTHER.clientSecret)).body.access_token);
    const res = await call("GET", `/v1/billing/subscriptions/${MAYA}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ name: "RESOURCE_NOT_FOUND" });
    expect(issue(res.body)).toBe("INVALID_RESOURCE_ID");
  });
});

describe("subscription status changes", () => {
  it("returns a subscription the contracts schema accepts", async () => {
    expect(PayPalSubscription.parse(await subscription(MAYA)).status).toBe("ACTIVE");
  });

  it("follows PayPal's rules for suspend, activate and cancel", async () => {
    expect(
      (await call("POST", `/v1/billing/subscriptions/${MAYA}/suspend`, { reason: "Pause" })).status,
    ).toBe(204);
    expect(await subscription(MAYA)).toMatchObject({ status: "SUSPENDED" });

    const again = await call("POST", `/v1/billing/subscriptions/${MAYA}/suspend`, { reason: "Pause" });
    expect(again.status).toBe(422);
    expect(issue(again.body)).toBe("SUBSCRIPTION_STATUS_INVALID");

    expect(
      (await call("POST", `/v1/billing/subscriptions/${MAYA}/activate`, { reason: "Back" })).status,
    ).toBe(204);
    expect((await call("POST", `/v1/billing/subscriptions/${MAYA}/cancel`, { reason: "Bye" })).status).toBe(
      204,
    );
    const cancelled = await subscription(MAYA);
    expect(cancelled).toMatchObject({ status: "CANCELLED" });
    expect((cancelled?.billing_info as Record<string, unknown>).next_billing_time).toBeUndefined();
    expect((await call("POST", `/v1/billing/subscriptions/${MAYA}/cancel`, { reason: "Bye" })).status).toBe(
      422,
    );
  });

  it("requires a reason, like PayPal", async () => {
    const res = await call("POST", `/v1/billing/subscriptions/${MAYA}/suspend`, {});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ name: "INVALID_REQUEST" });
  });
});

describe("revise, price override, capture, transactions and refunds", () => {
  it("changes the plan only after the buyer approves, then redirects to return_url", async () => {
    const revised = await call("POST", `/v1/billing/subscriptions/${MAYA}/revise`, {
      plan_id: "P-PANTRY-LITE",
      application_context: { return_url: "http://localhost:3000/v1/revise/return?action=a1" },
    });
    expect(revised.status).toBe(200);
    const approve = (revised.body?.links as { rel: string; href: string }[]).find((l) => l.rel === "approve");
    expect(await subscription(MAYA)).toMatchObject({ plan_id: "P-PANTRY-STANDARD" });

    const token = new URL(approve?.href ?? "").searchParams.get("ba_token") ?? "";
    const page = await fetch(approve?.href ?? "");
    expect(await page.text()).toContain("Approve");
    const decided = await fetch(`${base}/webapps/billing/subscriptions/update`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ba_token: token, decision: "approve" }).toString(),
    });
    expect(decided.status).toBe(302);
    expect(decided.headers.get("location")).toContain(`action=a1&subscription_id=${MAYA}`);
    expect(await subscription(MAYA)).toMatchObject({ plan_id: "P-PANTRY-LITE" });
  });

  it("stores a fixed_price override and shows it with fields=plan", async () => {
    const res = await call("PATCH", `/v1/billing/subscriptions/${MAYA}`, [
      {
        op: "replace",
        path: "/plan/billing_cycles/@sequence==1/pricing_scheme/fixed_price",
        value: { currency_code: "USD", value: "9.00" },
      },
    ]);
    expect(res.status).toBe(204);
    const withPlan = (await call("GET", `/v1/billing/subscriptions/${MAYA}?fields=plan`)).body;
    expect(withPlan).toMatchObject({
      plan_overridden: true,
      plan: { billing_cycles: [{ pricing_scheme: { fixed_price: { value: "9.00" } } }] },
    });
  });

  it("captures an outstanding balance once per PayPal-Request-Id", async () => {
    const body = {
      note: "Recover",
      capture_type: "OUTSTANDING_BALANCE",
      amount: { currency_code: "USD", value: "24.00" },
    };
    const first = await call("POST", `/v1/billing/subscriptions/${RAJ}/capture`, body, {
      "paypal-request-id": "act-1",
    });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({
      status: "COMPLETED",
      amount_with_breakdown: { gross_amount: { value: "24.00" } },
    });
    const repeat = await call("POST", `/v1/billing/subscriptions/${RAJ}/capture`, body, {
      "paypal-request-id": "act-1",
    });
    expect(repeat.body?.id).toBe(first.body?.id);
    expect(await subscription(RAJ)).toMatchObject({
      billing_info: { outstanding_balance: { value: "0.00" }, failed_payments_count: 0 },
    });

    const none = await call("POST", `/v1/billing/subscriptions/${MAYA}/capture`, body);
    expect(issue(none.body)).toBe("ZERO_OUTSTANDING_BALANCE");
  });

  it("lists transactions in a time range and refunds them in parts", async () => {
    const range = "start_time=2025-01-01T00:00:00Z&end_time=2026-12-31T00:00:00Z";
    const list = await call("GET", `/v1/billing/subscriptions/${MAYA}/transactions?${range}`);
    const transactions = list.body?.transactions as { id: string; status: string }[];
    expect(transactions).toHaveLength(8);
    expect((await call("GET", `/v1/billing/subscriptions/${MAYA}/transactions`)).status).toBe(400);

    const last = transactions.at(-1)?.id ?? "";
    const partial = await call("POST", `/v1/payments/sale/${last}/refund`, {
      amount: { total: "6.00", currency: "USD" },
    });
    expect(partial).toMatchObject({ status: 201, body: { state: "completed", amount: { total: "6.00" } } });
    const tooMuch = await call("POST", `/v2/payments/captures/${last}/refund`, {
      amount: { currency_code: "USD", value: "7.00" },
    });
    expect(issue(tooMuch.body)).toBe("REFUND_AMOUNT_EXCEEDED");
    expect((await call("POST", `/v2/payments/captures/${last}/refund`, {})).body).toMatchObject({
      status: "COMPLETED",
    });
    const after = (await call("GET", `/v1/billing/subscriptions/${MAYA}/transactions?${range}`)).body;
    expect((after?.transactions as { status: string }[]).at(-1)?.status).toBe("REFUNDED");
  });
});

describe("lists and plans", () => {
  it("filters subscriptions by status and status_updated_after, and pages them", async () => {
    const suspended = await call("GET", "/v1/billing/subscriptions?statuses=SUSPENDED");
    expect(suspended.body).toMatchObject({ total_items: 2 });
    const recent = await call("GET", `/v1/billing/subscriptions?status_updated_after=2026-10-29T00:00:00Z`);
    expect((recent.body?.subscriptions as { id: string }[]).map((s) => s.id).sort()).toEqual(
      [fixtureSubscriptionId("ben"), fixtureSubscriptionId("tom"), fixtureSubscriptionId("sara")].sort(),
    );
    const page2 = await call("GET", "/v1/billing/subscriptions?page_size=5&page=3");
    expect(page2.body).toMatchObject({ total_items: 12, total_pages: 3 });
    expect(page2.body?.subscriptions).toHaveLength(2);
  });

  it("creates a plan once per PayPal-Request-Id", async () => {
    const plan = {
      product_id: "PROD-PANTRYPLAN",
      name: "Standard 3-month",
      billing_cycles: [
        {
          frequency: { interval_unit: "MONTH", interval_count: 3 },
          tenure_type: "REGULAR",
          sequence: 1,
          pricing_scheme: { fixed_price: { currency_code: "USD", value: "33.00" } },
        },
      ],
    };
    const first = await call("POST", "/v1/billing/plans", plan, { "paypal-request-id": "act-9" });
    const again = await call("POST", "/v1/billing/plans", plan, { "paypal-request-id": "act-9" });
    expect(first.status).toBe(201);
    expect(again.body?.id).toBe(first.body?.id);
    expect((await call("GET", "/v1/billing/plans?product_id=PROD-PANTRYPLAN")).body).toMatchObject({
      total_items: 5,
    });
  });
});

describe("failure injection", () => {
  it("fails the next matching call, then behaves again", async () => {
    mock.failures.add({ method: "GET", path: MAYA, status: 503 });
    expect((await call("GET", `/v1/billing/subscriptions/${MAYA}`)).status).toBe(503);
    expect((await call("GET", `/v1/billing/subscriptions/${MAYA}`)).status).toBe(200);
  });

  it("can apply the change and still answer 500, the case read-before-retry covers", async () => {
    mock.failures.add({ path: /\/suspend$/, status: 500, apply: true });
    const res = await call("POST", `/v1/billing/subscriptions/${MAYA}/suspend`, { reason: "Pause" });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ name: "INTERNAL_SERVER_ERROR" });
    expect(await subscription(MAYA)).toMatchObject({ status: "SUSPENDED" });
  });

  it("can hang past the client's timeout", async () => {
    mock.failures.add({ path: MAYA, delayMs: 500 });
    await expect(
      fetch(`${base}/v1/billing/subscriptions/${MAYA}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow();
  });

  it("is driven over HTTP too, for curl users", async () => {
    const res = await fetch(`${base}/__mock/failures`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/\\/cancel$/", status: 422, issue: "SUBSCRIPTION_STATUS_INVALID" }),
    });
    expect(res.status).toBe(201);
    const cancel = await call("POST", `/v1/billing/subscriptions/${MAYA}/cancel`, { reason: "Bye" });
    expect(issue(cancel.body)).toBe("SUBSCRIPTION_STATUS_INVALID");
  });
});

describe("webhooks", () => {
  let receiver: Server;
  let received: { headers: IncomingHttpHeaders; body: string }[];
  let receiverUrl: string;

  beforeEach(async () => {
    received = [];
    receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhooks/paypal/m1`;
  });

  afterEach(async () => {
    await new Promise((resolve) => receiver.close(resolve));
  });

  const register = async (types = ["*"]) =>
    String(
      (
        await call("POST", "/v1/notifications/webhooks", {
          url: receiverUrl,
          event_types: types.map((name) => ({ name })),
        })
      ).body?.id,
    );

  const verifyDelivery = (
    delivery: { headers: IncomingHttpHeaders; body: string },
    webhookId: string,
    raw = delivery.body,
  ) =>
    // The raw body goes in verbatim, as ARCHITECTURE.md §6.2 requires of the gateway.
    fetch(`${base}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: `{"auth_algo":"${String(delivery.headers["paypal-auth-algo"])}","cert_url":"${String(delivery.headers["paypal-cert-url"])}","transmission_id":"${String(delivery.headers["paypal-transmission-id"])}","transmission_sig":"${String(delivery.headers["paypal-transmission-sig"])}","transmission_time":"${String(delivery.headers["paypal-transmission-time"])}","webhook_id":"${webhookId}","webhook_event":${raw}}`,
    }).then(async (res) => ((await res.json()) as { verification_status: string }).verification_status);

  it("delivers a signed event for each change, which the verify endpoint accepts", async () => {
    const webhookId = await register();
    await call("POST", `/v1/billing/subscriptions/${MAYA}/suspend`, { reason: "Pause" });
    await mock.webhooks.flush();

    expect(received).toHaveLength(1);
    const [delivery] = received;
    if (!delivery) throw new Error("no delivery");
    expect(JSON.parse(delivery.body)).toMatchObject({
      event_type: "BILLING.SUBSCRIPTION.SUSPENDED",
      resource: { id: MAYA, status: "SUSPENDED" },
    });
    expect(await verifyDelivery(delivery, webhookId)).toBe("SUCCESS");
    expect(await verifyDelivery(delivery, webhookId, delivery.body.replace("SUSPENDED", "ACTIVE"))).toBe(
      "FAILURE",
    );
    expect(await verifyDelivery(delivery, "SOMEONE-ELSES-WEBHOOK")).toBe("FAILURE");
  });

  it("only sends the event types a webhook subscribed to, and resends with a fresh signature", async () => {
    const webhookId = await register(["BILLING.SUBSCRIPTION.CANCELLED"]);
    await call("POST", `/v1/billing/subscriptions/${MAYA}/suspend`, { reason: "Pause" });
    mock.state.cancelInPayPal(MAYA);
    await mock.webhooks.flush();
    expect(received.map((r) => (JSON.parse(r.body) as { event_type: string }).event_type)).toEqual([
      "BILLING.SUBSCRIPTION.CANCELLED",
    ]);

    const eventId = (JSON.parse(received[0]?.body ?? "{}") as { id: string }).id;
    expect((await call("POST", `/v1/notifications/webhooks-events/${eventId}/resend`, {})).status).toBe(202);
    await mock.webhooks.flush();
    expect(received).toHaveLength(2);
    expect(received[1]?.headers["paypal-transmission-id"]).not.toBe(
      received[0]?.headers["paypal-transmission-id"],
    );
    const resent = received[1];
    if (!resent) throw new Error("no resend");
    expect(await verifyDelivery(resent, webhookId)).toBe("SUCCESS");
  });

  it("records a delivery to a receiver that is down instead of failing", async () => {
    await call("POST", "/v1/notifications/webhooks", {
      url: "http://127.0.0.1:1/down",
      event_types: [{ name: "*" }],
    });
    mock.state.renew(MAYA);
    await mock.webhooks.flush();
    expect(mock.webhooks.deliveries.at(-1)).toMatchObject({
      eventType: "PAYMENT.SALE.COMPLETED",
      status: null,
    });
  });
});

describe("what PayPal does on its own", () => {
  it("renews: charges the cycle and moves next_billing_time on", async () => {
    const before = await subscription(MAYA);
    mock.state.renew(MAYA);
    const after = await subscription(MAYA);
    const nextOf = (s: typeof before) => (s?.billing_info as { next_billing_time: string }).next_billing_time;
    expect(Date.parse(nextOf(after))).toBeGreaterThan(Date.parse(nextOf(before)));
  });

  it("suspends after the plan's failure threshold, with PAYMENT.FAILED for each failure", async () => {
    const events: string[] = [];
    mock.state.onEvent = (_merchant, event) => events.push(event.event_type);
    for (let i = 0; i < 3; i++) mock.state.renew(MAYA, "PAYER_CANNOT_PAY");
    expect(await subscription(MAYA)).toMatchObject({
      status: "SUSPENDED",
      billing_info: { failed_payments_count: 3, outstanding_balance: { value: "36.00" } },
    });
    expect(events).toEqual([
      "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
      "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
      "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
      "BILLING.SUBSCRIPTION.SUSPENDED",
    ]);
  });

  it("resets to the fixtures", async () => {
    mock.state.cancelInPayPal(MAYA);
    mock.reset();
    token = String(
      (await login(PANTRY_PLAN_CREDENTIALS.clientId, PANTRY_PLAN_CREDENTIALS.clientSecret)).body.access_token,
    );
    expect(await subscription(MAYA)).toMatchObject({ status: "ACTIVE" });
  });
});
