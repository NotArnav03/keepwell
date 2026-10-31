import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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

// Addresses that opted out through the unsubscribe link, per merchant.
export const emailUnsubscribes = pgTable(
  "email_unsubscribes",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    email: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.merchantId, t.email)],
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
