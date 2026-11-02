import { index, integer, jsonb, pgTable, text, unique } from "drizzle-orm/pg-core";
import { SubscriptionStatus } from "@keepwell/contracts";
import { amount, at, createdAt, currency, id, merchantId, enumText } from "./columns.js";
import { merchants } from "./merchants.js";

// M1: our read model of PayPal. Rebuilt from a GET after every webhook or sweep (§6.2, §6.3).

const intervalUnit = () => text({ enum: ["DAY", "WEEK", "MONTH", "YEAR"] });

export const plans = pgTable(
  "plans",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    paypalPlanId: text().notNull(),
    productId: text().notNull(),
    name: text().notNull(),
    intervalUnit: intervalUnit().notNull(),
    intervalCount: integer().notNull(),
    priceValue: amount().notNull(),
    priceCurrency: currency().notNull(),
    status: text({ enum: ["CREATED", "ACTIVE", "INACTIVE"] }).notNull(),
    syncedAt: at().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.merchantId, t.paypalPlanId)],
);

/** Mirrors SubscriptionSnapshot; `snapshot` keeps PayPal's raw JSON for the diff (§6.2). */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    merchantId: merchantId().references(() => merchants.id),
    paypalSubscriptionId: text().notNull(),
    paypalPlanId: text().notNull(),
    planName: text().notNull(),
    status: enumText(SubscriptionStatus.options).notNull(),
    intervalUnit: intervalUnit().notNull(),
    intervalCount: integer().notNull(),
    priceValue: amount().notNull(),
    priceCurrency: currency().notNull(),
    /** A discount's fixed_price override; null when paying the plan price. */
    overrideValue: amount(),
    overrideCurrency: currency(),
    startedAt: at().notNull(),
    nextBillingTime: at(),
    lastPaymentValue: amount(),
    lastPaymentCurrency: currency(),
    lastPaymentAt: at(),
    outstandingValue: amount(),
    outstandingCurrency: currency(),
    failedPaymentsCount: integer().notNull().default(0),
    lastFailureReason: text(),
    lastFailureAt: at(),
    nextRetryTime: at(),
    /** sha256 of the lower-cased email: enough to match a portal login, without storing it. */
    subscriberEmailHash: text(),
    subscriberFirstName: text(),
    snapshot: jsonb().notNull(),
    syncedAt: at().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.merchantId, t.paypalSubscriptionId),
    index().on(t.merchantId, t.status),
    index().on(t.merchantId, t.subscriberEmailHash),
  ],
);
