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
    // How many proxies sit in front of the API: 3 on Render (Cloudflare, edge, internal; check with
    // GET /ops/whoami). request.ip is then the client address the outermost trusted proxy appended
    // to X-Forwarded-For, which a client can't forge. 0 (local) ignores the header.
    TRUST_PROXY_HOPS: z.preprocess(blank, z.coerce.number().int().min(0).max(5).default(0)),
    // Bearer token for GET /ops. Unset: /ops answers 404.
    OPS_TOKEN: z.preprocess(blank, z.string().min(16).optional()),
    // Email (notify module). No RESEND_API_KEY: messages are logged, and still show in the Demo Inbox.
    RESEND_API_KEY: optionalString,
    RESEND_API_BASE: z.preprocess(blank, z.url().default("https://api.resend.com")),
    EMAIL_FROM: optionalString,
    // Signs unsubscribe links. Unset: a key that lives until restart (the platform logs a warning),
    // so set it anywhere links must keep working.
    UNSUBSCRIBE_TOKEN_SECRET: z.preprocess(blank, z.string().min(32).optional()),
    // Errors go to Sentry when set (free tier); nothing is sent otherwise.
    SENTRY_DSN: optionalUrl,
    // --- Subscriber surfaces (M3): sessions, subscriber MCP, Judge Mode (modules/surfaces.ts) ---
    // Unset: the agent runs in L1 only (reason chips, no model), and cancel works as always.
    ANTHROPIC_API_KEY: optionalString,
    // The daily cap for the whole deployment's model calls (#83). The credit is $5 in total.
    LLM_DAILY_BUDGET_USD: z.preprocess(blank, z.coerce.number().positive().max(5).default(0.1)),
    // The demo merchant (prod-demo's or staging's, from the seed): widget tokens and Judge Mode.
    DEMO_MERCHANT_ID: z.preprocess(blank, z.uuid().optional()),
    // Signs widget tokens for the demo merchant only (demoMerchantWidgetSecret).
    WIDGET_TOKEN_SECRET: z.preprocess(blank, z.string().min(32).optional()),
    // Signs the stream URL's read-only ticket. The sessions API mounts only when it is set.
    SESSION_TICKET_SECRET: z.preprocess(blank, z.string().min(32).optional()),
    // Signs the portal's cookie and its session tokens (the portal mounts separately).
    MAGIC_LINK_SECRET: z.preprocess(blank, z.string().min(32).optional()),
    // Signs Judge Mode's lease tokens. Judge Mode mounts only when this, the demo merchant and the
    // widget secret are all set.
    JUDGE_LEASE_SECRET: z.preprocess(blank, z.string().min(32).optional()),
    // Comma-separated origins that may call /v1/sessions directly (merchant sites with the widget,
    // the demo store). The portal and Judge Mode call through their own /v1 rewrite instead.
    WIDGET_ALLOWED_ORIGINS: z.preprocess(
      blank,
      z
        .string()
        .transform((v) =>
          v
            .split(",")
            .map((o) => o.trim())
            .filter((o) => o !== ""),
        )
        .pipe(z.array(z.url()))
        .optional(),
    ),
    // The portal's origin: emailed sign-in links, and the discovery document's "get a token" link.
    PORTAL_URL: optionalUrl,
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
