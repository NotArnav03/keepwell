import { z } from "zod";
import { Id, IsoDateTime } from "../shared.js";

export const Actor = z.enum([
  "subscriber",
  "agent",
  "policy",
  "merchant",
  "system",
  "subscriber_agent",
  "demo",
]);
export type Actor = z.infer<typeof Actor>;

/** Dotted lower-case, e.g. "offer.presented", "action.state_changed", "policy.published". */
export const AuditKind = z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/);

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** prevHash of the first entry in each merchant's chain. */
export const GENESIS_HASH = "0".repeat(64);

// hash = sha256(prevHash ‖ canonicalJson(entry without hash)), chained per merchant (§6.16).
export const AuditEntry = z.object({
  seq: z.number().int().min(1),
  merchantId: Id,
  at: IsoDateTime,
  actor: Actor,
  kind: AuditKind,
  /** { subscriptionId, sessionId, actionId, paypalSubscriptionId, ... } */
  subjectIds: z.record(z.string(), z.string()),
  payload: z.record(z.string(), z.unknown()),
  simulated: z.boolean(),
  prevHash: Sha256Hex,
  hash: Sha256Hex,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** Input to Audit.append: the log assigns seq, at, prevHash and hash. */
export const AuditAppendInput = AuditEntry.omit({ seq: true, at: true, prevHash: true, hash: true }).extend({
  simulated: z.boolean().default(false),
});
export type AuditAppendInput = z.input<typeof AuditAppendInput>;

/** GET /v1/m/audit/verify */
export const AuditVerifyResult = z.object({
  ok: z.boolean(),
  checked: z.number().int().min(0),
  brokenAtSeq: z.number().int().min(1).nullable(),
});
export type AuditVerifyResult = z.infer<typeof AuditVerifyResult>;
