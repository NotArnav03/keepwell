import { and, asc, eq, inArray, lt, lte, ne, or } from "drizzle-orm";
import type pg from "pg";
import {
  ActionCreateInput,
  PayPalGatewayError,
  canTransition,
  type Action,
  type ActionEngine,
  type ActionError,
  type ActionOrigin,
  type ActionState,
  type ActionType,
  type Actor,
  type Audit,
  type DomainEvents,
  type PayPalSubscription,
  type SubscriptionStatus,
} from "@keepwell/contracts";
import { actions, scheduledResumes, subscriptions, type Db, type Tx } from "@keepwell/db";
import type { MutationResult } from "../paypal/client.js";

// The action engine (ARCHITECTURE.md §6.4): every change to PayPal is an Action row moving through
// ACTION_TRANSITIONS, and every move is audited and emitted in the same transaction.
//
// - One Action executes at a time per subscription: a session-level advisory lock, held across the
//   PayPal call, keyed on the subscription. If the process dies, Postgres drops the lock with it.
// - Read-before-retry: a retry (or a lost worker's Action) first GETs the subscription, and a 422
//   is checked the same way. If PayPal already shows the target status, the change happened: no
//   second call.
// - Cancel pre-empts: creating a cancel supersedes the subscription's PENDING, RETRY_WAIT and
//   AWAITING_BUYER Actions, and its pending resumes. An EXECUTING one holds the lock and finishes.
// - Retry budget: 8 attempts over about 45 minutes, then FAILED.
//
// Jobs (action.execute, action.confirm, resume.due, the due-work sweep) call the worker methods
// below. Revise, price patch, refund, capture and create_plan arrive with #13.

/** What the engine needs from the PayPal gateway: reads, and the mutations it alone may call. */
export interface PayPalMutator {
  getSubscription(merchantId: string, paypalSubscriptionId: string): Promise<PayPalSubscription>;
  suspend(merchantId: string, paypalSubscriptionId: string, reason: string): Promise<MutationResult>;
  activate(merchantId: string, paypalSubscriptionId: string, reason: string): Promise<MutationResult>;
  cancel(merchantId: string, paypalSubscriptionId: string, reason: string): Promise<MutationResult>;
}

export interface EngineLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ActionEngineOptions {
  db: Db;
  /** For the advisory locks: they need a session, so this must be the direct (unpooled) database. */
  lockPool: pg.Pool;
  paypal: PayPalMutator;
  audit: Audit<Tx>;
  events: DomainEvents<Tx>;
  log: EngineLogger;
  clock?: () => Date;
  /** Waits before attempts 2, 3, …; its length + 1 is the attempt budget. */
  retryDelaysMs?: readonly number[];
  /** An Action EXECUTING longer than this, with no lock held, belonged to a worker that died. */
  executingLeaseMs?: number;
  /** APPLIED but not CONFIRMED by then means something is wrong: FAILED, and an alert. */
  confirmWithinMs?: number;
  random?: () => number;
}

export type ExecuteOutcome = "applied" | "retry_scheduled" | "failed" | "busy" | "skipped";
export type ConfirmOutcome = "confirmed" | "pending" | "failed" | "skipped";

type ActionRow = typeof actions.$inferSelect;
type Mutation = "suspend" | "activate" | "cancel";

const MINUTE = 60_000;
const DEFAULT_RETRY_DELAYS_MS = [0.5, 1, 2, 4, 8, 15, 15].map((m) => m * MINUTE);
const SUPPORTED = new Set<ActionType>(["suspend", "activate", "cancel"]);
const TARGET: Record<Mutation, SubscriptionStatus> = {
  suspend: "SUSPENDED",
  activate: "ACTIVE",
  cancel: "CANCELLED",
};
const SUPERSEDABLE: ActionState[] = ["PENDING", "RETRY_WAIT", "AWAITING_BUYER"];
const ACTOR: Record<ActionOrigin, Actor> = {
  session: "subscriber",
  subscriber_agent: "subscriber_agent",
  insight: "merchant",
  recovery: "system",
  schedule: "system",
  demo: "demo",
};

