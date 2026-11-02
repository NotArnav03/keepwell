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
