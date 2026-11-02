import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { Channel, FallbackLevel, ReasonCategory, SessionOutcome, SessionState } from "@keepwell/contracts";
import { at, createdAt, id, merchantId, enumText } from "./columns.js";
import { merchants } from "./merchants.js";
import { subscriptions } from "./billing.js";

// M3: cancel sessions, their stream log, and delegations to subscribers' own agents.

/** The `Session` record from @keepwell/contracts (surfaces/sessions.ts). */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    subscriptionId: uuid()
      .notNull()
      .references(() => subscriptions.id),
    channel: enumText(Channel.options).notNull(),
    state: enumText(SessionState.options).notNull().default("open"),
    fallbackLevel: enumText(FallbackLevel.options).notNull().default("L0"),
    reason: enumText(ReasonCategory.options).notNull().default("unknown"),
    presentedOfferId: text(),
    policyVersion: integer().notNull(),
    outcome: enumText(SessionOutcome.options),
    simulated: boolean().notNull().default(false),
    startedAt: createdAt(),
    closedAt: at(),
  },
  (t) => [index().on(t.merchantId, t.startedAt), index().on(t.subscriptionId)],
);

/** Every SSE frame of a session, so a reconnect with Last-Event-ID replays from `seq` (#74). */
export const sessionEvents = pgTable(
  "session_events",
  {
    merchantId: merchantId().references(() => merchants.id),
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id),
    seq: integer().notNull(),
    event: jsonb().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

export const delegations = pgTable("delegations", {
  id: id(),
  merchantId: merchantId().references(() => merchants.id),
  subscriptionId: uuid()
    .notNull()
    .references(() => subscriptions.id),
  scopes: text().array().notNull(),
  /** sha256 of the delegation token; the token itself is shown once and never stored. */
  tokenHash: text().notNull().unique(),
  expiresAt: at().notNull(),
  revokedAt: at(),
  createdAt: createdAt(),
});
