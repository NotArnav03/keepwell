import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    /** The win-back reply this insight came from; the replies table (winback module) owns it. */
    replyId: uuid(),
    source: text({ enum: ["session", "winback_reply"] })
      .notNull()
      .default("session"),
    reason: enumText(ReasonCategory.options).notNull(),
    subReason: text(),
    featureRequests: text().array(),
    competitor: text(),
    sentiment: text({ enum: ["positive", "neutral", "negative"] }),
    /** Redacted. */
    quote: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.merchantId, t.createdAt),
    // One insight per source, so insights.extract is idempotent even if two workers race.
    uniqueIndex().on(t.sessionId),
    uniqueIndex().on(t.replyId),
  ],
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
