import { z } from "zod";
import { Id, IsoDateTime } from "../shared.js";

// Judge Mode (ARCHITECTURE.md §6.17, owner M3; the pool is M1's): a stranger leases one pooled,
// already-approved sandbox subscription for 30 minutes, tries the widget on it, and can run a
// pause's resume early with the time machine. CONTRACTS.md §4 "Demo / Judge Mode".

/**
 * The lease token (HS256, its own secret): what the DEMO auth type means. It names the merchant,
 * the pool entry and the subscription, and ends with the lease.
 */
export const JudgeLeaseClaims = z.object({
  kind: z.literal("judge_lease"),
  mid: Id,
  /** The pool entry, which is also the lease id the routes take. */
  pe: Id,
  /** Our subscription id. */
  sub: Id,
  /** PayPal's subscription id, for minting widget tokens. */
  sid: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type JudgeLeaseClaims = z.infer<typeof JudgeLeaseClaims>;

/** POST /v1/demo/leases. 503 with code `pool_empty` when nothing is available: show the fallback. */
export const JudgeLeaseResponse = z.object({
  leaseId: Id,
  /** Bearer for the other Judge Mode routes. Ends at expiresAt. */
  leaseToken: z.string().min(1),
  expiresAt: IsoDateTime,
  subscriptionId: Id,
});
export type JudgeLeaseResponse = z.infer<typeof JudgeLeaseResponse>;

/** POST /v1/demo/leases/:id/token: a 10-minute widget token for the leased subscription. */
export const JudgeWidgetTokenResponse = z.object({ token: z.string().min(1), expiresAt: IsoDateTime });
export type JudgeWidgetTokenResponse = z.infer<typeof JudgeWidgetTokenResponse>;

/** DELETE /v1/demo/leases/:id: what the pool made of it, decided from PayPal's state. */
export const JudgeReturnResponse = z.object({ result: z.enum(["available", "restoring", "consumed"]) });
export type JudgeReturnResponse = z.infer<typeof JudgeReturnResponse>;

/**
 * POST /v1/demo/time-machine/resume/:subscriptionId: runs the pause's scheduled resume now, a real
 * `activate` in PayPal, labelled TIME SHIFT. `resumed: false` says why not (no pause applied yet).
 */
export const JudgeResumeResponse = z.object({
  resumed: z.boolean(),
  actionId: Id.nullable(),
  label: z.literal("TIME SHIFT"),
  note: z.string(),
});
export type JudgeResumeResponse = z.infer<typeof JudgeResumeResponse>;
