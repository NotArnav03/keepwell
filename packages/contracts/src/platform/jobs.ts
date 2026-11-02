import { z } from "zod";
import { Id } from "../shared.js";

// M1 job queues (CONTRACTS.md §3). `idempotencyKey` becomes pg-boss's singletonKey, so a
// duplicate enqueue inside the same window is a no-op.

/** "2026-10-29T17:24" style bucket of `minutes` width, in UTC. */
function bucket(now: Date, minutes: number): string {
  const ms = minutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms).toISOString().slice(0, 16);
}

function job<S extends z.ZodType>(payload: S, idempotencyKey: (payload: z.infer<S>, now: Date) => string) {
  return { payload, idempotencyKey };
}

export const platformJobs = {
  "webhook.process": job(z.object({ webhookEventId: Id }), (p) => p.webhookEventId),
  "action.execute": job(z.object({ actionId: Id }), (p) => p.actionId),
  "action.confirm": job(z.object({ actionId: Id }), (p) => p.actionId),
  "reconcile.subscription": job(
    z.object({ subscriptionId: Id }),
    (p, now) => `${p.subscriptionId}:${bucket(now, 1)}`,
  ),
  "reconcile.sweep": job(z.object({ merchantId: Id }), (p, now) => `${p.merchantId}:${bucket(now, 30)}`),
  /** Nightly: compare every live subscription with PayPal before re-syncing it, and report drift (§6.3). */
  "reconcile.drift": job(
    z.object({ merchantId: Id }),
    (p, now) => `${p.merchantId}:${now.toISOString().slice(0, 10)}`,
  ),
  "due.sweep": job(z.strictObject({}), (_p, now) => bucket(now, 1)),
  "resume.due": job(z.object({ scheduledResumeId: Id }), (p) => p.scheduledResumeId),
  "domain.dispatch": job(
    z.object({ domainEventId: Id, handler: z.string().min(1) }),
    (p) => `${p.domainEventId}:${p.handler}`,
  ),
  "pool.health": job(z.strictObject({}), (_p, now) => bucket(now, 5)),
} as const;

export type PlatformJobName = keyof typeof platformJobs;
export type PlatformJobPayload<N extends PlatformJobName> = z.infer<(typeof platformJobs)[N]["payload"]>;
