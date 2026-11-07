import { isDeepStrictEqual } from "node:util";
import { PublishPolicyRequest } from "@keepwell/contracts";
import type {
  MerchantPrincipal,
  PolicyPublisher,
  SendWinbackBatchInput,
  UpdatePolicyInput,
  WinbackBatchResult,
  WinbackBatchSender,
} from "./service.js";

// The two ways an approved insight action reaches other modules, behind the service's interfaces.

/** The slice of the policy module's service this needs (modules/policy/service.ts satisfies it). */
export interface PolicyApi {
  list(principal: MerchantPrincipal): Promise<{ currentVersion: number | null }>;
  get(principal: MerchantPrincipal, version: number): Promise<{ version: number; document: object }>;
  publish(principal: MerchantPrincipal, body: PublishPolicyRequest): Promise<{ version: number }>;
}

/**
 * Applies the proposal's path changes to the current policy and publishes the result as the next
 * version. Each change's `from` must match what is there now, so a proposal made against an older
 * policy fails loudly instead of overwriting newer edits. packages/policy validates the result.
 */
export class PolicyApiPublisher implements PolicyPublisher {
  constructor(private readonly policies: PolicyApi) {}

  async publishChanges(
    principal: MerchantPrincipal,
    params: UpdatePolicyInput,
  ): Promise<{ version: number }> {
    const { currentVersion } = await this.policies.list(principal);
    if (currentVersion === null) throw new Error("There is no published policy to change yet");
    const current = await this.policies.get(principal, currentVersion);
    const { version: _version, ...draft } = structuredClone(current.document) as Record<string, unknown>;
    for (const change of params.changes) applyChange(draft, change);
    const body = PublishPolicyRequest.parse({
      baseVersion: currentVersion,
      document: draft,
      changeNote: params.summary.slice(0, 280),
    });
    return this.policies.publish(principal, body);
  }
}

const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function applyChange(
  root: Record<string, unknown>,
  change: UpdatePolicyInput["changes"][number],
): void {
  const keys = change.path.split(".");
  const last = keys.pop();
  if (last === undefined) throw new Error("Empty policy path");
  // The path comes from a model-written proposal: never let it reach the prototype chain.
  if ([...keys, last].some((key) => UNSAFE_KEYS.has(key))) {
    throw new Error(`Policy path ${change.path} is not allowed`);
  }
  let node: unknown = root;
  for (const key of keys) node = child(node, key, change.path);
  if (typeof node !== "object" || node === null) throw new Error(`Policy path ${change.path} does not exist`);
  const holder = node as Record<string, unknown>;
  if (!isDeepStrictEqual(child(holder, last, change.path, true), change.from)) {
    throw new Error(`Policy changed since this was proposed: ${change.path} is no longer what was expected`);
  }
  holder[last] = change.to;
}

function child(node: unknown, key: string, path: string, allowMissing = false): unknown {
  if (typeof node !== "object" || node === null) throw new Error(`Policy path ${path} does not exist`);
  const record = node as Record<string, unknown>;
  // Own keys only (`in` would follow the prototype chain), and arrays by index only (not `length`).
  if (Array.isArray(node) && !/^\d+$/.test(key)) throw new Error(`Policy path ${path} does not exist`);
  if (!Object.hasOwn(record, key)) {
    if (allowMissing) return undefined;
    throw new Error(`Policy path ${path} does not exist`);
  }
  return record[key];
}

/**
 * What win-back offers for a batch: `WinbackService.startBatch` satisfies it. Declared here so this
 * module depends on the shape, not on win-back's internals (modules talk through interfaces).
 */
export interface WinbackBatchStarter {
  startBatch(
    merchantId: string,
    subscriptionIds: string[],
  ): Promise<{ queued: number; skipped: { subscriptionId: string; reason: string }[] }>;
}

/**
 * Win-back batch behind `WinbackBatchSender`. `startBatch` opens a due-now case for each CANCELLED
 * subscription and queues the normal start, skips (with a reason) everything else, and is
 * idempotent, so its `{ queued, skipped }` are the true counts that `approve()` records.
 */
export class WinbackStartBatchSender implements WinbackBatchSender {
  constructor(private readonly winback: WinbackBatchStarter) {}

  send(merchantId: string, params: SendWinbackBatchInput): Promise<WinbackBatchResult> {
    return this.winback.startBatch(merchantId, params.subscriptionIds);
  }
}
