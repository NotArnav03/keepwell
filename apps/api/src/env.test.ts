import { describe, expect, it } from "vitest";
import { databaseUrl, loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("applies defaults for local development", () => {
    expect(loadEnv({})).toEqual({
      NODE_ENV: "development",
      APP_ENV: "local",
      HOST: "0.0.0.0",
      PORT: 3000,
      LOG_LEVEL: "info",
      RUN_MIGRATIONS: true,
      PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
      PAYPAL_USE_MOCK: false,
      PAYPAL_MOCK_URL: "http://localhost:4010",
      TRUST_PROXY_HOPS: 0,
      RESEND_API_BASE: "https://api.resend.com",
      LLM_DAILY_BUDGET_USD: 0.1,
    });
  });

  describe("subscriber surfaces", () => {
    it("reads the widget origins as a list and treats blanks as unset", () => {
      const env = loadEnv({
        WIDGET_ALLOWED_ORIGINS: "http://localhost:5176, https://store.example ,",
        SESSION_TICKET_SECRET: "",
        DEMO_MERCHANT_ID: "",
      });
      expect(env.WIDGET_ALLOWED_ORIGINS).toEqual(["http://localhost:5176", "https://store.example"]);
      expect(env.SESSION_TICKET_SECRET).toBeUndefined();
      expect(env.DEMO_MERCHANT_ID).toBeUndefined();
    });

    it("refuses short secrets and a model budget above the $5 credit", () => {
      expect(() => loadEnv({ SESSION_TICKET_SECRET: "short" })).toThrow(/SESSION_TICKET_SECRET/);
      expect(() => loadEnv({ JUDGE_LEASE_SECRET: "short" })).toThrow(/JUDGE_LEASE_SECRET/);
      expect(() => loadEnv({ LLM_DAILY_BUDGET_USD: "6" })).toThrow(/LLM_DAILY_BUDGET_USD/);
      expect(loadEnv({ LLM_DAILY_BUDGET_USD: "0.25" }).LLM_DAILY_BUDGET_USD).toBe(0.25);
    });

    it("refuses an origin that is not a URL and a demo merchant id that is not a uuid", () => {
      expect(() => loadEnv({ WIDGET_ALLOWED_ORIGINS: "not a url" })).toThrow(/WIDGET_ALLOWED_ORIGINS/);
      expect(() => loadEnv({ DEMO_MERCHANT_ID: "pantry" })).toThrow(/DEMO_MERCHANT_ID/);
    });
  });

  describe("PayPal", () => {
    const db = { DATABASE_URL_UNPOOLED: "postgresql://u:p@ep-x.us-west-2.aws.neon.tech/neondb" };

    it("reads boolean flags the way .env files write them", () => {
      expect(loadEnv({ PAYPAL_USE_MOCK: "true", RUN_MIGRATIONS: "false" })).toMatchObject({
        PAYPAL_USE_MOCK: true,
        RUN_MIGRATIONS: false,
      });
    });

    it("allows the mock only on a laptop", () => {
      expect(() => loadEnv({ ...db, APP_ENV: "staging", PAYPAL_USE_MOCK: "true" })).toThrow(/local only/);
    });

    it("requires sandbox credentials on hosted environments", () => {
      expect(() => loadEnv({ ...db, APP_ENV: "staging" })).toThrow(/PAYPAL_CLIENT_ID/);
      expect(() =>
        loadEnv({ ...db, APP_ENV: "staging", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" }),
      ).not.toThrow();
    });
  });

  it("coerces PORT from the string Render provides", () => {
    expect(loadEnv({ PORT: "10000" }).PORT).toBe(10000);
  });

  it("names every invalid variable at once", () => {
    expect(() => loadEnv({ PORT: "abc", APP_ENV: "production" })).toThrow(
      /PORT[\s\S]*APP_ENV|APP_ENV[\s\S]*PORT/,
    );
  });

  describe("database URL", () => {
    const direct = "postgresql://u:p@ep-cool-sun-123.us-west-2.aws.neon.tech/neondb?sslmode=require";
    const pooled = "postgresql://u:p@ep-cool-sun-123-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require";

    it("prefers the unpooled URL that neon env pull writes", () => {
      expect(databaseUrl(loadEnv({ DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: direct }))).toBe(direct);
    });

    it("accepts a direct DATABASE_URL on its own", () => {
      expect(databaseUrl(loadEnv({ DATABASE_URL: direct }))).toBe(direct);
    });

    it("rejects a pooled URL, which breaks pg-boss and LISTEN/NOTIFY", () => {
      expect(() => loadEnv({ DATABASE_URL: pooled })).toThrow(/direct \(non-pooled\)/);
    });

    it("treats empty values from .env.example as unset, so local runs without a database", () => {
      expect(databaseUrl(loadEnv({ DATABASE_URL: "", DATABASE_URL_UNPOOLED: "" }))).toBeUndefined();
    });

    it("requires a database outside local development", () => {
      expect(() => loadEnv({ APP_ENV: "staging" })).toThrow(/DATABASE_URL_UNPOOLED/);
    });
  });
});
