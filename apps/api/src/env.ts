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
    // Base64-encoded, 32-byte AES-256-GCM key; encrypts per-merchant PayPal secrets at rest.
    PAYPAL_CREDENTIALS_ENCRYPTION_KEY: optionalString,
    // Local only: talk to packages/paypal-mock (`pnpm dev:paypal-mock`) instead of the sandbox.
    PAYPAL_USE_MOCK: flag(false),
    PAYPAL_MOCK_URL: z.preprocess(blank, z.url().default("http://localhost:4010")),
    // Merchant login signs short-lived HttpOnly cookies; use a random secret unique per environment.
    SESSION_SECRET: optionalString,
    // Exact origin of the dashboard; used for credentialed CORS and CSRF origin checks.
    DASHBOARD_URL: optionalUrl,
    // Where PayPal sends a buyer back after approving a revise, and the base of other links.
    API_PUBLIC_URL: optionalUrl,
    // Bearer token for GET /ops. Unset: /ops answers 404.
    OPS_TOKEN: z.preprocess(blank, z.string().min(16).optional()),
    // Errors go to Sentry when set (free tier); nothing is sent otherwise.
    SENTRY_DSN: optionalUrl,
  })
  .superRefine((env, ctx) => {
    if (env.SESSION_SECRET && Buffer.byteLength(env.SESSION_SECRET, "utf8") < 32) {
      ctx.addIssue({
        code: "custom",
        path: ["SESSION_SECRET"],
        message: "SESSION_SECRET must be at least 32 bytes",
      });
    }
    if (env.APP_ENV !== "local" && !env.SESSION_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["SESSION_SECRET"],
        message: `Required when APP_ENV=${env.APP_ENV}`,
      });
    }
    if (env.APP_ENV !== "local" && !env.DASHBOARD_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["DASHBOARD_URL"],
        message: `Required when APP_ENV=${env.APP_ENV}`,
      });
    }
    if (env.PAYPAL_CREDENTIALS_ENCRYPTION_KEY) {
      const key = Buffer.from(env.PAYPAL_CREDENTIALS_ENCRYPTION_KEY, "base64");
      if (
        key.length !== 32 ||
        key.toString("base64").replace(/=+$/, "") !== env.PAYPAL_CREDENTIALS_ENCRYPTION_KEY.replace(/=+$/, "")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["PAYPAL_CREDENTIALS_ENCRYPTION_KEY"],
          message: "Must be base64 encoding of exactly 32 bytes",
        });
      }
    }
    if (!env.PAYPAL_USE_MOCK && env.APP_ENV !== "local" && !env.PAYPAL_CREDENTIALS_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["PAYPAL_CREDENTIALS_ENCRYPTION_KEY"],
        message: `Required when APP_ENV=${env.APP_ENV} and PayPal mock is disabled`,
      });
    }
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
