import { and, desc, eq, getTableColumns } from "drizzle-orm";
import { z } from "zod";
import {
  ActionError,
  ActionState,
  InsightAction,
  type InsightActionKind,
  type InsightActionState,
  type Money,
} from "@keepwell/contracts";
import { uuidv7 } from "@keepwell/contracts/fakes";
import { actions, insightActions, type Db, type Tx } from "@keepwell/db";

// Storage for insight_actions. Transitions are guarded in the UPDATE itself (WHERE state = from),
// so two concurrent approvals cannot both win. Methods take the caller's transaction so a state
// change commits with its audit entry; without one they open their own db.forMerchant.

/**
 * Read-only outcome of the linked engine Action. `executed` on a create_plan row only means the
 * Action was created (still PENDING); this is how a queue tells a real PayPal result from that.
 * Not stored, and not a new insight-action state.
 */
export const InsightActionExecution = z.object({
  status: z.enum(["pending", "confirmed", "failed", "not_applicable"]),
  error: ActionError.optional(),
});
export type InsightActionExecution = z.infer<typeof InsightActionExecution>;

function notApplicable(): InsightActionExecution {
  return { status: "not_applicable" };
}

/** The contract's InsightAction plus why an approved action failed to run, and the derived execution. */
export interface StoredInsightAction extends InsightAction {
  error: string | null;
  execution: InsightActionExecution;
}

export interface NewInsightAction {
  merchantId: string;
  kind: InsightActionKind;
  params: Record<string, unknown>;
  rationale: string;
  estimate: { monthlyRevenueImpact: Money; basis: string } | null;
  proposedBy: InsightAction["proposedBy"];
}

export interface TransitionPatch {
  /** Set when the action ran through the ActionEngine. */
  actionId?: string;
  error?: string;
}

export const INSIGHT_ACTION_TRANSITIONS: Record<InsightActionState, readonly InsightActionState[]> = {
  proposed: ["approved", "rejected"],
  approved: ["executed", "failed"],
  rejected: [],
  executed: [],
  failed: [],
};

export interface InsightActionStore<T = Tx> {
  create(input: NewInsightAction, tx?: T): Promise<StoredInsightAction>;
  get(merchantId: string, id: string, tx?: T): Promise<StoredInsightAction | null>;
  list(merchantId: string, state?: InsightActionState, tx?: T): Promise<StoredInsightAction[]>;
  /**
   * Moves `from` -> `to` only if the row is in `from` and the move is allowed. Returns the updated
   * row, or null when the row is missing, belongs to another merchant, or is in another state.
   */
  transition(
    merchantId: string,
    id: string,
    from: InsightActionState,
    to: InsightActionState,
    patch?: TransitionPatch,
    tx?: T,
  ): Promise<StoredInsightAction | null>;
}

type Row = typeof insightActions.$inferSelect;

/**
 * APPLIED is not confirmation: PayPal has accepted the call, and a later read can still fail it.
 * No visible Action (nothing linked, or hidden by row-level security) is not_applicable: never a
 * guessed success, and never another merchant's error.
 */
function executionFor(
  actionId: string | null,
  linked: { state: string | null | undefined; error: unknown },
): InsightActionExecution {
  // A left join yields null or undefined when the Action is missing or hidden by RLS.
  if (actionId === null || linked.state === null || linked.state === undefined) return notApplicable();
  const state = ActionState.safeParse(linked.state);
  if (!state.success) return notApplicable();
  switch (state.data) {
    case "PENDING":
    case "EXECUTING":
    case "RETRY_WAIT":
    case "AWAITING_BUYER":
    case "APPLIED":
      return { status: "pending" };
    case "CONFIRMED":
      return { status: "confirmed" };
    case "FAILED":
    case "ABANDONED":
    case "SUPERSEDED": {
      const error = ActionError.safeParse(linked.error);
      return error.success ? { status: "failed", error: error.data } : { status: "failed" };
    }
  }
}

function toStored(
  row: Row,
  linked: { state: string | null | undefined; error: unknown },
): StoredInsightAction {
  return {
    ...InsightAction.parse({
      id: row.id,
      merchantId: row.merchantId,
      kind: row.kind,
      params: row.params,
      rationale: row.rationale,
      estimate: row.estimate,
      state: row.state,
      proposedBy: row.proposedBy,
      actionId: row.actionId,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
    }),
    error: row.error,
    execution: executionFor(row.actionId, linked),
  };
}

type Joined = Row & { actionState: string | null | undefined; actionError: unknown };

function fromJoined(row: Joined): StoredInsightAction {
  return toStored(row, { state: row.actionState, error: row.actionError });
}

export class DbInsightActionStore implements InsightActionStore {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private scoped<R>(merchantId: string, tx: Tx | undefined, fn: (t: Tx) => Promise<R>): Promise<R> {
    return tx ? fn(tx) : this.db.forMerchant(merchantId, fn);
  }