type PayPalOutcome =
  | { ok: true; debugId: string | null; via: "call" | "read_before_retry" | "read_after_422" }
  | { ok: false; error: ActionError; retryable: boolean; debugId: string | null };

export class DbActionEngine implements ActionEngine<Tx> {
  private readonly clock: () => Date;
  private readonly retryDelaysMs: readonly number[];
  private readonly executingLeaseMs: number;
  private readonly confirmWithinMs: number;
  private readonly random: () => number;

  constructor(private readonly o: ActionEngineOptions) {
    this.clock = o.clock ?? (() => new Date());
    this.retryDelaysMs = o.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.executingLeaseMs = o.executingLeaseMs ?? 2 * MINUTE;
    this.confirmWithinMs = o.confirmWithinMs ?? 15 * MINUTE;
    this.random = o.random ?? Math.random;
  }

  // ---------- the ActionEngine contract ----------

  async create(input: ActionCreateInput, tx?: Tx): Promise<Action> {
    if (!tx) return this.o.db.forMerchant(input.merchantId, (t) => this.create(input, t));
    const parsed = ActionCreateInput.parse(input);
    if (!SUPPORTED.has(parsed.type)) {
      throw new Error(`${parsed.type} Actions aren't supported yet (#13)`);
    }
    if (parsed.idempotencyKey !== undefined) {
      const existing = await this.byKey(tx, parsed.merchantId, parsed.idempotencyKey);
      if (existing) return toAction(existing);
    }
    const [row] = await tx
      .insert(actions)
      .values({
        merchantId: parsed.merchantId,
        subscriptionId: parsed.subscriptionId,
        type: parsed.type,
        params: parsed.params,
        origin: parsed.origin,
        idempotencyKey: parsed.idempotencyKey ?? null,
        simulated: parsed.simulated,
        updatedAt: this.clock(),
      })
      .onConflictDoNothing({ target: [actions.merchantId, actions.idempotencyKey] })
      .returning();
    if (!row) {
      // Another transaction created it with the same key a moment ago.
      const raced = await this.byKey(tx, parsed.merchantId, parsed.idempotencyKey ?? "");
      if (!raced) throw new Error("Idempotency conflict without an existing Action");
      return toAction(raced);
    }
    await this.record(tx, row, null, ACTOR[row.origin]);
    if (row.type === "cancel" && row.subscriptionId !== null) await this.supersedeFor(tx, row);
    return toAction(row);
  }

  async get(merchantId: string, actionId: string): Promise<Action | null> {
    const [row] = await this.o.db.forMerchant(merchantId, (tx) =>
      tx.select().from(actions).where(eq(actions.id, actionId)),
    );
    return row ? toAction(row) : null;
  }

  async scheduleResume(
    input: { merchantId: string; subscriptionId: string; dueAt: string; afterActionId?: string },
    tx?: Tx,
  ): Promise<string> {
    if (!tx) return this.o.db.forMerchant(input.merchantId, (t) => this.scheduleResume(input, t));
    let status: "waiting" | "scheduled" | "cancelled" = "scheduled";
    if (input.afterActionId !== undefined) {
      const [after] = await tx.select().from(actions).where(eq(actions.id, input.afterActionId));
      if (!after || after.type !== "suspend") throw new Error("afterActionId must be a suspend Action");
      status = resumeStatusFor(after.state);
    }
    const [row] = await tx
      .insert(scheduledResumes)
      .values({
        merchantId: input.merchantId,
        subscriptionId: input.subscriptionId,
        dueAt: new Date(input.dueAt),
        afterActionId: input.afterActionId ?? null,
        status,
      })
      .returning({ id: scheduledResumes.id });
    if (!row) throw new Error("scheduled_resumes insert returned nothing");
    await this.o.audit.append(
      {
        merchantId: input.merchantId,
        actor: "system",
        kind: "resume.scheduled",
        subjectIds: { subscriptionId: input.subscriptionId, scheduledResumeId: row.id },
        payload: { dueAt: input.dueAt, afterActionId: input.afterActionId ?? null, status },
      },
      tx,
    );
    return row.id;
  }

