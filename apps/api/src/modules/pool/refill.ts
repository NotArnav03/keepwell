import { z } from "zod";
import { PayPalGatewayError, type PayPalGateway } from "@keepwell/contracts";

/** Where a subscription made by `pnpm pool:refill` stands with its approver. */
export type ApprovalCheck = { kind: "active" } | { kind: "waiting" } | { kind: "dropped"; why: string };

/**
 * Looks a waiting pool subscription up at PayPal. A missing one is dropped, not fatal: sandbox has
 * been seen to forget an unapproved subscription, and one lost link shouldn't stop the run watching
 * the rest. PayPal being slow or down just means looking again next round.
 */
export async function checkApproval(
  paypal: Pick<PayPalGateway, "getSubscription">,
  merchantId: string,
  paypalSubscriptionId: string,
): Promise<ApprovalCheck> {
  try {
    const { status } = await paypal.getSubscription(merchantId, paypalSubscriptionId);
    if (status === "ACTIVE") return { kind: "active" };
    if (status === "APPROVAL_PENDING" || status === "APPROVED") return { kind: "waiting" };
    return { kind: "dropped", why: status };
  } catch (err) {
    if (err instanceof PayPalGatewayError && err.kind === "not_found") {
      return { kind: "dropped", why: "not found at PayPal" };
    }
    if (err instanceof PayPalGatewayError && err.retryable) return { kind: "waiting" };
    throw err;
  }
}

export const MAX_PER_RUN = 50;

const RefillArgs = z.object({
  count: z.coerce.number().int().min(0).max(MAX_PER_RUN).default(0),
  wait: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(60),
});
export type RefillArgs = z.infer<typeof RefillArgs>;

/**
 * `[count] [--wait <minutes>]`, in either order. The count is the first argument that is neither a
 * flag nor the value after `--wait`; without `--wait` nothing is skipped, so a count given first
 * still counts (it used to be read as 0, which made `pool:refill 10` create nothing).
 */
export function parseRefillArgs(argv: readonly string[]): RefillArgs {
  const waitAt = argv.indexOf("--wait");
  const waitValueAt = waitAt === -1 ? -1 : waitAt + 1;
  return RefillArgs.parse({
    count: argv.find((a, i) => !a.startsWith("--") && i !== waitValueAt),
    wait: waitAt === -1 ? undefined : argv[waitValueAt],
  });
}
