import { z } from "zod";

// Only what the API shell needs today. Each module adds its own variables here as it lands,
// and they must also be listed in .env.example.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["local", "staging", "prod-demo"]).default("local"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Set by Render on every deploy; shown on /healthz so we can tell which build is live.
  RENDER_GIT_COMMIT: z.string().optional(),
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
