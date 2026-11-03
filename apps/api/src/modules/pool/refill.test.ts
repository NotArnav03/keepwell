import { describe, expect, it } from "vitest";
import { PayPalGatewayError, type PayPalSubscription } from "@keepwell/contracts";
import { checkApproval } from "./refill.js";

// What `pnpm pool:refill` does with each subscription still waiting for a judge-pool approver.

const M = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";

function gateway(result: string | Error) {
  return {
    getSubscription: (_merchantId: string, id: string): Promise<PayPalSubscription> =>
      result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve({ id, status: result } as PayPalSubscription),
  };
}

const error = (kind: ConstructorParameters<typeof PayPalGatewayError>[0], status: number) =>
  new PayPalGatewayError(kind, "x", { status, issue: null, debugId: null });

describe("checkApproval", () => {
  it("is ready once PayPal shows the subscription ACTIVE", async () => {
    expect(await checkApproval(gateway("ACTIVE"), M, "I-A")).toEqual({ kind: "active" });
  });

  it("keeps waiting while the approver hasn't finished", async () => {
    expect(await checkApproval(gateway("APPROVAL_PENDING"), M, "I-A")).toEqual({ kind: "waiting" });
    expect(await checkApproval(gateway("APPROVED"), M, "I-A")).toEqual({ kind: "waiting" });
  });

  it("drops one that ended up in any other state", async () => {
    expect(await checkApproval(gateway("CANCELLED"), M, "I-A")).toEqual({
      kind: "dropped",
      why: "CANCELLED",
    });
  });

  // Regression: on 3 Nov a sandbox subscription started answering 404 an hour and a half after it
  // was created, and the refill run crashed with 24 approvals still to watch.
  it("drops one PayPal no longer knows, rather than stopping the run", async () => {
    expect(await checkApproval(gateway(error("not_found", 404)), M, "I-A")).toEqual({
      kind: "dropped",
      why: "not found at PayPal",
    });
  });

  it("keeps waiting through a PayPal outage", async () => {
    expect(await checkApproval(gateway(error("unavailable", 503)), M, "I-A")).toEqual({ kind: "waiting" });
  });

  it("stops on anything else, such as bad credentials", async () => {
    await expect(checkApproval(gateway(error("unauthorized", 401)), M, "I-A")).rejects.toBeInstanceOf(
      PayPalGatewayError,
    );
  });
});
