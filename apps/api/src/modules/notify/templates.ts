import type { Money, NotificationContent } from "@keepwell/contracts";

// English templates. Every fact (amount, date, link) comes from the payload; nothing is computed
// and no model writes any of it (CLAUDE.md §3: offer terms render from objects).

export interface RenderedMessage {
  subject: string;
  bodyText: string;
}

const CURRENCY_SYMBOL: Readonly<Record<string, string>> = { USD: "$", EUR: "€", GBP: "£" };

/** "12.00" USD → "$12.00". Money is a decimal string, so no float ever touches it. */
export function formatMoney(money: Money): string {
  const symbol = CURRENCY_SYMBOL[money.currency];
  return symbol ? `${symbol}${money.value}` : `${money.value} ${money.currency}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** "2026-11-03T09:00:00Z" → "3 November 2026" (UTC; the payload says when, not the server's locale). */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? ""} ${String(d.getUTCFullYear())}`;
}

const greeting = (firstName: string | null): string => (firstName ? `Hi ${firstName},` : "Hi there,");

const retryLine = (retryAt: string | null): string =>
  retryAt ? `PayPal will try the payment again on ${formatDate(retryAt)}.` : "";

function compose(firstName: string | null, paragraphs: string[], unsubscribe: string): string {
  const body = paragraphs.filter((p) => p !== "").join("\n\n");
  return `${greeting(firstName)}\n\n${body}\n\nThe team\n\n--\nDon't want these emails? Unsubscribe: ${unsubscribe}\n`;
}

/** Renders subject and plain-text body. `unsubscribeUrl` is already signed for this recipient. */
export function renderTemplate(content: NotificationContent, unsubscribeUrl: string): RenderedMessage {
  switch (content.template) {
    case "dunning.update_payment_method": {
      const p = content.payload;
      return {
        subject: `Action needed: update your payment method for ${p.planName}`,
        bodyText: compose(
          p.firstName,
          [
            `We couldn't collect ${formatMoney(p.amount)} for your ${p.planName} subscription.`,
            retryLine(p.retryAt),
            `To keep your subscription active, update your payment method in PayPal: ${p.updatePaymentUrl}`,
          ],
          unsubscribeUrl,
        ),
      };
    }
    case "dunning.account_restricted": {
      const p = content.payload;
      return {
        subject: `Your PayPal account needs attention to keep ${p.planName}`,
        bodyText: compose(
          p.firstName,
          [
            `We couldn't collect ${formatMoney(p.amount)} for your ${p.planName} subscription because your PayPal account has a restriction.`,
            `PayPal can resolve this with you directly: ${p.resolutionUrl}`,
          ],
          unsubscribeUrl,
        ),
      };
    }
    case "dunning.sending_limit": {
      const p = content.payload;
      const smaller = p.smallerPlan
        ? `If it helps, you can switch to ${p.smallerPlan.name} at ${formatMoney(p.smallerPlan.price)}. Just reply to this email and we'll set it up.`
        : "";
      return {
        subject: `Your ${p.planName} payment hit a PayPal limit`,
        bodyText: compose(
          p.firstName,
          [
            `We couldn't collect ${formatMoney(p.amount)} for your ${p.planName} subscription because the payment went over a limit on your PayPal account.`,
            retryLine(p.retryAt),
            smaller,
          ],
          unsubscribeUrl,
        ),
      };
    }
    case "dunning.generic": {
      const p = content.payload;
      return {
        subject: `We couldn't process your ${p.planName} payment`,
        bodyText: compose(
          p.firstName,
          [
            `We couldn't collect ${formatMoney(p.amount)} for your ${p.planName} subscription.`,
            retryLine(p.retryAt),
            `You can find help here: ${p.helpUrl}`,
          ],
          unsubscribeUrl,
        ),
      };
    }
    case "dunning.reactivate": {
      const p = content.payload;
      return {
        subject: `Your ${p.planName} subscription is paused`,
        bodyText: compose(
          p.firstName,
          [
            `Your ${p.planName} subscription is no longer active because we couldn't collect payment.`,
            `You can bring it back whenever you like: ${p.portalUrl}`,
          ],
          unsubscribeUrl,
        ),
      };
    }
    case "winback.ask": {
      const p = content.payload;
      return {
        subject: `Mind telling us what happened with ${p.planName}?`,
        bodyText: compose(
          p.firstName,
          [
            `We noticed your ${p.planName} subscription ended. We'd really like to know why, in one question: ${p.replyUrl}`,
            p.resubscribeUrl
              ? `If you'd like to come back, you can subscribe again here: ${p.resubscribeUrl}`
              : "",
          ],
          unsubscribeUrl,
        ),
      };
    }
  }
}