  create(input: NewInsightAction, tx?: Tx): Promise<StoredInsightAction> {
    return this.scoped(input.merchantId, tx, async (t) => {
      const [row] = await t
        .insert(insightActions)
        .values({
          merchantId: input.merchantId,
          kind: input.kind,
          params: input.params,
          rationale: input.rationale,
          estimate: input.estimate,
          proposedBy: input.proposedBy,
          createdAt: this.clock(),
        })
        .returning();
      if (!row) throw new Error("insight_actions insert returned nothing");
      return toStored(row, { state: null, error: null });
    });
  }

  get(merchantId: string, id: string, tx?: Tx): Promise<StoredInsightAction | null> {
    return this.scoped(merchantId, tx, async (t) => {
      const [row] = await this.joined(t).where(eq(insightActions.id, id));
      return row ? fromJoined(row) : null;
    });
  }

  list(merchantId: string, state?: InsightActionState, tx?: Tx): Promise<StoredInsightAction[]> {
    return this.scoped(merchantId, tx, async (t) => {
      // One join for the whole list: a query per row would be N+1 and could mix snapshots.
      const rows = await this.joined(t)
        .where(state ? eq(insightActions.state, state) : undefined)
        .orderBy(desc(insightActions.createdAt));
      return rows.map(fromJoined);
    });
  }

  /** Insight row plus the linked Action's state and error, in a single statement. */
  private joined(t: Tx) {
    return t
      .select({
        ...getTableColumns(insightActions),
        actionState: actions.state,
        actionError: actions.error,
      })
      .from(insightActions)
      .leftJoin(actions, eq(actions.id, insightActions.actionId));
  }

  transition(
    merchantId: string,
    id: string,
    from: InsightActionState,
    to: InsightActionState,
    patch: TransitionPatch = {},
    tx?: Tx,
  ): Promise<StoredInsightAction | null> {
    if (!INSIGHT_ACTION_TRANSITIONS[from].includes(to)) {
      return Promise.reject(new Error(`insight action cannot move ${from} -> ${to}`));
    }
    return this.scoped(merchantId, tx, async (t) => {
      const [row] = await t
        .update(insightActions)
        .set({
          state: to,
          // decidedAt is the merchant's decision: set on approve/reject, kept through execution.
          ...(from === "proposed" && { decidedAt: this.clock() }),
          ...(patch.actionId !== undefined && { actionId: patch.actionId }),
          ...(patch.error !== undefined && { error: patch.error }),
        })
        .where(and(eq(insightActions.id, id), eq(insightActions.state, from)))
        .returning();
      if (!row) return null;
      // Approve returns this row. When an Action was just linked, re-read it in this transaction
      // so the response's `execution` matches get/list instead of claiming there is nothing to show.
      if (row.actionId === null) return toStored(row, { state: null, error: null });
      const [joined] = await this.joined(t).where(eq(insightActions.id, id));
      return joined ? fromJoined(joined) : toStored(row, { state: null, error: null });
    });
  }
}

/** In-memory store for tests and for the copilot's fakes. Scopes by merchant like RLS would. */
export class InMemoryInsightActionStore implements InsightActionStore<unknown> {
  readonly rows: StoredInsightAction[] = [];

  constructor(private readonly clock: () => Date = () => new Date()) {}

  create(input: NewInsightAction): Promise<StoredInsightAction> {
    const now = this.clock();
    const row: StoredInsightAction = {
      ...InsightAction.parse({
        id: uuidv7(now.getTime()),
        merchantId: input.merchantId,
        kind: input.kind,
        params: input.params,
        rationale: input.rationale,
        estimate: input.estimate,
        state: "proposed",
        proposedBy: input.proposedBy,
        actionId: null,
        createdAt: now.toISOString(),
        decidedAt: null,
      }),
      error: null,
      // No actions table here, so execution stays not_applicable. The DB store fills it with the join.
      execution: notApplicable(),
    };
    this.rows.push(row);
    return Promise.resolve(structuredClone(row));
  }

  get(merchantId: string, id: string): Promise<StoredInsightAction | null> {
    const row = this.rows.find((r) => r.id === id && r.merchantId === merchantId);
    return Promise.resolve(row ? structuredClone(row) : null);
  }

  list(merchantId: string, state?: InsightActionState): Promise<StoredInsightAction[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.merchantId === merchantId && (state === undefined || r.state === state))
        .map((r) => structuredClone(r))
        .reverse(),
    );
  }

  transition(
    merchantId: string,
    id: string,
    from: InsightActionState,
    to: InsightActionState,
    patch: TransitionPatch = {},
  ): Promise<StoredInsightAction | null> {
    if (!INSIGHT_ACTION_TRANSITIONS[from].includes(to)) {
      return Promise.reject(new Error(`insight action cannot move ${from} -> ${to}`));
    }
    const row = this.rows.find((r) => r.id === id && r.merchantId === merchantId && r.state === from);
    if (!row) return Promise.resolve(null);
    row.state = to;
    if (from === "proposed") row.decidedAt = this.clock().toISOString();
    if (patch.actionId !== undefined) row.actionId = patch.actionId;
    if (patch.error !== undefined) row.error = patch.error;
    return Promise.resolve(structuredClone(row));
  }
}
