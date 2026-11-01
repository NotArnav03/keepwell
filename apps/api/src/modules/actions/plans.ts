import {
  parseActionParams,
  type ActionParamsOf,
  type ActionType,
  type Money,
  type PayPalSubscription,
  type SubscriptionSnapshot,
  type SubscriptionStatus,
} from "@keepwell/contracts";
import type { MutationResult } from "../paypal/client.js";
import { toMoney } from "../paypal/money.js";

// How each Action type runs against PayPal (ARCHITECTURE.md §6.1 idempotency table), kept apart
// from the engine's state machine so every type gets the same locking, retries, audit and events.
//
// - `isDone` reads the effect back from PayPal's subscription. It drives read-before-retry, the
//   check after a 422, and confirmation. Types whose effect isn't on the subscription (refund,
//   capture, create plan) have none: PayPal-Request-Id = the Action id makes their retries safe
//   instead, and a 2xx is final (`confirmsOnApply`).
// - `run` makes the call. A revise answers with the buyer's approval link (AWAITING_BUYER).

/** What PayPal's subscription says, from a fresh GET or from a sync's snapshot. */
export interface Truth {
  status: SubscriptionStatus;
  planId: string;
  /** What the next cycle costs: a discount's fixed_price, or the plan price. null when unknown. */
  price: Money | null;
}

export interface PayPalMutator {
  getSubscription(merchantId: string, paypalSubscriptionId: string): Promise<PayPalSubscription>;
  suspend(merchantId: string, paypalSubscriptionId: string, reason: string): Promise<MutationResult>;
  activate(merchantId: string, paypalSubscriptionId: string, reason: string): Promise<MutationResult>;
  cancel(merchantId: string, paypalSubscriptionId: string, reason: string): Promise<MutationResult>;
  revise(
    merchantId: string,
    paypalSubscriptionId: string,
    input: { planId: string; returnUrl: string; cancelUrl: string },
  ): Promise<MutationResult & { approveUrl: string }>;
  patchPrice(merchantId: string, paypalSubscriptionId: string, fixedPrice: Money): Promise<MutationResult>;
  refund(
    merchantId: string,
    input: { transactionId: string; amount: Money; requestId: string },
  ): Promise<MutationResult & { refundId: string }>;
  capture(
    merchantId: string,
    paypalSubscriptionId: string,
    input: { amount: Money; requestId: string },
  ): Promise<MutationResult & { transactionId: string }>;
  createPlan(
    merchantId: string,
    input: {
      productId: string;
      name: string;
      price: Money;
      interval: { unit: "DAY" | "WEEK" | "MONTH" | "YEAR"; count: number };
      requestId: string;
    },
  ): Promise<MutationResult & { planId: string }>;
}

export interface RunContext {
  merchantId: string;
  actionId: string;
  /** null only for create_plan. */
  paypalSubscriptionId: string | null;
  /** The subscription's list price, for a patch that removes a discount. */
  planPrice: Money | null;
  /** Where PayPal sends the buyer after a revise: approve, or cancel. */
  returnUrl: string;
  cancelUrl: string;
}

export type RunResult =
  | { kind: "applied"; debugId: string | null; result?: Record<string, unknown> }
  | { kind: "awaiting_buyer"; debugId: string | null; approveUrl: string };

interface Plan<T extends ActionType> {
  isDone: ((truth: Truth, params: ActionParamsOf<T>, ctx: Pick<RunContext, "planPrice">) => boolean) | null;
  confirmsOnApply: boolean;
  run(paypal: PayPalMutator, ctx: RunContext, params: ActionParamsOf<T>): Promise<RunResult>;
}

const sameMoney = (a: Money | null, b: Money | null) =>
  a !== null && b !== null && a.value === b.value && a.currency === b.currency;

function subscriptionOf(ctx: RunContext): string {
  // The engine only runs subscription Actions when it found the subscription.
  if (ctx.paypalSubscriptionId === null) throw new Error(`Action ${ctx.actionId} has no subscription`);
  return ctx.paypalSubscriptionId;
}

