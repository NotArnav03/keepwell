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
  findActive(tx: Tx, merchantId: string, subscriptionId: string): Promise<DunningCase | null>;
  insert(tx: Tx, c: NewDunningCase): Promise<DunningCase>;
  update(tx: Tx, merchantId: string, id: string, patch: DunningCasePatch): Promise<DunningCase>;
  /** Cross-tenant (run inside db.acrossMerchants): open cases that want a message but have none. */
  listUnnotified(tx: Tx): Promise<DunningCase[]>;
}

export interface SubscriberView {
  snapshot: SubscriptionSnapshot;
  /** Not part of the snapshot (only a hash is stored); null when the gateway didn't return one. */
  email: string | null;
}

/** Reads the current subscription facts (M1's read model). Never raw webhook bodies. */
export interface SubscriptionSource<Tx = unknown> {
  get(tx: Tx, merchantId: string, subscriptionId: string): Promise<SubscriberView | null>;
}

/** The merchant's plan catalogue, to name the smaller plan in the sending-limit message. */
export interface PlanCatalog {
  plans(merchantId: string): Promise<PlanInfo[]>;
}

/** Enqueues a growth job; the implementation uses `singletonKey` so a duplicate is a no-op. */
export interface JobQueue<Tx = unknown> {
  send<N extends GrowthJobName>(
    name: N,
    payload: GrowthJobPayload<N>,
    singletonKey: string,
    tx?: Tx,
  ): Promise<void>;
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
