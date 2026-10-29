import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("applies defaults for local development", () => {
    expect(loadEnv({})).toEqual({
      NODE_ENV: "development",
      APP_ENV: "local",
      HOST: "0.0.0.0",
      PORT: 3000,
      LOG_LEVEL: "info",
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
});
