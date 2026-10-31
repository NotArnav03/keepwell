import { Id, IsoDateTime } from "../shared.js";
import {
  Action,
  ActionCreateInput,
  canTransition,
  type ActionError,
  type ActionState,
} from "../platform/actions.js";
import type { ActionEngine, DomainEvents } from "../platform/interfaces.js";
import { uuidv7 } from "./uuidv7.js";

// Cancel supersedes these; EXECUTING holds the subscription lock and finishes first.
const SUPERSEDABLE: readonly ActionState[] = ["PENDING", "RETRY_WAIT", "AWAITING_BUYER"];

export interface ScheduledResume {
  id: string;
  merchantId: string;
  subscriptionId: string;
  dueAt: string;
  /** The suspend Action it waits for (see ActionEngine.scheduleResume), or null. */
  afterActionId: string | null;
}

/**
 * In-memory ActionEngine. It never calls PayPal: tests drive Actions through the real state
 * machine with transition(). It does apply the engine's rules that callers depend on:
 * idempotency keys, cancel superseding other Actions, merchant scoping and, when given a
 * DomainEvents, an action.state_changed event for every change.
 */
export class FakeActionEngine implements ActionEngine {
  readonly actions: Action[] = [];
  readonly resumes: ScheduledResume[] = [];
  private readonly clock: () => Date;
  private readonly events: DomainEvents | undefined;

  constructor(options: { clock?: () => Date; events?: DomainEvents } = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.events = options.events;
  }

  async create(input: ActionCreateInput): Promise<Action> {
    const parsed = ActionCreateInput.parse(input);
    if (parsed.idempotencyKey !== undefined) {
      const existing = this.actions.find(
        (a) => a.merchantId === parsed.merchantId && a.idempotencyKey === parsed.idempotencyKey,
      );
      if (existing) return structuredClone(existing);
    }

    if (parsed.type === "cancel") {
      const others = this.actions.filter(
        (a) =>
          a.merchantId === parsed.merchantId &&
          a.subscriptionId === parsed.subscriptionId &&
          SUPERSEDABLE.includes(a.state),
      );
      for (const other of others) await this.transition(other.id, "SUPERSEDED");
    }

    const now = this.clock();
    const action = Action.parse({
      id: uuidv7(now.getTime()),
      merchantId: parsed.merchantId,
      subscriptionId: parsed.subscriptionId,
      type: parsed.type,
      params: parsed.params,
      state: "PENDING",
      origin: parsed.origin,
      attempts: 0,
      idempotencyKey: parsed.idempotencyKey ?? null,
      approveUrl: null,
      paypalDebugIds: [],
      error: null,
      simulated: parsed.simulated,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    this.actions.push(action);
    await this.emitChange(action, null);
    return structuredClone(action);
  }

  get(merchantId: string, actionId: string): Promise<Action | null> {
    const found = this.actions.find((a) => a.id === actionId && a.merchantId === merchantId);
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  scheduleResume(input: {
    merchantId: string;
    subscriptionId: string;
    dueAt: string;
    afterActionId?: string;
  }): Promise<string> {
    return new Promise((resolve) => {
      const resume: ScheduledResume = {
        id: uuidv7(this.clock().getTime()),
        merchantId: Id.parse(input.merchantId),
        subscriptionId: Id.parse(input.subscriptionId),
        dueAt: IsoDateTime.parse(input.dueAt),
        afterActionId: input.afterActionId === undefined ? null : Id.parse(input.afterActionId),
      };
      this.resumes.push(resume);
      resolve(resume.id);
    });
  }

  /**
   * Test driver: moves an Action as the worker would. Throws on a transition the real state
   * machine doesn't allow, so tests can't depend on impossible flows.
   */
  async transition(
    actionId: string,
    to: ActionState,
    patch: { approveUrl?: string | null; error?: ActionError | null } = {},
  ): Promise<Action> {
    const action = this.actions.find((a) => a.id === actionId);
    if (!action) throw new Error(`No action ${actionId}`);
    const from = action.state;
    if (!canTransition(from, to)) throw new Error(`Action ${actionId} cannot go from ${from} to ${to}`);

    action.state = to;
    if (to === "EXECUTING") action.attempts++;
    if (patch.approveUrl !== undefined) action.approveUrl = patch.approveUrl;
    if (patch.error !== undefined) action.error = patch.error;
    action.updatedAt = this.clock().toISOString();
    Action.parse(action);
    await this.emitChange(action, from);
    return structuredClone(action);
  }

  private async emitChange(action: Action, from: ActionState | null): Promise<void> {
    await this.events?.emit({
      type: "action.state_changed",
      merchantId: action.merchantId,
      simulated: action.simulated,
      payload: {
        actionId: action.id,
        subscriptionId: action.subscriptionId,
        type: action.type,
        from,
        to: action.state,
        approveUrl: action.approveUrl,
        error: action.error,
      },
    });
  }
}
