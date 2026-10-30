import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { ActionOrigin, ActionState, ActionType, Actor } from "@keepwell/contracts";
import { at, createdAt, id, merchantId, enumText } from "./columns.js";
import { merchants } from "./merchants.js";
import { subscriptions } from "./billing.js";

// M1: webhooks, domain events, Actions, scheduled resumes, the audit log and the judge pool.

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    /** PayPal's event id; a duplicate delivery hits the unique key and is answered 200 (§6.2). */
    eventId: text().notNull(),
    eventType: text().notNull(),
    /** Verbatim: signature verification needs the exact bytes. */
    rawBody: text().notNull(),
    headers: jsonb().notNull(),
    verification: text({ enum: ["VERIFIED", "REJECTED", "SIMULATED"] }),
    status: text({ enum: ["received", "processed", "rejected", "failed"] })
      .notNull()
      .default("received"),
    attempts: integer().notNull().default(0),
    error: text(),
    receivedAt: createdAt(),
    processedAt: at(),
  },
  (t) => [unique().on(t.merchantId, t.eventId), index().on(t.status, t.receivedAt)],
);

/** Every emitted domain event; feeds the dispatch jobs and the dashboard's live feed. */
export const domainEvents = pgTable(
  "domain_events",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    type: text().notNull(),
    payload: jsonb().notNull(),
    simulated: boolean().notNull().default(false),
    occurredAt: createdAt(),
  },
  (t) => [index().on(t.merchantId, t.occurredAt)],
);

export const actions = pgTable(
  "actions",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    /** null only for create_plan. */
    subscriptionId: uuid().references(() => subscriptions.id),
    type: enumText(ActionType.options).notNull(),
    params: jsonb().notNull(),
    state: enumText(ActionState.options).notNull().default("PENDING"),
    origin: enumText(ActionOrigin.options).notNull(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: at(),
    idempotencyKey: text(),
    /** PayPal-Request-Id, where the endpoint supports one (§6.1): the Action id. */
    paypalRequestId: text(),
    paypalDebugIds: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    approveUrl: text(),
    result: jsonb(),
    error: jsonb(),
    simulated: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: at().notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.merchantId, t.idempotencyKey),
    index().on(t.subscriptionId, t.state),
    // The worker's queue: what is due next.
    index().on(t.state, t.nextAttemptAt),
  ],
);

export const scheduledResumes = pgTable(
  "scheduled_resumes",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    subscriptionId: uuid()
      .notNull()
      .references(() => subscriptions.id),
    dueAt: at().notNull(),
    /** The activate Action, once created. */
    actionId: uuid().references(() => actions.id),
    status: text({ enum: ["scheduled", "done", "cancelled"] })
      .notNull()
      .default("scheduled"),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.status, t.dueAt)],
);

/** Append-only and hash-chained per merchant (§6.16). Triggers refuse UPDATE, DELETE and TRUNCATE. */
export const auditLog = pgTable(
  "audit_log",
  {
    merchantId: merchantId().references(() => merchants.id),
    seq: bigint({ mode: "number" }).notNull(),
    at: createdAt(),
    actor: enumText(Actor.options).notNull(),
    kind: text().notNull(),
    subjectIds: jsonb().notNull(),
    payload: jsonb().notNull(),
    simulated: boolean().notNull().default(false),
    prevHash: text().notNull(),
    hash: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.merchantId, t.seq] })],
);

/** Pre-approved sandbox subscriptions that Judge Mode leases out (§6.17). */
export const poolSubscriptions = pgTable(
  "pool_subscriptions",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    subscriptionId: uuid()
      .notNull()
      .unique()
      .references(() => subscriptions.id),
    state: text({ enum: ["available", "leased", "consumed"] })
      .notNull()
      .default("available"),
    leasedUntil: at(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.merchantId, t.state)],
);
