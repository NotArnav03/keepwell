import { z } from "zod";

const optionalUrl = z.preprocess((v) => (v === "" ? undefined : v), z.url().optional());

const Env = z.object({
  PORTAL_URL: optionalUrl,
  // Sandbox only (CLAUDE.md §1.3); the live host is never a default.
  PAYPAL_WEB_URL: optionalUrl,
});

export interface RecoveryConfig {
  portalUrl: string;
  paypalWebUrl: string;
}

export function recoveryConfigFromEnv(source: NodeJS.ProcessEnv = process.env): RecoveryConfig {
  const env = Env.parse(source);
  return {
    portalUrl: (env.PORTAL_URL ?? "http://localhost:5174").replace(/\/$/, ""),
    paypalWebUrl: (env.PAYPAL_WEB_URL ?? "https://www.sandbox.paypal.com").replace(/\/$/, ""),
  };
}
