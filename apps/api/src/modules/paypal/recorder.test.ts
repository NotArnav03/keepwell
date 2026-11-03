import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PANTRY_PLAN } from "@keepwell/contracts/fakes";
import {
  createPayPalMock,
  fixtureSubscriptionId,
  PANTRY_PLAN_CREDENTIALS,
  type PayPalMock,
} from "@keepwell/paypal-mock";
import { PayPalClient } from "./client.js";
import { singleAppCredentials } from "./credentials.js";
import { recordingFetch, scrub, type Exchange } from "./recorder.js";

const M = PANTRY_PLAN.merchantId;

let mock: PayPalMock;
let exchanges: Exchange[];
let paypal: PayPalClient;

beforeEach(async () => {
  mock = createPayPalMock();
  exchanges = [];
  paypal = new PayPalClient({
    baseUrl: await mock.listen(),
    credentials: singleAppCredentials(PANTRY_PLAN_CREDENTIALS),
    log: { info: () => {}, warn: () => {} },
    fetch: recordingFetch((exchange) => exchanges.push(exchange)),
  });
});

afterEach(async () => {
  await mock.close();
});

describe("scrub", () => {
  it("replaces people and accounts, wherever they are nested, and approval tokens in links", () => {
    const scrubbed = scrub({
      subscriber: {
        name: { given_name: "Maya", surname: "Rao" },
        email_address: "maya@example.org",
        payer_id: "ABC123",
        shipping_address: { address: { postal_code: "560001" } },
      },
      transactions: [{ payer_email: "maya@example.org", payer_name: { given_name: "Maya" } }],
      links: [{ href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-123&x=1" }],
      status: "ACTIVE",
    });
    expect(scrubbed).toEqual({
      subscriber: {
        name: { given_name: "Sandbox", surname: "Buyer" },
        email_address: "redacted@example.com",
        payer_id: "REDACTED",
        shipping_address: "REDACTED",
      },
      transactions: [{ payer_email: "redacted@example.com", payer_name: { given_name: "Sandbox" } }],
      links: [{ href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=REDACTED&x=1" }],
      status: "ACTIVE",
    });
  });
});

describe("recordingFetch", () => {
  it("records the gateway's calls, scrubbed, and never the OAuth exchange", async () => {
    const created = await paypal.createSubscription(M, {
      planId: "P-PANTRY-STANDARD",
      returnUrl: "https://example.com/approved",
      cancelUrl: "https://example.com/cancelled",
      requestId: "spike-1",
    });
    expect(created).toMatchObject({ status: "APPROVAL_PENDING" });
    expect(created.approveUrl).toContain("ba_token=BA-");
    await paypal.getSubscription(M, fixtureSubscriptionId("maya"));

    expect(exchanges.map((e) => `${e.request.method} ${e.request.path}`)).toEqual([
      "POST /v1/billing/subscriptions",
      `GET /v1/billing/subscriptions/${fixtureSubscriptionId("maya")}?fields=plan`,
    ]);
    const [create, read] = exchanges;
    expect(create?.request).toMatchObject({
      headers: { "paypal-request-id": "spike-1" },
      body: { plan_id: "P-PANTRY-STANDARD" },
    });
    expect(create?.response.status).toBe(201);
    expect(create?.response.debugId).toMatch(/^[0-9a-f]+$/);
    expect(JSON.stringify(create)).toContain("ba_token=REDACTED");
    expect(read?.response.body).toMatchObject({
      subscriber: { email_address: "redacted@example.com", payer_id: "REDACTED" },
    });
    expect(JSON.stringify(exchanges)).not.toMatch(/access_token|Bearer/);
  });
});
