import { bigint, index, integer, jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { at, createdAt, id, merchantId } from "./columns.js";
import { merchants } from "./merchants.js";
import { sessions } from "./surfaces.js";

// M2: policy versions, the agent's messages and offers, and the LLM budget.

/** Immutable versions (#80's PolicyStore). Triggers refuse UPDATE, DELETE and TRUNCATE. */
export const policies = pgTable(
  "policies",
  {
    merchantId: merchantId().references(() => merchants.id),
    version: integer().notNull(),
    document: jsonb().notNull(),
    /** A merchant user's email or name, or "system" for the seeded first version. */
    publishedBy: text().notNull(),
    changeNote: text(),
    publishedAt: createdAt(),
  },
  // A second publish of the same version fails here; PolicyStore turns that into version_conflict.
  (t) => [primaryKey({ columns: [t.merchantId, t.version] })],
);

export const messages = pgTable("messages", {
  id: id(),
  merchantId: merchantId().references(() => merchants.id),
  sessionId: uuid()
    .notNull()
    .references(() => sessions.id),
  role: text({ enum: ["subscriber", "agent"] }).notNull(),
  /** Redacted before it is stored. */
  text: text().notNull(),
  model: text(),
  tokensIn: integer(),
  tokensOut: integer(),
  latencyMs: integer(),
  createdAt: createdAt(),
});

export const offers = pgTable("offers", {
  id: id(),
  merchantId: merchantId().references(() => merchants.id),
  sessionId: uuid()
    .notNull()
    .references(() => sessions.id),
  menuSnapshot: jsonb().notNull(),
  pickedOffer: jsonb(),
  decision: jsonb(),
  consent: jsonb(),
  status: text({ enum: ["presented", "accepted", "declined", "refused_at_accept"] })
    .notNull()
    .default("presented"),
  createdAt: createdAt(),
  answeredAt: at(),
});

/**
 * One row per model call, for the LLM budget guard (#26, #83): today's spend against
 * LLM_DAILY_BUDGET_USD, and each session's model time and tokens. Deployment-wide, not per
 * merchant, so it has no merchant_id and no row-level security. `session_id` has no foreign key:
 * this is bookkeeping, written after the call, and must never fail because a session row moved.
 */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: id(),
    at: createdAt(),
    sessionId: uuid(),
    purpose: text().notNull(),
    model: text().notNull(),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    cacheReadTokens: integer().notNull(),
    cacheWriteTokens: integer().notNull(),
    /** Whole nano-dollars (1e-9 USD): every list price is an integer per token at this scale. */
    costNanoUsd: bigint({ mode: "number" }).notNull(),
    durationMs: integer().notNull(),
  },
  (t) => [index().on(t.at), index().on(t.sessionId)],
);
