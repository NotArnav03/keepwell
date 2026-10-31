import pg from "pg";
import { z } from "zod";
import { runMigrations } from "../migrate.js";
import { withStrictSsl } from "../ssl.js";

// `pnpm db:migrate`: applies pending migrations to DATABASE_URL_UNPOOLED (your Neon branch locally,
// staging or prod-demo on deploy).

const { DATABASE_URL_UNPOOLED: url } = z
  .object({
    DATABASE_URL_UNPOOLED: z
      .url()
      .refine(
        (value) => !new URL(value).hostname.includes("-pooler"),
        "Use the direct URL, not the -pooler one",
      ),
  })
  .parse(process.env);

const pool = new pg.Pool({ connectionString: withStrictSsl(url), max: 1 });
try {
  await runMigrations(pool);
  process.stdout.write("Migrations applied.\n");
} finally {
  await pool.end();
}
