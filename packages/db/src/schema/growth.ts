import { boolean, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { ReasonCategory } from "@keepwell/contracts";
import { amount, at, createdAt, currency, id, merchantId, enumText } from "./columns.js";
import { merchants } from "./merchants.js";
import { subscriptions } from "./billing.js";
import { actions } from "./platform.js";
import { sessions } from "./surfaces.js";

// M5: recovery, notifications, insights and insight-to-action. Om shapes the details (#42).

export const dunningCases = pgTable(
  "dunning_cases",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    subscriptionId: uuid()
      .notNull()
      .references(() => subscriptions.id),
    reasonCode: text().notNull(),
    failedCount: integer().notNull(),
    nextRetryTime: at(),
    playbook: text().notNull(),
    state: text({ enum: ["open", "recovered", "lost", "cancelled"] })
      .notNull()
      .default("open"),
    recoveredValue: amount(),
    recoveredCurrency: currency(),
    openedAt: createdAt(),
    closedAt: at(),
  },
  (t) => [index().on(t.merchantId, t.state)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    subscriptionId: uuid().references(() => subscriptions.id),
    to: text().notNull(),
    channel: text({ enum: ["email", "demo_inbox"] }).notNull(),
    template: text().notNull(),
    payload: jsonb().notNull(),
    dueAt: at().notNull(),
    sentAt: at(),
    providerId: text(),
    status: text({ enum: ["scheduled", "sent", "failed", "cancelled", "suppressed"] })
      .notNull()
      .default("scheduled"),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.status, t.dueAt)],
);

export const insights = pgTable(
  "insights",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    sessionId: uuid().references(() => sessions.id),
    reason: enumText(ReasonCategory.options).notNull(),
    subReason: text(),
    featureRequests: text().array(),
    competitor: text(),
    sentiment: text({ enum: ["positive", "neutral", "negative"] }),
    /** Redacted. */
    quote: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.merchantId, t.createdAt)],
);

export const insightActions = pgTable("insight_actions", {
  id: id(),
  merchantId: merchantId().references(() => merchants.id),
  kind: text().notNull(),
  params: jsonb().notNull(),
  estimate: jsonb(),
  state: text({ enum: ["proposed", "approved", "rejected", "executed"] })
    .notNull()
    .default("proposed"),
  actionId: uuid().references(() => actions.id),
  createdAt: createdAt(),
  decidedAt: at(),
});

/**
 * One row per cancellation made inside PayPal (ARCHITECTURE.md 6.10). `dueAt` is the durable timer:
 * the winback.start job is only its trigger, and the due-work sweep re-fires pending rows.
 * The unique key is what makes "one message per cancellation" hold under duplicate events.
 */
export const winbackCases = pgTable(
  "winback_cases",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    subscriptionId: uuid()
      .notNull()
      .references(() => subscriptions.id),
    state: text({ enum: ["pending", "sent", "replied", "skipped"] })
      .notNull()
      .default("pending"),
    /** Set when state is "skipped": no_longer_cancelled, session_saved, no_email, ... */
    skipReason: text(),
    dueAt: at().notNull(),
    sentAt: at(),
    /** The Notifier outbox row. No foreign key: the notify module owns that table's shape. */
    notificationId: uuid(),
    simulated: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.merchantId, t.subscriptionId), index().on(t.state, t.dueAt)],
);

/** The one-question answer from the exit-interview page. Raw text; the extractor redacts it. */
export const winbackReplies = pgTable(
  "winback_replies",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    caseId: uuid()
      .notNull()
      .references(() => winbackCases.id),
    subscriptionId: uuid()
      .notNull()
      .references(() => subscriptions.id),
    text: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.caseId)],
);
