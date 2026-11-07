import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
    state: text({ enum: ["open", "recovered", "suspended", "closed"] })
      .notNull()
      .default("open"),
    recoveredValue: amount(),
    recoveredCurrency: currency(),
    /** The balance a capture_outstanding Action was asked to collect. */
    outstandingValue: amount(),
    outstandingCurrency: currency(),
    /** The queued dunning message (notifications.id); no FK, the outbox table is M5's other module. */
    notificationId: uuid(),
    captureActionId: uuid().references(() => actions.id),
    simulated: boolean().notNull().default(false),
    openedAt: createdAt(),
    updatedAt: createdAt(),
    /** When it left open/suspended (recovered or closed). */
    closedAt: at(),
  },
  (t) => [
    index().on(t.merchantId, t.state),
    // One live case per subscription: a concurrent duplicate insert fails instead of doubling up.
    uniqueIndex("dunning_cases_one_active_per_subscription")
      .on(t.subscriptionId)
      .where(sql`${t.state} in ('open', 'suspended')`),
  ],
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
    // Matches the contract's NotificationStatus. While "sending", dueAt doubles as the lease expiry.
    status: text({ enum: ["queued", "sending", "sent", "failed", "suppressed"] })
      .notNull()
      .default("queued"),
    suppressedBecause: text({ enum: ["frequency_cap", "unsubscribed", "superseded"] }),
    attempts: integer().notNull().default(0),
    /** { code, message } of the last provider failure. */
    lastError: jsonb(),
    simulated: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.status, t.dueAt), index().on(t.merchantId, t.to, t.sentAt)],
);

// Opt-outs from the unsubscribe link, per merchant. The address is not stored: emailHash is
// sha256 of the trimmed, lower-cased address, the same value the link is signed over.
export const emailUnsubscribes = pgTable(
  "email_unsubscribes",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    emailHash: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.merchantId, t.emailHash)],
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
