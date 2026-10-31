import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";

// Forward-only migrations (packages/db/CLAUDE.md). The SQL lives in packages/db/drizzle: generated
// files from `pnpm db:generate`, plus hand-written ones for what Drizzle can't express (RLS,
// append-only triggers). Run over the direct, unpooled connection: migrations need a session.

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

export async function runMigrations(pool: Pool): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
}
