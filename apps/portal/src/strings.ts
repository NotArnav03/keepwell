import type { DelegationScope } from "@keepwell/contracts";

// The portal's copy in one place. Plain words, no guilt, no urgency.

export const text = {
  signInTitle: "Manage your subscription",
  signInIntro: "Enter the email address PayPal has for your subscription and we'll send you a sign-in link.",
  emailLabel: "Email address",
  sendLink: "Email me a sign-in link",
  sending: "Sending…",
  linkSent:
    "If that address has a subscription here, a sign-in link is on its way. It works once and expires in 15 minutes.",
  linkExpired: "That link has expired or was already used. Request a new one below.",
  tooMany: "Too many requests. Please wait a few minutes and try again.",
  error: "Something went wrong. Please try again.",
  unreachable: "We can't reach our servers right now. You can still cancel directly in PayPal.",
  cancelInPayPal: "Cancel in PayPal",
  loading: "Loading your subscriptions…",
  signedInTitle: "Your subscriptions",
  signOut: "Sign out",
  none: "No subscriptions found for this address.",
  manage: "Manage or cancel",
  managing: "Managing this subscription below",
  nextPayment: "Next payment",
  assistantTitle: "Let an AI assistant manage this",
  assistantIntro:
    "Give your own assistant a private access token. You choose what it may do, it stops working after 7 days, and you can revoke it here at any time.",
  scopesLegend: "What may it do?",
  create: "Create access token",
  creating: "Creating…",
  tokenTitle: "Your access token",
  tokenWarning:
    "This is the only time it's shown. Copy it now and keep it private: anyone who has it can do what you allowed until it expires.",
  tokenLabel: "Access token",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Couldn't copy automatically. Select the token and copy it.",
  saved: "I've saved it",
  existingTitle: "Active access tokens",
  noneActive: "No active access tokens.",
  revoke: "Revoke",
  revoked: "Access token revoked.",
  canDo: "Can",
  expires: "expires",
  scopes: {
    read: "See my plan and billing dates",
    cancel: "Cancel my subscription",
    accept_offer: "Accept offers that keep me subscribed",
  } satisfies Record<DelegationScope, string>,
};
