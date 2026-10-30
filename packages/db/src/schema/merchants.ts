import { integer, pgTable, text, unique } from "drizzle-orm/pg-core";
import { at, createdAt, id, merchantId } from "./columns.js";

// M4 owns these (onboarding, merchant auth); M1 keeps the PayPal fields.

/** The tenant root: row-level security compares `id` with the current merchant. */
export const merchants = pgTable("merchants", {
  id: id(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  mode: text({ enum: ["normal", "demo"] })
    .notNull()
    .default("normal"),
  paypalClientId: text(),
  /** AES-256-GCM, base64. Never logged, never returned by the API. */
  paypalSecretEnc: text(),
  /** Cached OAuth token, encrypted like the secret; refreshed 5 minutes before expiry (§6.1). */
  paypalTokenEnc: text(),
  paypalTokenExpiresAt: at(),
  /** The id PayPal gave our webhook registration; signature verification needs it. */
  webhookId: text(),
  keepwellSigningSecretEnc: text(),
  activePolicyVersion: integer(),
  /** Where the reconciler's 30-minute sweep left off (§6.3). */
  lastSweepAt: at(),
  createdAt: createdAt(),
});

export const merchantUsers = pgTable(
  "merchant_users",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    /** Stored lower-cased. */
    email: text().notNull(),
    /** argon2id. */
    passwordHash: text().notNull(),
    role: text({ enum: ["owner", "admin", "viewer"] })
      .notNull()
      .default("owner"),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.merchantId, t.email)],
);
