import { describe, expect, it } from "vitest";
import { TemplateId } from "@keepwell/contracts";
import { loadEnv } from "../../env.js";
import { notifyConfigFromEnv } from "./config.js";
import { backoffMs } from "./dispatcher.js";
import { CONTENT } from "./fixtures.js";
import { EmailProviderError, ResendProvider } from "./providers.js";
import { formatDate, formatMoney, renderTemplate } from "./templates.js";
import {
  createUnsubscribeToken,
  hashEmail,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from "./unsubscribe-token.js";

const SECRET = "test-secret-test-secret-test-secret-0123";
const MERCHANT = "0199a1b2-c3d4-7e5f-8a6b-000000000001";
const UNSUB = "https://api.keepwell.example/v1/unsubscribe?token=abc";

describe("templates", () => {
  it.each(TemplateId.options)("%s renders subject, body and an unsubscribe link", (id) => {
    const out = renderTemplate(CONTENT[id], UNSUB);
    expect(out.subject.length).toBeGreaterThan(5);
    expect(out.bodyText).toContain(UNSUB);
    expect(out.bodyText).not.toMatch(/undefined|null|\[object/);
  });

  it("takes every fact from the payload", () => {
    const body = renderTemplate(CONTENT["dunning.update_payment_method"], UNSUB).bodyText;
    expect(body).toContain("Hi Maya,");
    expect(body).toContain("$12.00");
    expect(body).toContain("3 November 2026");
    expect(body).toContain("https://www.sandbox.paypal.com/myaccount/autopay/");
  });

  it("omits optional facts that are null", () => {
    const body = renderTemplate(CONTENT["dunning.account_restricted"], UNSUB).bodyText;
    expect(body).toContain("Hi there,");
    const limit = renderTemplate(CONTENT["dunning.sending_limit"], UNSUB).bodyText;
    expect(limit).not.toContain("try the payment again");
    expect(limit).toContain("Lite at $6.00");
  });

  it("formats money from decimal strings and dates in UTC", () => {
    expect(formatMoney({ value: "12.00", currency: "USD" })).toBe("$12.00");
    expect(formatMoney({ value: "9.50", currency: "CAD" })).toBe("9.50 CAD");
    expect(formatDate("2026-12-31T23:59:59.000Z")).toBe("31 December 2026");
  });
});

describe("unsubscribe token", () => {
  const address = "  Maya+News@Pantry.test ";
  const normalised = "maya+news@pantry.test";

  it("signs the merchant and the address hash, and the url never carries the address", () => {
    const token = createUnsubscribeToken(SECRET, { merchantId: MERCHANT, email: address });
    const url = unsubscribeUrl("https://api.keepwell.test", SECRET, {
      merchantId: MERCHANT,
      email: address,
    });
    const body = token.split(".")[0] ?? "";
    const decoded: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    expect(decoded).toEqual({ m: MERCHANT, h: hashEmail(normalised) });
    expect(verifyUnsubscribeToken(SECRET, token)).toEqual({
      merchantId: MERCHANT,
      emailHash: hashEmail(address),
    });
    // Same mailbox, whatever the case and surrounding whitespace.
    expect(hashEmail(address)).toBe(hashEmail(normalised));
    expect(hashEmail("MAYA+NEWS@PANTRY.TEST")).toBe(hashEmail(normalised));
    const revealed = JSON.stringify(decoded).toLowerCase();
    expect(revealed).not.toContain("maya");
    expect(revealed).not.toContain("pantry");
    expect(revealed).not.toContain("@");
    // Plain address, the form with a literal "+", and the form with "@" percent-encoded.
    const forms = [
      address.trim(),
      normalised,
      encodeURIComponent(normalised),
      normalised.replaceAll("@", "%40"),
      normalised.replaceAll("+", "%2B"),
      "maya+news%40pantry.test",
      "maya%2bnews%40pantry.test",
    ];
    for (const form of forms) {
      expect(url.toLowerCase().includes(form.toLowerCase())).toBe(false);
      expect(token.toLowerCase().includes(form.toLowerCase())).toBe(false);
    }
  });

  it("rejects another merchant, a wrong hash, a tampered signature, a wrong secret and junk", () => {
    const token = createUnsubscribeToken(SECRET, { merchantId: MERCHANT, email: normalised });
    const [body, sig] = token.split(".");
    const otherMerchant = "0199a1b2-c3d4-7e5f-8a6b-000000000002";
    const swappedMerchant = Buffer.from(
      JSON.stringify({ m: otherMerchant, h: hashEmail(normalised) }),
    ).toString("base64url");
    const wrongHash = Buffer.from(JSON.stringify({ m: MERCHANT, h: hashEmail("raj@example.com") })).toString(
      "base64url",
    );
    expect(verifyUnsubscribeToken(SECRET, `${swappedMerchant}.${sig ?? ""}`)).toBeNull();
    expect(verifyUnsubscribeToken(SECRET, `${wrongHash}.${sig ?? ""}`)).toBeNull();
    const forged = Buffer.from(sig ?? "", "base64url");
    forged[0] = (forged[0] ?? 0) ^ 0xff;
    expect(verifyUnsubscribeToken(SECRET, `${body ?? ""}.${forged.toString("base64url")}`)).toBeNull();
    expect(verifyUnsubscribeToken("another-secret-another-secret-123456", token)).toBeNull();
    expect(verifyUnsubscribeToken(SECRET, body ?? "")).toBeNull();
    expect(verifyUnsubscribeToken(SECRET, "a.b.c")).toBeNull();
    expect(verifyUnsubscribeToken(SECRET, "")).toBeNull();
  });
});

describe("backoff", () => {
  it("grows by 4x from one minute", () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([60_000, 240_000, 960_000, 3_840_000]);
  });
});

describe("config", () => {
  it("uses the signing secret, strips trailing slashes and treats empty values as unset", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      UNSUBSCRIBE_TOKEN_SECRET: SECRET,
      RESEND_API_KEY: "",
      EMAIL_FROM: "",
    });
    const config = notifyConfigFromEnv(env, "https://api.keepwell.example/");
    expect(config).toMatchObject({
      resendApiKey: undefined,
      resendApiBase: "https://api.resend.com",
      unsubscribeSecret: SECRET,
      publicUrl: "https://api.keepwell.example",
    });
  });

  it("generates a throwaway secret when none is set", () => {
    const config = notifyConfigFromEnv(loadEnv({ NODE_ENV: "test" }), "http://localhost:3000");
    expect(config.unsubscribeSecret.length).toBeGreaterThanOrEqual(32);
  });
});

