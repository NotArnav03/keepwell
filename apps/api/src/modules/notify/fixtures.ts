import type { NotificationContent, TemplateId } from "@keepwell/contracts";

// Fictional Pantry Plan data, one valid content object per template, for the notify tests.

const usd = (value: string) => ({ value, currency: "USD" });

export const CONTENT: Record<TemplateId, NotificationContent> = {
  "dunning.update_payment_method": {
    template: "dunning.update_payment_method",
    payload: {
      firstName: "Maya",
      planName: "Standard",
      amount: usd("12.00"),
      retryAt: "2026-11-03T09:00:00.000Z",
      updatePaymentUrl: "https://www.sandbox.paypal.com/myaccount/autopay/",
    },
  },
  "dunning.account_restricted": {
    template: "dunning.account_restricted",
    payload: {
      firstName: null,
      planName: "Standard",
      amount: usd("12.00"),
      resolutionUrl: "https://www.sandbox.paypal.com/resolution",
    },
  },
  "dunning.sending_limit": {
    template: "dunning.sending_limit",
    payload: {
      firstName: "Raj",
      planName: "Standard",
      amount: usd("12.00"),
      retryAt: null,
      smallerPlan: { name: "Lite", price: usd("6.00") },
    },
  },
  "dunning.generic": {
    template: "dunning.generic",
    payload: {
      firstName: "Maya",
      planName: "Standard",
      amount: { value: "9.50", currency: "CAD" },
      retryAt: "2026-12-01T00:00:00.000Z",
      helpUrl: "https://pantryplan.example/help",
    },
  },
  "dunning.reactivate": {
    template: "dunning.reactivate",
    payload: { firstName: "Maya", planName: "Standard", portalUrl: "https://portal.pantryplan.example/back" },
  },
  "winback.ask": {
    template: "winback.ask",
    payload: {
      firstName: "Raj",
      planName: "Lite",
      replyUrl: "https://portal.pantryplan.example/why",
      resubscribeUrl: "https://pantryplan.example/resubscribe",
    },
  },
};
