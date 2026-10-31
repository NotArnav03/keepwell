import { z } from "zod";

// .env.example ships keys with empty values; treat those as unset rather than as "".
const blank = (v: unknown) => (v === "" ? undefined : v);
const optionalUrl = z.preprocess(blank, z.url().optional());
const optionalString = z.preprocess(blank, z.string().min(1).optional());
const flag = (fallback: boolean) =>
  z.preprocess((v) => (v === "" || v === undefined ? fallback : v === "true" || v === "1"), z.boolean());

// Only what the API shell needs today. Each module adds its own variables here as it lands,
// and they must also be listed in .env.example.
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_ENV: z.enum(["local", "staging", "prod-demo"]).default("local"),
    HOST: z.string().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    // `neon env pull` writes both. The API needs the direct one: pg-boss, advisory locks and
    // LISTEN/NOTIFY are session features that Neon's pooler (PgBouncer, transaction mode) breaks.
    DATABASE_URL_UNPOOLED: optionalUrl,
    DATABASE_URL: optionalUrl,
    // Set by Render on every deploy; shown on /healthz so we can tell which build is live.
    RENDER_GIT_COMMIT: z.string().optional(),
    // Apply pending migrations at boot (Render's free plan has no pre-deploy step).
    RUN_MIGRATIONS: flag(true),
    // Sandbox only (CLAUDE.md §1); the gateway refuses live hosts too.
    PAYPAL_API_BASE: z.preprocess(blank, z.url().default("https://api-m.sandbox.paypal.com")),
    PAYPAL_CLIENT_ID: optionalString,
    PAYPAL_CLIENT_SECRET: optionalString,
    // Local only: talk to packages/paypal-mock (`pnpm dev:paypal-mock`) instead of the sandbox.
    PAYPAL_USE_MOCK: flag(false),
    PAYPAL_MOCK_URL: z.preprocess(blank, z.url().default("http://localhost:4010")),
    // Where PayPal sends a buyer back after approving a revise, and the base of other links.
    API_PUBLIC_URL: optionalUrl,
    // Bearer token for GET /ops. Unset: /ops answers 404.
    OPS_TOKEN: z.preprocess(blank, z.string().min(16).optional()),
    // Errors go to Sentry when set (free tier); nothing is sent otherwise.
    SENTRY_DSN: optionalUrl,
  })
  .superRefine((env, ctx) => {
    if (env.PAYPAL_USE_MOCK && env.APP_ENV !== "local") {
      ctx.addIssue({
        code: "custom",
        path: ["PAYPAL_USE_MOCK"],
        message: "The PayPal mock is for APP_ENV=local only",
      });
    }
    if (
      !env.PAYPAL_USE_MOCK &&
      env.APP_ENV !== "local" &&
      (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["PAYPAL_CLIENT_ID"],
        message: `PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required when APP_ENV=${env.APP_ENV}`,
      });
    }
    const url = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
    const key = env.DATABASE_URL_UNPOOLED ? "DATABASE_URL_UNPOOLED" : "DATABASE_URL";
    if (!url) {
      // Local development may run without a database until a module needs one.
      if (env.APP_ENV !== "local") {
        ctx.addIssue({
          code: "custom",
          path: ["DATABASE_URL_UNPOOLED"],
          message: `Required when APP_ENV=${env.APP_ENV}`,
        });
      }
      return;
    }
    if (new URL(url).hostname.includes("-pooler")) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: "Use Neon's direct (non-pooled) connection string: the host must not contain -pooler",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Fail at boot with every bad variable named, rather than at the first request.
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** The direct Postgres URL the API connects with, or undefined when running without a database. */
export function databaseUrl(env: Env): string | undefined {
  return env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
}
