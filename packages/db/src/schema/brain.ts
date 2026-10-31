import { date, integer, jsonb, numeric, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
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

/** Global, not per merchant: the daily budget guard (#26) caps the whole deployment. */
export const llmUsage = pgTable(
  "llm_usage",
  {
    day: date({ mode: "string" }).notNull(),
    feature: text().notNull(),
    model: text().notNull(),
    tokensIn: integer().notNull().default(0),
    tokensOut: integer().notNull().default(0),
    /** US dollars. Six decimals, because one call costs a fraction of a cent. */
    costUsd: numeric({ precision: 12, scale: 6 }).notNull().default("0"),
  },
  (t) => [primaryKey({ columns: [t.day, t.feature, t.model] })],
);
