import { z } from "zod";

// .env.example ships keys with empty values; treat those as unset.
const unsetIfEmpty = (v: unknown): unknown => (v === "" ? undefined : v);

const NotifyEnv = z.object({
  // Unset means no real email: the console provider logs instead (local development, demos).
  RESEND_API_KEY: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
  RESEND_API_BASE: z.preprocess(unsetIfEmpty, z.url().default("https://api.resend.com")),
  EMAIL_FROM: z.preprocess(unsetIfEmpty, z.string().min(3).default("Keepwell <noreply@keepwell.example>")),
  // Signs unsubscribe links. Long and random, different per environment.
  UNSUBSCRIBE_TOKEN_SECRET: z.string().min(32),
  API_PUBLIC_URL: z.preprocess(unsetIfEmpty, z.url().default("http://localhost:3000")),
});

export interface NotifyConfig {
  resendApiKey: string | undefined;
  resendApiBase: string;
  emailFrom: string;
  unsubscribeSecret: string;
  /** Origin the unsubscribe link points at, without a trailing slash. */
  publicUrl: string;
}

export function loadNotifyConfig(source: NodeJS.ProcessEnv = process.env): NotifyConfig {
  const parsed = NotifyEnv.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid notification environment:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  return {
    resendApiKey: env.RESEND_API_KEY,
    resendApiBase: env.RESEND_API_BASE.replace(/\/+$/, ""),
    emailFrom: env.EMAIL_FROM,
    unsubscribeSecret: env.UNSUBSCRIBE_TOKEN_SECRET,
    publicUrl: env.API_PUBLIC_URL.replace(/\/+$/, ""),
  };
}
