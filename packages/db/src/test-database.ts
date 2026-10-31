import { randomBytes } from "node:crypto";
import pg from "pg";
import { APP_ROLE_OPTIONS } from "./client.js";
import { runMigrations } from "./migrate.js";
import { withStrictSsl } from "./ssl.js";

// A throwaway database for tests: created, migrated, then dropped, so tests never touch existing
// data. Point KEEPWELL_TEST_DATABASE_URL at any Postgres 18 server whose role may CREATE DATABASE
// and CREATE ROLE (your Neon branch's owner works; CI uses a service container). Without it,
// database tests are skipped.

export const TEST_DATABASE_URL = process.env.KEEPWELL_TEST_DATABASE_URL;

export interface TestDatabase {
  /** As the login role: what migrations and admin queries use. */
  ownerPool: pg.Pool;
  /** As keepwell_app, like the API's pool. */
  appPool: pg.Pool;
  drop: () => Promise<void>;
}

export async function createTestDatabase(serverUrl: string): Promise<TestDatabase> {
  const name = `kw_test_${randomBytes(6).toString("hex")}`;
  await adminQuery(serverUrl, `CREATE DATABASE ${name}`);

  const url = new URL(withStrictSsl(serverUrl));
  url.pathname = `/${name}`;
  const ownerPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  await runMigrations(ownerPool);
  const appPool = new pg.Pool({ connectionString: url.toString(), max: 4, options: APP_ROLE_OPTIONS });

  return {
    ownerPool,
    appPool,
    async drop() {
      await Promise.all([ownerPool.end(), appPool.end()]);
      await adminQuery(serverUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

async function adminQuery(serverUrl: string, text: string): Promise<void> {
  const client = new pg.Client({ connectionString: withStrictSsl(serverUrl) });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}
