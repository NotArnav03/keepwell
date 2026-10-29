import { z } from "zod";
import { BillingInterval, Id, IsoDateTime, Money } from "../shared.js";

// Every change to PayPal is an Action (ARCHITECTURE.md §6.4).

export const ActionType = z.enum([
  "suspend",
  "activate",
  "cancel",
  "revise",
  "patch_price",
  "refund",
  "capture_outstanding",
  "create_plan",
]);
export type ActionType = z.infer<typeof ActionType>;

export const ActionState = z.enum([
  "PENDING",
  "EXECUTING",
  "RETRY_WAIT",
  "AWAITING_BUYER",
  "APPLIED",
  "CONFIRMED",
  "FAILED",
  "ABANDONED",
  "SUPERSEDED",
]);
export type ActionState = z.infer<typeof ActionState>;

/**
 * The state machine from ARCHITECTURE.md §6.4. The engine and FakeActionEngine both refuse any
 * other transition. A cancel supersedes every Action on the subscription that isn't executing
 * (EXECUTING holds the per-subscription lock, so it finishes first).
 */
export const ACTION_TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = {
  PENDING: ["EXECUTING", "SUPERSEDED"],
  EXECUTING: ["AWAITING_BUYER", "APPLIED", "RETRY_WAIT", "FAILED"],
  RETRY_WAIT: ["EXECUTING", "SUPERSEDED"],
  AWAITING_BUYER: ["APPLIED", "ABANDONED", "SUPERSEDED"],
  APPLIED: ["CONFIRMED", "FAILED"],
  CONFIRMED: [],
  FAILED: [],
  ABANDONED: [],
  SUPERSEDED: [],
};

export function isTerminalActionState(state: ActionState): boolean {
  return ACTION_TRANSITIONS[state].length === 0;
}

export function canTransition(from: ActionState, to: ActionState): boolean {
  return ACTION_TRANSITIONS[from].includes(to);
}

export const ActionOrigin = z.enum([
  "session",
  "insight",
  "recovery",
  "schedule",
  "demo",
  "subscriber_agent",
]);
export type ActionOrigin = z.infer<typeof ActionOrigin>;

// PayPal's limit on suspend/activate/cancel `reason`.
const PayPalReason = z.string().min(1).max(128);

/** Params per action type. Strict, so a typo'd key fails at creation instead of at PayPal. */
export const ActionParams = {
  suspend: z.strictObject({ reason: PayPalReason }),
  activate: z.strictObject({ reason: PayPalReason }),
  cancel: z.strictObject({ reason: PayPalReason }),
  revise: z.strictObject({ planId: z.string().min(1) }),
  /** `null` removes the override, back to the plan price. */
  patch_price: z.strictObject({ fixedPrice: Money.nullable() }),
  /** The PayPal transaction of the subscription payment being refunded (endpoint: spike Q1). */
  refund: z.strictObject({ transactionId: z.string().min(1), amount: Money }),
  capture_outstanding: z.strictObject({ amount: Money }),
  create_plan: z.strictObject({
    productId: z.string().min(1),
    name: z.string().min(1).max(127),
    price: Money,
    interval: BillingInterval,
  }),
} as const satisfies Record<ActionType, z.ZodType>;
export type ActionParamsOf<T extends ActionType> = z.infer<(typeof ActionParams)[T]>;

export function parseActionParams<T extends ActionType>(type: T, params: unknown): ActionParamsOf<T> {
  return ActionParams[type].parse(params) as ActionParamsOf<T>;
}

export const ActionError = z.object({ code: z.string().min(1), message: z.string() });
export type ActionError = z.infer<typeof ActionError>;

const CreateBase = z.object({
  merchantId: Id,
  subscriptionId: Id.nullable(),
  origin: ActionOrigin,
  /** Same key for the same merchant returns the existing Action: makes double-clicks harmless. */
  idempotencyKey: z.string().min(1).max(200).optional(),
  simulated: z.boolean().default(false),
});

const variant = <T extends ActionType>(type: T) =>
  CreateBase.extend({ type: z.literal(type), params: ActionParams[type] });

/** Input to ActionEngine.create. Only create_plan has no subscription. */
export const ActionCreateInput = z
  .discriminatedUnion("type", [
    variant("suspend"),
    variant("activate"),
    variant("cancel"),
    variant("revise"),
    variant("patch_price"),
    variant("refund"),
    variant("capture_outstanding"),
    variant("create_plan"),
  ])
  .refine((input) => (input.type === "create_plan") === (input.subscriptionId === null), {
    message: "create_plan has no subscription; every other action needs one",
    path: ["subscriptionId"],
  });
export type ActionCreateInput = z.input<typeof ActionCreateInput>;

/** An Action as stored and returned by the engine. */
export const Action = z.object({
  id: Id,
  merchantId: Id,
  subscriptionId: Id.nullable(),
  type: ActionType,
  /** Valid for `type`; read it with parseActionParams. */
  params: z.record(z.string(), z.unknown()),
  state: ActionState,
  origin: ActionOrigin,
  attempts: z.number().int().min(0),
  idempotencyKey: z.string().nullable(),
  /** PayPal's buyer approval link; revise only, while AWAITING_BUYER. */
  approveUrl: z.url().nullable(),
  paypalDebugIds: z.array(z.string()),
  error: ActionError.nullable(),
  simulated: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Action = z.infer<typeof Action>;
