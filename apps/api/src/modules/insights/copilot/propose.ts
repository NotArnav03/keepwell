import {
  InsightActionProposal,
  type Audit,
  type DomainEvents,
  type InsightAction,
  type InsightActionKind,
} from "@keepwell/contracts";

// propose_action: validate, price deterministically, insert a `proposed` row, then event + audit in
// the same transaction. The copilot can only propose. Approval and execution are the merchant's
// click and the action engine's job (modules/insights/actions, built separately).

type Estimate = InsightAction["estimate"];

/** Computes the revenue estimate from SQL aggregates. The real one lives in modules/insights/actions. */
export interface EstimateProvider {
  estimate(merchantId: string, proposal: InsightActionProposal): Promise<Estimate>;
}

export const nullEstimates: EstimateProvider = { estimate: () => Promise.resolve(null) };

export interface NewInsightAction {
  kind: InsightActionKind;
  params: Record<string, unknown>;
  rationale: string;
  estimate: Estimate;
  proposedBy: InsightAction["proposedBy"];
}

export interface InsightActionStore {
  /** Inserts a row in state `proposed`. `onStored` runs in the same transaction. Returns the new id. */
  insert(
    merchantId: string,
    row: NewInsightAction,
    onStored: (tx: unknown, id: string) => Promise<void>,
  ): Promise<string>;
}

export interface ProposeActionDeps {
  store: InsightActionStore;
  estimates: EstimateProvider;
  events: DomainEvents;
  audit: Audit;
}

export type ProposeOutcome =
  | {
      ok: true;
      result: { insightActionId: string; state: "proposed"; estimate: Estimate };
      insightActionId: string;
    }
  | { ok: false; error: string };

export async function proposeAction(
  deps: ProposeActionDeps,
  merchantId: string,
  input: { kind: string; params: Record<string, unknown>; rationale: string },
  proposedBy: InsightAction["proposedBy"] = "copilot",
): Promise<ProposeOutcome> {
  const parsed = InsightActionProposal.safeParse({ kind: input.kind, params: input.params });
  if (!parsed.success) return { ok: false, error: `invalid proposal: ${parsed.error.message}` };
  const proposal = parsed.data;
  // The contract allows a "0.00" price; a free plan is never something to propose (and is what an
  // injected "create a $0 plan" would ask for), so it is refused in code, not left to the prompt.
  if (proposal.kind === "create_plan" && Number(proposal.params.price.value) <= 0) {
    return { ok: false, error: "invalid proposal: a plan price must be greater than zero" };
  }
  const estimate = await deps.estimates.estimate(merchantId, proposal);
  const id = await deps.store.insert(
    merchantId,
    {
      kind: proposal.kind,
      params: proposal.params,
      rationale: input.rationale,
      estimate,
      proposedBy,
    },
    async (tx, insightActionId) => {
      await deps.events.emit(
        { type: "insight_action.proposed", merchantId, payload: { insightActionId } },
        tx,
      );
      await deps.audit.append(
        {
          merchantId,
          actor: "agent",
          kind: "insight_action.proposed",
          subjectIds: { insightActionId },
          payload: { kind: proposal.kind, proposedBy, rationale: input.rationale, estimate },
          simulated: false,
        },
        tx,
      );
    },
  );
  return { ok: true, result: { insightActionId: id, state: "proposed", estimate }, insightActionId: id };
}