describe("ResendProvider (mocked fetch, no network)", () => {
  const message = {
    id: MERCHANT,
    to: "maya@example.com",
    subject: "Hi",
    text: "Body",
    unsubscribeUrl: UNSUB,
  };
  const make = (fetchImpl: typeof fetch) =>
    new ResendProvider({
      apiKey: "key-for-tests",
      baseUrl: "https://resend.test",
      from: "Keepwell <a@b.test>",
      fetch: fetchImpl,
    });

  it("posts the message with an idempotency key and returns the provider id", async () => {
    let url = "";
    let key: string | null = null;
    let body = "";
    const fetchMock: typeof fetch = (input, init) => {
      url = typeof input === "string" ? input : "";
      key = new Headers(init?.headers).get("idempotency-key");
      body = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(Response.json({ id: "re_123" }));
    };
    const result = await make(fetchMock).send(message);
    expect(result).toEqual({ providerId: "re_123" });
    expect(url).toBe("https://resend.test/emails");
    expect(key).toBe(message.id);
    expect(JSON.parse(body)).toMatchObject({
      to: ["maya@example.com"],
      subject: "Hi",
      text: "Body",
    });
  });

  it.each([
    [500, true],
    [429, true],
    [422, false],
    [401, false],
  ])("status %i is retryable=%s", async (status, retryable) => {
    const fetchMock = () => Promise.resolve(new Response("{}", { status }));
    const err = await make(fetchMock as unknown as typeof fetch)
      .send(message)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailProviderError);
    expect((err as EmailProviderError).retryable).toBe(retryable);
  });

  it("treats a network failure as retryable", async () => {
    const err = await make(() => Promise.reject(new Error("socket hang up")))
      .send(message)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "network", retryable: true });
  });
});