  // ---------- the worker side: called by jobs ----------

  /** Runs one Action against PayPal if it is due and its subscription isn't busy. */
  async execute(merchantId: string, actionId: string): Promise<ExecuteOutcome> {
    const [target] = await this.o.db.forMerchant(merchantId, (tx) =>
      tx
        .select({ id: actions.id, subscriptionId: actions.subscriptionId })
        .from(actions)
        .where(eq(actions.id, actionId)),
    );
    if (!target) return "skipped";
    const lock = await this.lock(target.subscriptionId ?? target.id);
    if (!lock) return "busy";
    try {
      return await this.executeLocked(merchantId, actionId);
    } finally {
      await lock.release();
    }
  }

  /** Actions ready to run: PENDING, or RETRY_WAIT whose wait is over. For the due-work sweep. */
  async due(limit = 50): Promise<{ merchantId: string; actionId: string }[]> {
    const now = this.clock();
    const rows = await this.o.db.acrossMerchants((tx) =>
      tx
        .select({ merchantId: actions.merchantId, actionId: actions.id })
        .from(actions)
        .where(
          or(
            eq(actions.state, "PENDING"),
            and(eq(actions.state, "RETRY_WAIT"), lte(actions.nextAttemptAt, now)),
          ),
        )
        .orderBy(asc(actions.createdAt))
        .limit(limit),
    );
    return rows;
  }

  /**
   * EXECUTING Actions whose worker died mid-call go back to RETRY_WAIT, due now, so the next execute
   * reads PayPal before deciding. Only when nobody holds the subscription's lock: a slow live worker
   * is left alone.
   */
  async recoverStuck(): Promise<string[]> {
    const before = new Date(this.clock().getTime() - this.executingLeaseMs);
    const stuck = await this.o.db.acrossMerchants((tx) =>
      tx
        .select({ id: actions.id, merchantId: actions.merchantId, subscriptionId: actions.subscriptionId })
        .from(actions)
        .where(and(eq(actions.state, "EXECUTING"), lt(actions.updatedAt, before))),
    );
    const recovered: string[] = [];
    for (const action of stuck) {
      const lock = await this.lock(action.subscriptionId ?? action.id);
      if (!lock) continue;
      try {
        const moved = await this.o.db.forMerchant(action.merchantId, async (tx) => {
          const row = await this.locked(tx, action.id);
          if (row?.state !== "EXECUTING") return false;
          await this.move(tx, row, "RETRY_WAIT", {
            nextAttemptAt: this.clock(),
            error: {
              code: "WORKER_LOST",
              message: "The worker stopped mid-call; PayPal is read before retrying",
            },
          });
          return true;
        });
        if (moved) {
          this.o.log.warn(
            { actionId: action.id, merchantId: action.merchantId },
            "recovered an Action from a lost worker",
          );
          recovered.push(action.id);
        }
      } finally {
        await lock.release();
      }
    }
    return recovered;
  }

  /** APPLIED → CONFIRMED once PayPal shows the target status; FAILED (with an alert) if it never does. */
  async confirm(merchantId: string, actionId: string): Promise<ConfirmOutcome> {
    const [row] = await this.o.db.forMerchant(merchantId, (tx) =>
      tx.select().from(actions).where(eq(actions.id, actionId)),
    );
    if (row?.state !== "APPLIED" || !isMutation(row.type)) return "skipped";
    const target = TARGET[row.type];
    const paypalId = await this.paypalSubscriptionId(merchantId, row.subscriptionId);
    let status: SubscriptionStatus | null = null;
    try {
      status = paypalId === null ? null : (await this.o.paypal.getSubscription(merchantId, paypalId)).status;
    } catch (err) {
      // A failed read isn't evidence either way; the next confirm (or webhook) decides.
      this.o.log.warn({ err, actionId }, "confirm could not read PayPal");
      return "pending";
    }
    const tooLate = this.clock().getTime() - row.updatedAt.getTime() > this.confirmWithinMs;
    if (status !== target && !tooLate) return "pending";
    return this.o.db.forMerchant(merchantId, async (tx) => {
      const current = await this.locked(tx, actionId);
      if (current?.state !== "APPLIED") return "skipped";
      if (status === target) {
        await this.move(tx, current, "CONFIRMED", {});
        return "confirmed";
      }
      this.o.log.error({ actionId, merchantId, status }, "Action applied but PayPal never showed it");
      await this.move(tx, current, "FAILED", {
        error: { code: "NOT_CONFIRMED", message: `PayPal still shows ${status ?? "nothing"}` },
      });
      return "failed";
    });
  }

