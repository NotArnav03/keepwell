import { defineConfig } from "drizzle-kit";

// `pnpm db:generate` writes the next migration into ./drizzle from the schema. Hand-written SQL
// (RLS, triggers) goes in with `pnpm --filter @keepwell/db exec drizzle-kit generate --custom`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  casing: "snake_case",
});
