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
      LLM_DAILY_BUDGET_USD: 0.25,
      LLM_PROVIDER: "anthropic",
    });
  });

  it("reads the daily model budget, and rejects a negative one", () => {
    expect(loadEnv({ LLM_DAILY_BUDGET_USD: "0.02" })).toMatchObject({ LLM_DAILY_BUDGET_USD: 0.02 });
    expect(loadEnv({ LLM_DAILY_BUDGET_USD: "" })).toMatchObject({ LLM_DAILY_BUDGET_USD: 0.25 });
    expect(() => loadEnv({ LLM_DAILY_BUDGET_USD: "-1" })).toThrow();
  });

  it("picks the model provider, anthropic unless set, and rejects an unknown one", () => {
    expect(loadEnv({ LLM_PROVIDER: "groq" })).toMatchObject({ LLM_PROVIDER: "groq" });
    expect(loadEnv({ LLM_PROVIDER: "" })).toMatchObject({ LLM_PROVIDER: "anthropic" });
    expect(() => loadEnv({ LLM_PROVIDER: "openai" })).toThrow();
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
        loadEnv({
          ...db,
          APP_ENV: "staging",
          PAYPAL_CLIENT_ID: "id",
          PAYPAL_CLIENT_SECRET: "secret",
          SESSION_SECRET: "a-session-secret-with-at-least-32-bytes",
          DASHBOARD_URL: "https://dashboard.example.test",
          PAYPAL_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        }),
      ).not.toThrow();
    });

    it("boots a hosted environment without the dashboard variables (the merchant routes stay off)", () => {
      const hosted = { ...db, APP_ENV: "staging", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" };
      const env = loadEnv(hosted);
      expect(env.SESSION_SECRET).toBeUndefined();
      expect(env.DASHBOARD_URL).toBeUndefined();
      expect(env.PAYPAL_CREDENTIALS_ENCRYPTION_KEY).toBeUndefined();
    });

    it("still checks the format of the dashboard variables when they are set", () => {
      const hosted = { ...db, APP_ENV: "staging", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" };
      expect(() => loadEnv({ ...hosted, SESSION_SECRET: "short" })).toThrow(/32 bytes/);
      expect(() =>
        loadEnv({ ...hosted, PAYPAL_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64") }),
      ).toThrow(/exactly 32 bytes/);
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
