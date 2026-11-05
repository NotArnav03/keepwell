import type {
  DunningCase,
  GrowthJobName,
  GrowthJobPayload,
  NotificationContent,
  PlanInfo,
  SubscriptionSnapshot,
} from "@keepwell/contracts";

// The seams this module needs from other modules. Each is faked in tests; the owner of the real
// one wires it. `Tx` is the caller's transaction from db.forMerchant.

export type NewDunningCase = Omit<DunningCase, "id">;
export type DunningCasePatch = Partial<
  Omit<DunningCase, "id" | "merchantId" | "subscriptionId" | "openedAt">
>;

export interface DunningStore<Tx = unknown> {
  /** The merchant's open or suspended case for this subscription, if any. */
  /** `lock` takes a row lock (SELECT ... FOR UPDATE) so concurrent workers queue up behind each other. */
  findActive(
    tx: Tx,
    merchantId: string,
    subscriptionId: string,
    options?: { lock?: boolean },
  ): Promise<DunningCase | null>;
  /**
   * Newest `suspend` Action on this subscription in APPLIED or CONFIRMED whose origin is not
   * `recovery`, with `updatedAt` at or after `since`. That column is when the engine last moved
   * the Action, so for those states it is when the suspend took effect. Null when there is none.
   */
  findRecentVoluntarySuspend(
    tx: Tx,
    merchantId: string,
    subscriptionId: string,
    since: Date,
  ): Promise<{ id: string } | null>;
  /** True when this suspend Action was already recorded as `dunning.voluntary_suspend`. */
  voluntarySuspendNoted(tx: Tx, merchantId: string, actionId: string): Promise<boolean>;
  insert(tx: Tx, c: NewDunningCase): Promise<DunningCase>;
  update(tx: Tx, merchantId: string, id: string, patch: DunningCasePatch): Promise<DunningCase>;
  /** Cross-tenant (run inside db.acrossMerchants): open cases that want a message but have none. */
  listUnnotified(tx: Tx): Promise<DunningCase[]>;
}

/** Reads the current subscription facts (M1's read model). Never raw webhook bodies. */
export interface SubscriptionSource<Tx = unknown> {
  snapshot(tx: Tx, merchantId: string, subscriptionId: string): Promise<SubscriptionSnapshot | null>;
  /**
   * The subscriber's address. We store only a hash (ARCHITECTURE.md §10), so this asks PayPal: a
   * network call, which is why the service makes it outside any transaction.
   */
  email(merchantId: string, subscriptionId: string): Promise<string | null>;
}

/** The merchant's plan catalogue, to name the smaller plan in the sending-limit message. */
export interface PlanCatalog {
  plans(merchantId: string): Promise<PlanInfo[]>;
}

/** Enqueues a growth job in the caller's transaction; the registry's idempotency key makes a duplicate a no-op. */
export interface JobQueue<Tx = unknown> {
  send<N extends GrowthJobName>(name: N, payload: GrowthJobPayload<N>, tx?: Tx): Promise<void>;
}

/**
 * Seam for a later enhancement: Haiku may reword the tone and language around the facts.
 * NOT implemented in this PR, no LLM is called here. The default returns the content untouched,
 * and the result is re-validated, so facts (amounts, dates, links) can only come from templates.
 */
export interface PersonaliseCopy {
  personalise(content: NotificationContent): Promise<NotificationContent>;
}

export const identityPersonalise: PersonaliseCopy = { personalise: (content) => Promise.resolve(content) };

export interface RecoveryLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RecoveryDb<Tx = unknown> {
  forMerchant<T>(merchantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Only for the sweep, which is cross-tenant by nature. */
  acrossMerchants<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
