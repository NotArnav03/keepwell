import type { ReasonCategory } from "@keepwell/contracts";

// English UI copy in one place, so hi and es (#40) are a table, not a hunt. No guilt, no urgency.

export const en = {
  title: "Manage subscription",
  cancelNow: "Cancel now",
  cancelling: "Cancelling…",
  close: "Close",
  greeting:
    "Sorry to see you go. Before you do, can I ask what's prompting it? You can also just cancel with the button above.",
  placeholder: "Tell us what's going on",
  send: "Send",
  accept: "Yes, do that",
  decline: "No thanks",
  keep: "Keep my subscription",
  applying: "Applying the change in PayPal…",
  awaitingPayPal: "Waiting for your approval in PayPal…",
  openPayPal: "Open PayPal",
  offerFailed: "That change didn't go through, so nothing was changed. You can cancel or keep your plan.",
  cancelFailed: "We couldn't cancel automatically. You can cancel directly in PayPal:",
  cancelInPayPal: "Cancel in PayPal",
  offline: "We can't reach our servers right now. You can still cancel directly in PayPal:",
  offlineSupport: "Questions? Contact",
  limitReached: "That's all the messages for this conversation. You can still cancel or keep your plan.",
  error: "Something went wrong. Cancel still works.",
  chipsPrompt: "What's the main reason?",
  reasons: {
    price: "It's too expensive",
    low_usage: "I don't use it enough",
    missing_feature: "It's missing something I need",
    quality_issue: "Quality problems",
    temporary: "I need a break",
    switching_competitor: "I'm switching to something else",
    payment_problem: "Payment problems",
    other: "Something else",
    unknown: "Something else",
  } satisfies Record<ReasonCategory, string>,
};

export type Strings = typeof en;
