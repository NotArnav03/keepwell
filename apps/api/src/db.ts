import pg from "pg";
import type { ReadinessCheck } from "./server.js";

/**
 * One pool for the whole process (node-postgres, as Neon recommends for long-running servers).
 * packages/db (#7) builds Drizzle on top of this pool.
 */
export function createPool(connectionString: string, onIdleError: (err: Error) => void): pg.Pool {
  const url = new URL(connectionString);
  // Neon hands out sslmode=require. pg 8 already treats it as verify-full (and warns); pg 9 will
  // weaken it to libpq's "encrypt but don't verify". Pin today's stricter behaviour explicitly.
  if (["prefer", "require", "verify-ca"].includes(url.searchParams.get("sslmode") ?? "")) {
    url.searchParams.set("sslmode", "verify-full");
  }
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max: 10,
    // Neon suspends idle computes after 5 minutes; the first connection after that takes longer.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  // When Neon scales to zero it drops idle connections. pg emits that on the pool, and an
  // unhandled 'error' event would crash the process; the pool reconnects on the next query.
  pool.on("error", onIdleError);
  return pool;
}

export function postgresReadiness(pool: pg.Pool): ReadinessCheck {
  return {
    name: "postgres",
    check: async () => {
      await pool.query("select 1");
    },
  };
}