const statusChange = (
  call: "suspend" | "activate" | "cancel",
  target: SubscriptionStatus,
): Plan<"suspend" | "activate" | "cancel"> => ({
  isDone: (truth) => truth.status === target,
  confirmsOnApply: false,
  run: async (paypal, ctx, params) => {
    const { debugId } = await paypal[call](ctx.merchantId, subscriptionOf(ctx), params.reason);
    return { kind: "applied", debugId };
  },
});

export const PLANS: { [T in ActionType]: Plan<T> } = {
  suspend: statusChange("suspend", "SUSPENDED"),
  activate: statusChange("activate", "ACTIVE"),
  cancel: statusChange("cancel", "CANCELLED"),
  revise: {
    isDone: (truth, params) => truth.planId === params.planId,
    confirmsOnApply: false,
    run: async (paypal, ctx, params) => {
      const { debugId, approveUrl } = await paypal.revise(ctx.merchantId, subscriptionOf(ctx), {
        planId: params.planId,
        returnUrl: ctx.returnUrl,
        cancelUrl: ctx.cancelUrl,
      });
      return { kind: "awaiting_buyer", debugId, approveUrl };
    },
  },
  patch_price: {
    // null removes the discount: done when the next cycle costs the plan price again.
    isDone: (truth, params, ctx) => sameMoney(truth.price, params.fixedPrice ?? ctx.planPrice),
    confirmsOnApply: false,
    run: async (paypal, ctx, params) => {
      const price = params.fixedPrice ?? ctx.planPrice;
      if (price === null) throw new Error(`Action ${ctx.actionId}: no plan price to restore`);
      const { debugId } = await paypal.patchPrice(ctx.merchantId, subscriptionOf(ctx), price);
      return { kind: "applied", debugId };
    },
  },
  refund: {
    isDone: null,
    confirmsOnApply: true,
    run: async (paypal, ctx, params) => {
      const { debugId, refundId } = await paypal.refund(ctx.merchantId, {
        transactionId: params.transactionId,
        amount: params.amount,
        requestId: ctx.actionId,
      });
      return { kind: "applied", debugId, result: { refundId } };
    },
  },
  capture_outstanding: {
    isDone: null,
    confirmsOnApply: true,
    run: async (paypal, ctx, params) => {
      const { debugId, transactionId } = await paypal.capture(ctx.merchantId, subscriptionOf(ctx), {
        amount: params.amount,
        requestId: ctx.actionId,
      });
      return { kind: "applied", debugId, result: { transactionId } };
    },
  },
  create_plan: {
    isDone: null,
    confirmsOnApply: true,
    run: async (paypal, ctx, params) => {
      const { debugId, planId } = await paypal.createPlan(ctx.merchantId, {
        ...params,
        requestId: ctx.actionId,
      });
      return { kind: "applied", debugId, result: { planId } };
    },
  },
};

/** The type's plan with params checked against the contract's schema for that type. */
export function planFor(type: ActionType, rawParams: unknown) {
  const plan = PLANS[type] as Plan<ActionType>;
  return { plan, params: parseActionParams(type, rawParams) };
}

export function truthFromPayPal(raw: PayPalSubscription): Truth {
  // With fields=plan, the subscription's own billing cycle shows any fixed_price override.
  const cycles = (
    raw as {
      plan?: {
        billing_cycles?: {
          tenure_type: string;
          pricing_scheme?: { fixed_price?: { currency_code: string; value: string } };
        }[];
      };
    }
  ).plan?.billing_cycles;
  const regular = cycles?.find((c) => c.tenure_type === "REGULAR") ?? cycles?.[0];
  const fixed = regular?.pricing_scheme?.fixed_price;
  return { status: raw.status, planId: raw.plan_id, price: fixed ? toMoney(fixed) : null };
}

export function truthFromSnapshot(snapshot: SubscriptionSnapshot): Truth {
  return {
    status: snapshot.status,
    planId: snapshot.paypalPlanId,
    price: snapshot.priceOverride ?? snapshot.price,
  };
}
