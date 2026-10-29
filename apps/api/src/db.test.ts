import { describe, expect, it } from "vitest";
import { createPool } from "./db.js";

const neonUrl = (sslmode: string) =>
  `postgresql://u:p@ep-cool-sun-123.us-west-2.aws.neon.tech/neondb?sslmode=${sslmode}&channel_binding=require`;

describe("createPool", () => {
  it.each(["require", "prefer", "verify-ca"])("pins sslmode=%s to verify-full", async (mode) => {
    const pool = createPool(neonUrl(mode), () => undefined);
    expect(pool.options.connectionString).toContain("sslmode=verify-full");
    expect(pool.options.connectionString).toContain("channel_binding=require");
    await pool.end();
  });

  it("leaves verify-full and disable alone", async () => {
    for (const mode of ["verify-full", "disable"]) {
      const pool = createPool(neonUrl(mode), () => undefined);
      expect(pool.options.connectionString).toContain(`sslmode=${mode}`);
      await pool.end();
    }
  });
});
