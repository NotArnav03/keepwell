import { z } from "zod";

// Shared primitives from CONTRACTS.md §1 "shared". Platform types (#4) build on these too.

export const Money = z.object({
  value: z.string().regex(/^\d+\.\d{2}$/),
  currency: z.string().length(3),
});
export type Money = z.infer<typeof Money>;

// UTC only ("Z" suffix): offsets would make string comparison of due times unreliable.
export const IsoDateTime = z.iso.datetime();
export type IsoDateTime = z.infer<typeof IsoDateTime>;

export const Id = z.uuid();

export const ReasonCategory = z.enum([
  "price",
  "low_usage",
  "missing_feature",
  "quality_issue",
  "temporary",
  "switching_competitor",
  "payment_problem",
  "other",
  "unknown",
]);
export type ReasonCategory = z.infer<typeof ReasonCategory>;

/** Where a subscriber reached us: the widget on the merchant's site, our portal, or their own AI agent. */
export const Channel = z.enum(["widget", "portal", "subscriber_agent"]);
export type Channel = z.infer<typeof Channel>;

export const BillingInterval = z.object({
  unit: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]),
  count: z.number().int().min(1),
});
export type BillingInterval = z.infer<typeof BillingInterval>;
