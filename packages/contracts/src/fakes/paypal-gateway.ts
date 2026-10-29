import type { ListSubscriptionsQuery, PayPalGateway } from "../platform/interfaces.js";
import { PayPalGatewayError, PayPalSubscription, type Page } from "../platform/paypal.js";

const PAGE_SIZE = 20;

/**
 * In-memory PayPalGateway for module tests. It works at the interface level; packages/paypal-mock
 * is the HTTP-level fake for testing the real gateway.
 */
export class FakePayPalGateway implements PayPalGateway {
  readonly calls: { method: "getSubscription" | "listSubscriptions"; merchantId: string }[] = [];
  private readonly subscriptions = new Map<string, PayPalSubscription>();
  private pendingErrors: PayPalGatewayError[] = [];

  /** Adds or replaces a subscription as PayPal would return it. */
  put(merchantId: string, subscription: PayPalSubscription): void {
    const parsed = PayPalSubscription.parse(subscription);
    this.subscriptions.set(`${merchantId}/${parsed.id}`, parsed);
  }

  /** The next call throws this error, e.g. to test retries, fallbacks or "not found". */
  failNext(error: PayPalGatewayError): void {
    this.pendingErrors.push(error);
  }

  getSubscription(merchantId: string, paypalSubscriptionId: string): Promise<PayPalSubscription> {
    return new Promise((resolve) => {
      this.calls.push({ method: "getSubscription", merchantId });
      this.throwPendingError();
      const found = this.subscriptions.get(`${merchantId}/${paypalSubscriptionId}`);
      if (!found) {
        throw new PayPalGatewayError("not_found", `Subscription ${paypalSubscriptionId} not found`, {
          status: 404,
          issue: "RESOURCE_NOT_FOUND",
          debugId: null,
        });
      }
      // A copy, so a caller mutating the result can't change the fake's state.
      resolve(structuredClone(found));
    });
  }

  listSubscriptions(merchantId: string, query: ListSubscriptionsQuery): Promise<Page<PayPalSubscription>> {
    return new Promise((resolve) => {
      this.calls.push({ method: "listSubscriptions", merchantId });
      this.throwPendingError();
      const after = query.statusUpdatedAfter ? Date.parse(query.statusUpdatedAfter) : null;
      const matching = [...this.subscriptions.entries()]
        .filter(([key]) => key.startsWith(`${merchantId}/`))
        .map(([, sub]) => sub)
        .filter((sub) => !query.planIds || query.planIds.includes(sub.plan_id))
        .filter(
          (sub) =>
            after === null ||
            (sub.status_update_time !== undefined && Date.parse(sub.status_update_time) > after),
        );
      const page = query.page ?? 1;
      const totalPages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
      resolve({
        items: structuredClone(matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)),
        page,
        totalItems: matching.length,
        totalPages,
      });
    });
  }

  private throwPendingError(): void {
    const error = this.pendingErrors.shift();
    if (error) throw error;
  }
}
