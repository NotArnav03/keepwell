import type { z } from "zod";
import {
  InsightActionProposal,
  SendWinbackBatchParams,
  UpdatePolicyParams,
  CreatePlanParams,
  type ActionEngine,
  type Audit,
  type DomainEvents,
  type InsightAction,
  type InsightActionState,
} from "@keepwell/contracts";
import type { EstimateProvider } from "./estimate.js";
import type { PlanProductResolver } from "./sql-inputs.js";
import type { InsightActionStore, StoredInsightAction } from "./store.js";

function winbackFailureMessage(skipped: { subscriptionId: string; reason: string }[]): string {
  const reasons = skipped.map((item) => `${item.subscriptionId} (${item.reason})`).join("; ");
  return reasons.length > 0
    ? `no subscription could be messaged: ${reasons}`
    : "no subscription could be messaged";
}

// Insight-to-action (ARCHITECTURE.md §6.12). The copilot proposes; nothing runs until a merchant
// calls approve(). Approval moves the row proposed -> approved, runs the action, and records
// executed or failed. PayPal is only ever touched through the ActionEngine.

// The contract exports these as schemas only; the types are derived, not redefined.
export type UpdatePolicyInput = z.infer<typeof UpdatePolicyParams>;
export type SendWinbackBatchInput = z.infer<typeof SendWinbackBatchParams>;

export interface MerchantPrincipal {
  merchantId: string;
  /** Shown in the audit entry: the merchant user's email or name. */
  userLabel: string;
}

/** Publishes a new policy version from path changes. Backed by the policy module's publish API. */
export interface PolicyPublisher {
  publishChanges(principal: MerchantPrincipal, params: UpdatePolicyInput): Promise<{ version: number }>;
}

/** What a win-back send actually did. `skipped.reason` is why that subscription was not messaged. */
export interface WinbackBatchResult {
  queued: number;
  skipped: { subscriptionId: string; reason: string }[];
}

/**
 * Starts a win-back for each subscription. `queued` counts subscriptions that will be messaged.
 * The win-back module's `startBatch` is what should sit behind this; until it exists, the jobs
 * adapter reports every id as skipped.
 */
export interface WinbackBatchSender {
  send(merchantId: string, params: SendWinbackBatchInput): Promise<WinbackBatchResult>;
}

export type InsightActionErrorCode = "invalid_request" | "unauthorized" | "not_found" | "conflict";

export class InsightActionError extends Error {
  override readonly name = "InsightActionError";
  constructor(
    readonly code: InsightActionErrorCode,
    message: string,
  ) {
    super(message);
  }
  get status(): number {
    return { invalid_request: 400, unauthorized: 401, not_found: 404, conflict: 409 }[this.code];
  }
}

export interface InsightActionLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface InsightActionServiceOptions<Tx = unknown> {
  store: InsightActionStore<Tx>;
  estimates: EstimateProvider;
  engine: ActionEngine<Tx>;
  audit: Audit<Tx>;
  events: DomainEvents<Tx>;
  policy: PolicyPublisher;
  winback: WinbackBatchSender;
  products: PlanProductResolver;
  log: InsightActionLogger;
  /** Runs `fn` in one merchant-scoped transaction (db.forMerchant). Fakes pass the default. */
  transact?: <R>(merchantId: string, fn: (tx: Tx | undefined) => Promise<R>) => Promise<R>;
}

export class InsightActionService<Tx = unknown> {
  private readonly o: InsightActionServiceOptions<Tx>;
  private readonly transact: NonNullable<InsightActionServiceOptions<Tx>["transact"]>;

  constructor(options: InsightActionServiceOptions<Tx>) {
    this.o = options;
    this.transact = options.transact ?? ((_merchantId, fn) => fn(undefined));
  }

  /** Validates, estimates, stores as `proposed`, announces. Executes nothing. */
  async propose(
    merchantId: string,
    proposal: unknown,
    proposedBy: InsightAction["proposedBy"],
    rationale = "",
  ): Promise<StoredInsightAction> {
    const parsed = InsightActionProposal.safeParse(proposal);
    if (!parsed.success) throw new InsightActionError("invalid_request", "That proposal is not valid");
    const { estimate, basis } = await this.o.estimates.estimate(merchantId, parsed.data);
    const stored = await this.transact(merchantId, async (tx) => {
      const row = await this.o.store.create(
        {
          merchantId,
          kind: parsed.data.kind,
          params: parsed.data.params,
          rationale,
          estimate,
          proposedBy,
        },
        tx,
      );
      await this.o.audit.append(
        {
          merchantId,
          actor: "agent",
          kind: "insight_action.proposed",
          subjectIds: { insightActionId: row.id },
          payload: { kind: row.kind, proposedBy, params: row.params, estimate, estimateBasis: basis },
        },
        tx,
      );
      await this.o.events.emit(
        { type: "insight_action.proposed", merchantId, payload: { insightActionId: row.id } },
        tx,
      );
      return row;
    });
    this.o.log.info({ merchantId, insightActionId: stored.id, kind: stored.kind }, "insight action proposed");
    return stored;
  }

  list(merchantId: string, state?: InsightActionState): Promise<StoredInsightAction[]> {
    return this.o.store.list(merchantId, state);
  }

