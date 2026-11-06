import { randomBytes } from "node:crypto";
import type { Env } from "../../env.js";

export interface NotifyConfig {
  resendApiKey: string | undefined;
  resendApiBase: string;
  emailFrom: string;
  unsubscribeSecret: string;
  /** Origin the unsubscribe link points at, without a trailing slash. */
  publicUrl: string;
}

const DEFAULT_FROM = "Keepwell <noreply@keepwell.example>";

/**
 * The module's settings from the platform's validated Env (src/env.ts). Without a signing secret
 * (allowed only in APP_ENV=local) a random one is used, so old links stop working after a restart.
 */
export function notifyConfigFromEnv(
  env: Pick<Env, "RESEND_API_KEY" | "RESEND_API_BASE" | "EMAIL_FROM" | "UNSUBSCRIBE_TOKEN_SECRET">,
  publicUrl: string,
): NotifyConfig {
  return {
    resendApiKey: env.RESEND_API_KEY,
    resendApiBase: env.RESEND_API_BASE.replace(/\/+$/, ""),
    emailFrom: env.EMAIL_FROM ?? DEFAULT_FROM,
    unsubscribeSecret: env.UNSUBSCRIBE_TOKEN_SECRET ?? randomBytes(32).toString("hex"),
    publicUrl: publicUrl.replace(/\/+$/, ""),
  };
}