  /** Scheduled resumes whose time has come become activate Actions (the resume.due job). */
  async runDueResumes(limit = 50): Promise<string[]> {
    const now = this.clock();
    const due = await this.o.db.acrossMerchants((tx) =>
      tx
        .select({ id: scheduledResumes.id, merchantId: scheduledResumes.merchantId })
        .from(scheduledResumes)
        .where(and(eq(scheduledResumes.status, "scheduled"), lte(scheduledResumes.dueAt, now)))
        .orderBy(asc(scheduledResumes.dueAt))
        .limit(limit),
    );
    const created: string[] = [];
    for (const resume of due) {
      const actionId = await this.o.db.forMerchant(resume.merchantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(scheduledResumes)
          .where(and(eq(scheduledResumes.id, resume.id), eq(scheduledResumes.status, "scheduled")))
          .for("update", { skipLocked: true });
        if (!row) return null;
        const action = await this.create(
          {
            merchantId: row.merchantId,
            subscriptionId: row.subscriptionId,
            type: "activate",
            origin: "schedule",
            params: { reason: "The pause is over" },
            idempotencyKey: `resume:${row.id}`,
          },
          tx,
        );
        await tx
          .update(scheduledResumes)
          .set({ status: "done", actionId: action.id })
          .where(eq(scheduledResumes.id, row.id));
        return action.id;
      });
      if (actionId !== null) created.push(actionId);
    }
    return created;
  }

  // ---------- internals ----------

  private async executeLocked(merchantId: string, actionId: string): Promise<ExecuteOutcome> {
    const started = await this.o.db.forMerchant(merchantId, async (tx) => {
      const row = await this.locked(tx, actionId);
      if (!row || !this.isDue(row)) return null;
      const retry = row.state === "RETRY_WAIT";
      const executing = await this.move(tx, row, "EXECUTING", {
        attempts: row.attempts + 1,
        nextAttemptAt: null,
      });
      return { row: executing, retry };
    });
    if (!started) return "skipped";
    const { row, retry } = started;

    const paypalId = await this.paypalSubscriptionId(merchantId, row.subscriptionId);
    const outcome: PayPalOutcome =
      paypalId === null || !isMutation(row.type)
        ? {
            ok: false,
            error: { code: "UNSUPPORTED", message: `No way to run ${row.type}` },
            retryable: false,
            debugId: null,
          }
        : await this.callPayPal(merchantId, row.type, paypalId, row.params, retry);

    return this.o.db.forMerchant(merchantId, async (tx) => {
      const current = await this.locked(tx, actionId);
      // We hold the subscription lock and nothing else moves an EXECUTING Action.
      if (current?.state !== "EXECUTING")
        throw new Error(`Action ${actionId} left EXECUTING underneath its worker`);
      const debugIds =
        outcome.debugId === null ? current.paypalDebugIds : [...current.paypalDebugIds, outcome.debugId];

      if (outcome.ok) {
        await this.move(tx, current, "APPLIED", {
          paypalDebugIds: debugIds,
          result: { via: outcome.via },
          error: null,
        });
        if (current.type === "suspend") await this.settleResumes(tx, current.id, "scheduled");
        return "applied";
      }
      if (outcome.retryable && current.attempts <= this.retryDelaysMs.length) {
        const wait = (this.retryDelaysMs[current.attempts - 1] ?? 0) * (0.8 + this.random() * 0.4);
        await this.move(tx, current, "RETRY_WAIT", {
          paypalDebugIds: debugIds,
          nextAttemptAt: new Date(this.clock().getTime() + Math.round(wait)),
          error: outcome.error,
        });
        return "retry_scheduled";
      }
      const error = outcome.retryable
        ? { code: "RETRIES_EXHAUSTED", message: `${current.attempts} attempts: ${outcome.error.message}` }
        : outcome.error;
      await this.move(tx, current, "FAILED", { paypalDebugIds: debugIds, error });
      if (current.type === "suspend") await this.settleResumes(tx, current.id, "cancelled");
      if (current.type === "cancel") {
        // Never silent (§6.4): the subscriber is shown PayPal's autopay page; the merchant is alerted.
        this.o.log.error({ actionId, merchantId, error }, "cancel Action FAILED");
      }
      return "failed";
    });
  }

  private async callPayPal(
    merchantId: string,
    type: Mutation,
    paypalId: string,
    params: unknown,
    retry: boolean,
  ): Promise<PayPalOutcome> {
    const target = TARGET[type];
    const reason = (params as { reason: string }).reason;
    try {
      if (retry) {
        // Read-before-retry (§6.1): the earlier attempt may have worked and lost its response.
        const current = await this.o.paypal.getSubscription(merchantId, paypalId);
        if (current.status === target) return { ok: true, debugId: null, via: "read_before_retry" };
      }
      const { debugId } = await this.o.paypal[type](merchantId, paypalId, reason);
      return { ok: true, debugId, via: "call" };
    } catch (err) {
      if (!(err instanceof PayPalGatewayError)) throw err;
      if (err.kind === "unprocessable") {
        // "Status invalid" may mean it's already there, e.g. a cancel that already happened.
        const current = await this.o.paypal.getSubscription(merchantId, paypalId).catch(() => null);
        if (current?.status === target)
          return { ok: true, debugId: err.details.debugId, via: "read_after_422" };
      }
      return {
        ok: false,
        retryable: err.retryable,
        debugId: err.details.debugId,
        error: { code: err.details.issue ?? err.kind.toUpperCase(), message: err.message },
      };
    }
  }

  /** Every cancel supersedes what hasn't started, and the resumes that would undo it. */
  private async supersedeFor(tx: Tx, cancel: ActionRow): Promise<void> {
    if (cancel.subscriptionId === null) return;
    const pending = await tx
      .select()
      .from(actions)
      .where(
        and(
          eq(actions.subscriptionId, cancel.subscriptionId),
          inArray(actions.state, SUPERSEDABLE),
          ne(actions.id, cancel.id),
        ),
      )
      .for("update");
    for (const row of pending) await this.move(tx, row, "SUPERSEDED", {});
    await tx
      .update(scheduledResumes)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(scheduledResumes.subscriptionId, cancel.subscriptionId),
          inArray(scheduledResumes.status, ["waiting", "scheduled"]),
        ),
      );
  }

  private async settleResumes(tx: Tx, suspendId: string, status: "scheduled" | "cancelled"): Promise<void> {
    await tx
      .update(scheduledResumes)
      .set({ status })
      .where(and(eq(scheduledResumes.afterActionId, suspendId), eq(scheduledResumes.status, "waiting")));
  }

  /** The one place an Action changes state: checked against ACTION_TRANSITIONS, audited, emitted. */
  private async move(
    tx: Tx,
    row: ActionRow,
    to: ActionState,
    patch: Partial<Pick<ActionRow, "attempts" | "nextAttemptAt" | "paypalDebugIds" | "result" | "error">>,
  ): Promise<ActionRow> {
    if (!canTransition(row.state, to)) throw new Error(`Illegal Action transition ${row.state} → ${to}`);
    const [updated] = await tx
      .update(actions)
      .set({ ...patch, state: to, updatedAt: this.clock() })
      .where(and(eq(actions.id, row.id), eq(actions.state, row.state)))
      .returning();
    if (!updated) throw new Error(`Action ${row.id} changed under us (expected ${row.state})`);
    await this.record(tx, updated, row.state, "system");
    return updated;
  }

  private async record(tx: Tx, row: ActionRow, from: ActionState | null, actor: Actor): Promise<void> {
    const error = (row.error as ActionError | null) ?? null;
    await this.o.audit.append(
      {
        merchantId: row.merchantId,
        actor,
        kind: from === null ? "action.created" : "action.state_changed",
        subjectIds: {
          actionId: row.id,
          ...(row.subscriptionId !== null && { subscriptionId: row.subscriptionId }),
        },
        payload: { type: row.type, from, to: row.state, origin: row.origin, attempts: row.attempts, error },
        simulated: row.simulated,
      },
      tx,
    );
    await this.o.events.emit(
      {
        type: "action.state_changed",
        merchantId: row.merchantId,
        payload: {
          actionId: row.id,
          subscriptionId: row.subscriptionId,
          type: row.type,
          from,
          to: row.state,
          approveUrl: row.approveUrl,
          error,
        },
        simulated: row.simulated,
      },
      tx,
    );
  }

  private isDue(row: ActionRow): boolean {
    if (row.state === "PENDING") return true;
    return row.state === "RETRY_WAIT" && (row.nextAttemptAt === null || row.nextAttemptAt <= this.clock());
  }

  private async locked(tx: Tx, actionId: string): Promise<ActionRow | undefined> {
    const [row] = await tx.select().from(actions).where(eq(actions.id, actionId)).for("update");
    return row;
  }

  private async byKey(tx: Tx, merchantId: string, key: string): Promise<ActionRow | undefined> {
    const [row] = await tx
      .select()
      .from(actions)
      .where(and(eq(actions.merchantId, merchantId), eq(actions.idempotencyKey, key)));
    return row;
  }

  private async paypalSubscriptionId(
    merchantId: string,
    subscriptionId: string | null,
  ): Promise<string | null> {
    if (subscriptionId === null) return null;
    const [row] = await this.o.db.forMerchant(merchantId, (tx) =>
      tx
        .select({ id: subscriptions.paypalSubscriptionId })
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId)),
    );
    return row?.id ?? null;
  }

  /** A session-level advisory lock on its own connection, or null when someone else holds it. */
  private async lock(key: string): Promise<{ release: () => Promise<void> } | null> {
    const client = await this.o.lockPool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [key],
      );
      if (!rows[0]?.locked) {
        client.release();
        return null;
      }
    } catch (err) {
      client.release(err instanceof Error ? err : true);
      throw err;
    }
    return {
      release: async () => {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
          client.release();
        } catch (err) {
          // Destroy the connection: closing it is what frees a lock we couldn't release.
          client.release(err instanceof Error ? err : true);
          throw err;
        }
      },
    };
  }
}

function isMutation(type: ActionType): type is Mutation {
  return type === "suspend" || type === "activate" || type === "cancel";
}

function resumeStatusFor(suspendState: ActionState): "waiting" | "scheduled" | "cancelled" {
  if (suspendState === "APPLIED" || suspendState === "CONFIRMED") return "scheduled";
  if (suspendState === "FAILED" || suspendState === "SUPERSEDED" || suspendState === "ABANDONED")
    return "cancelled";
  return "waiting";
}

function toAction(row: ActionRow): Action {
  return {
    id: row.id,
    merchantId: row.merchantId,
    subscriptionId: row.subscriptionId,
    type: row.type,
    params: row.params as Record<string, unknown>,
    state: row.state,
    origin: row.origin,
    attempts: row.attempts,
    idempotencyKey: row.idempotencyKey,
    approveUrl: row.approveUrl,
    paypalDebugIds: row.paypalDebugIds,
    error: (row.error as ActionError | null) ?? null,
    simulated: row.simulated,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