  /**
   * The merchant's click. Runs once: a second approve, or approving a rejected action, is a
   * conflict. Execution errors are recorded as `failed` and returned, never thrown.
   */
  async approve(id: string, principal: MerchantPrincipal): Promise<StoredInsightAction> {
    const { merchantId } = principal;
    const approved = await this.transact(merchantId, async (tx) => {
      const row = await this.o.store.transition(merchantId, id, "proposed", "approved", {}, tx);
      if (row) await this.auditDecision(row, "insight_action.approved", principal, tx);
      return row;
    });
    if (!approved) return this.explainNoTransition(merchantId, id, "approve");

    try {
      return await this.execute(approved, principal);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      this.o.log.error({ err, merchantId, insightActionId: id }, "insight action failed");
      return this.recordFailure(approved, message);
    }
  }

  async reject(id: string, principal: MerchantPrincipal): Promise<StoredInsightAction> {
    const { merchantId } = principal;
    const rejected = await this.transact(merchantId, async (tx) => {
      const row = await this.o.store.transition(merchantId, id, "proposed", "rejected", {}, tx);
      if (row) await this.auditDecision(row, "insight_action.rejected", principal, tx);
      return row;
    });
    return rejected ?? this.explainNoTransition(merchantId, id, "reject");
  }

  private async execute(
    row: StoredInsightAction,
    principal: MerchantPrincipal,
  ): Promise<StoredInsightAction> {
    const { merchantId } = principal;
    const finish = (actionId: string | undefined, detail: Record<string, unknown>) =>
      this.transact(merchantId, async (tx) => {
        const done = await this.o.store.transition(
          merchantId,
          row.id,
          "approved",
          "executed",
          actionId === undefined ? {} : { actionId },
          tx,
        );
        await this.o.audit.append(
          {
            merchantId,
            actor: "merchant",
            kind: "insight_action.executed",
            subjectIds: { insightActionId: row.id, ...(actionId && { actionId }) },
            payload: { kind: row.kind, ...detail },
          },
          tx,
        );
        return done ?? row;
      });

    switch (row.kind) {
      case "create_plan": {
        const params = CreatePlanParams.parse(row.params);
        const productId = await this.o.products.productIdFor(merchantId, params.basedOnPaypalPlanId);
        if (!productId) throw new Error(`Plan ${params.basedOnPaypalPlanId} was not found for this merchant`);
        // The Action and the `executed` record commit together; the key makes a retry reuse the Action.
        // `executed` means the Action exists, still PENDING. PayPal's outcome is `execution` on read.
        return this.transact(merchantId, async (tx) => {
          const action = await this.o.engine.create(
            {
              merchantId,
              type: "create_plan",
              params: {
                productId,
                name: params.name,
                price: params.price,
                interval: params.interval,
              },
              origin: "insight",
              subscriptionId: null,
              idempotencyKey: `insight-action:${row.id}`,
            },
            tx,
          );
          const done = await this.o.store.transition(
            merchantId,
            row.id,
            "approved",
            "executed",
            { actionId: action.id },
            tx,
          );
          await this.o.audit.append(
            {
              merchantId,
              actor: "merchant",
              kind: "insight_action.executed",
              subjectIds: { insightActionId: row.id, actionId: action.id },
              payload: { kind: row.kind },
            },
            tx,
          );
          return done ?? row;
        });
      }
      case "update_policy": {
        const { version } = await this.o.policy.publishChanges(
          principal,
          UpdatePolicyParams.parse(row.params),
        );
        return finish(undefined, { policyVersion: version });
      }
      case "send_winback_batch": {
        const result = await this.o.winback.send(merchantId, SendWinbackBatchParams.parse(row.params));
        const counts = { queued: result.queued, skipped: result.skipped };
        // Nothing was actually messaged. `executed` here would be a success that did not happen.
        if (result.queued === 0) {
          const message = winbackFailureMessage(result.skipped);
          this.o.log.error({ merchantId, insightActionId: row.id }, "insight action failed");
          return this.recordFailure(row, message, counts);
        }
        return finish(undefined, counts);
      }
    }
  }

  /** Records `failed` and the audit entry together. `detail` is the execution result (counts). */
  private async recordFailure(
    row: StoredInsightAction,
    message: string,
    detail: Record<string, unknown> = {},
  ): Promise<StoredInsightAction> {
    const failed = await this.transact(row.merchantId, async (tx) => {
      const updated = await this.o.store.transition(
        row.merchantId,
        row.id,
        "approved",
        "failed",
        { error: message },
        tx,
      );
      await this.o.audit.append(
        {
          merchantId: row.merchantId,
          actor: "system",
          kind: "insight_action.failed",
          subjectIds: { insightActionId: row.id },
          payload: { kind: row.kind, error: message, ...detail },
        },
        tx,
      );
      return updated;
    });
    return failed ?? { ...row, state: "failed", error: message };
  }

  private auditDecision(
    row: StoredInsightAction,
    kind: "insight_action.approved" | "insight_action.rejected",
    principal: MerchantPrincipal,
    tx: Tx | undefined,
  ): Promise<unknown> {
    return this.o.audit.append(
      {
        merchantId: row.merchantId,
        actor: "merchant",
        kind,
        subjectIds: { insightActionId: row.id },
        payload: { kind: row.kind, decidedBy: principal.userLabel },
      },
      tx,
    );
  }

  /** The guarded UPDATE matched nothing: say whether the row is missing or already decided. */
  private async explainNoTransition(
    merchantId: string,
    id: string,
    verb: "approve" | "reject",
  ): Promise<never> {
    const current = await this.o.store.get(merchantId, id);
    if (!current) throw new InsightActionError("not_found", "There is no such insight action");
    throw new InsightActionError("conflict", `Can't ${verb} an action that is already ${current.state}`);
  }
}
