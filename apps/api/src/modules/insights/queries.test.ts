import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe } from "vitest";
import { createDb, runMigrations } from "@keepwell/db";
import { describeQueries } from "./queries.suite.js";

// Real Postgres 18 (CI's database job, or KEEPWELL_TEST_DATABASE_URL locally). Each run creates and
// drops its own database, like packages/db's tests. Without a URL the SQL tests are skipped, unless
// KEEPWELL_REQUIRE_DATABASE_TESTS is set (CI), which makes a missing URL fail loudly.

const serverUrl = process.env.KEEPWELL_TEST_DATABASE_URL;
if (!serverUrl && process.env.KEEPWELL_REQUIRE_DATABASE_TESTS) {
  describe("insights SQL", () => {
    throw new Error("KEEPWELL_TEST_DATABASE_URL is required but not set");
  });
}

async function adminQuery(url: string, text: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

if (serverUrl) {
  describeQueries(async () => {
    const name = `kw_ins_${randomBytes(6).toString("hex")}`;
    await adminQuery(serverUrl, `CREATE DATABASE ${name}`);
    const url = new URL(serverUrl);
    url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await runMigrations(pool);
    return {
      db: createDb(pool),
      close: async () => {
        await pool.end();
        await adminQuery(serverUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      },
    };
  });
} else {
  describe.skip("insights SQL (no KEEPWELL_TEST_DATABASE_URL)", () => undefined);
}
