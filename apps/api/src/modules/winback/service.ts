import type { FastifyBaseLogger } from "fastify";
import type { Audit, DomainEvent, DomainEvents, Notifier } from "@keepwell/contracts";
import { growthJobs } from "@keepwell/contracts";
import type { JobQueue, SubscriptionDirectory, WinbackCase, WinbackPolicy, WinbackStore } from "./ports.js";
import { signReplyToken } from "./tokens.js";

// ARCHITECTURE.md 6.10: cancelled inside PayPal -> wait 1 h -> ONE message -> reply -> insights.
// The case row's dueAt is the durable timer; the winback.start job is only its trigger, and
// sweepDueWinbacks() lets the M1 due-work sweep re-fire anything a lost job missed (section 9).

export const WINBACK_DELAY_MS = 60 * 60 * 1000;

export interface WinbackDeps {
  store: WinbackStore;
  directory: SubscriptionDirectory;
  policy: WinbackPolicy;
  notifier: Notifier;
  audit: Audit;
  jobs: JobQueue;
  log: FastifyBaseLogger;
  /** PORTAL_URL; the reply page lives there in exit-interview-only mode. */
  portalUrl: string;
  /** MAGIC_LINK_SECRET. */
  tokenSecret: string;
  clock?: () => Date;
}

export type StartOutcome =
  | { result: "sent"; notificationId: string }
  | { result: "skipped"; reason: string }
  | { result: "already_handled" | "no_case" | "not_due" | "deferred" };

const HANDLER_NAME = "winback.open_case";

export class WinbackService {
  private readonly now: () => Date;

  constructor(private readonly d: WinbackDeps) {
    this.now = d.clock ?? (() => new Date());
  }

  /** Subscribes to subscription.cancelled_externally. */
  register(events: DomainEvents): void {
    events.on("subscription.cancelled_externally", HANDLER_NAME, (event) =>
      this.onCancelledExternally(event),
    );
  }

  async onCancelledExternally(event: DomainEvent<"subscription.cancelled_externally">): Promise<void> {
    const { merchantId, simulated } = event;
    const { subscriptionId } = event.payload;
    const dueAt = new Date(this.now().getTime() + WINBACK_DELAY_MS);
    await this.d.store.withMerchant(merchantId, async (repo, tx) => {
      const { case: winback, created } = await repo.openCase({
        merchantId,
        subscriptionId,
        dueAt,
        simulated,
      });
      if (!created) {
        // A duplicate event is harmless; the original case already has its timer and job.
        this.d.log.info({ merchantId, subscriptionId }, "winback case already open");
        return;
      }
      await this.audit(tx, winback, "winback.case_opened", { dueAt: dueAt.toISOString() });
      await this.d.jobs.send("winback.start", { subscriptionId }, this.jobOptions(subscriptionId, dueAt), tx);
    });
  }

  /** The winback.start job. Safe to run any number of times for one subscription. */
  async start(subscriptionId: string, opts: { force?: boolean } = {}): Promise<StartOutcome> {
    const owner = await this.d.store.locate(subscriptionId);
    if (!owner) {
      this.d.log.warn({ subscriptionId }, "winback.start without a case");
      return { result: "no_case" };
    }
    const { merchantId } = owner;
    const now = this.now();
    const log = this.d.log.child({ merchantId, subscriptionId });

    return this.d.store.withMerchant(merchantId, async (repo, tx): Promise<StartOutcome> => {
      const stored = await repo.getCaseBySubscription(subscriptionId);
      if (!stored) return { result: "no_case" };
      // The time-machine path flags everything it records, even for a case a real event opened.
      const winback = { ...stored, simulated: stored.simulated || opts.force === true };
      if (winback.state !== "pending") return { result: "already_handled" };
      if (!opts.force && winback.dueAt.getTime() > now.getTime()) return { result: "not_due" };

      const skip = async (reason: string): Promise<StartOutcome> => {
        if (await repo.transition(winback.id, "pending", { state: "skipped", skipReason: reason })) {
          await this.audit(tx, winback, "winback.skipped", { reason });
          log.info({ reason }, "winback skipped");
        }
        return { result: "skipped", reason };
      };

      const view = await this.d.directory.get(merchantId, subscriptionId);
      if (!view) return skip("subscription_missing");
      if (view.status !== "CANCELLED") return skip("no_longer_cancelled");
      if (view.session === "saved") return skip("session_saved");
      // Let the live session finish; the sweep picks the case up again once it has closed.
      if (view.session === "open") return { result: "deferred" };
      if (!view.email) return skip("no_email");

      // Claim first: the compare-and-set is what makes a second run (or a racing one) a no-op.
      if (!(await repo.transition(winback.id, "pending", { state: "sent", sentAt: now }))) {
        return { result: "already_handled" };
      }
      const token = signReplyToken(this.d.tokenSecret, { merchantId, caseId: winback.id }, now);
      const replyUrl = new URL("/exit-interview", this.d.portalUrl);
      replyUrl.searchParams.set("token", token);
      const resubscribeUrl = await this.d.policy.resubscribeUrl(merchantId, subscriptionId);

      // Facts only: no model writes this message.
      const notificationId = await this.d.notifier.enqueue(
        {
          merchantId,
          subscriptionId,
          to: view.email,
          content: {
            template: "winback.ask",
            payload: {
              firstName: view.firstName,
              planName: view.planName,
              replyUrl: replyUrl.toString(),
              resubscribeUrl,
            },
          },
          simulated: winback.simulated,
        },
        tx,
      );
      await repo.transition(winback.id, "sent", { state: "sent", notificationId });
      await this.audit(tx, winback, "winback.message_queued", {
        notificationId,
        invitesBack: resubscribeUrl !== null,
      });
      log.info({ notificationId }, "winback message queued");
      return { result: "sent", notificationId };
    });
  }

  /**
   * Time-machine / Judge Mode entry: send now instead of in an hour. Everything it records is
   * flagged simulated. Without a case, `merchantId` is needed to open one.
   */
  async startWinbackNow(subscriptionId: string, merchantId?: string): Promise<StartOutcome> {
    const existing = await this.d.store.locate(subscriptionId);
    if (!existing) {
      if (!merchantId) throw new Error("No win-back case for this subscription; pass merchantId to open one");
      await this.d.store.withMerchant(merchantId, async (repo, tx) => {
        const { case: winback, created } = await repo.openCase({
          merchantId,
          subscriptionId,
          dueAt: this.now(),
          simulated: true,
        });
        if (created)
          await this.audit(tx, winback, "winback.case_opened", { dueAt: this.now().toISOString() });
      });
    }
    return this.start(subscriptionId, { force: true });
  }

  /** For the M1 due-work sweep: re-fires pending cases whose timer has passed. Returns how many it ran. */
  async sweepDue(limit = 100): Promise<number> {
    const due = await this.d.store.listDue(this.now(), limit);
    for (const { subscriptionId } of due) {
      try {
        await this.start(subscriptionId);
      } catch (err) {
        // One bad case must not stop the rest; the next sweep tries it again.
        this.d.log.error({ err, subscriptionId }, "winback sweep failed for a case");
      }
    }
    return due.length;
  }

  private jobOptions(subscriptionId: string, startAfter: Date) {
    return { startAfter, singletonKey: growthJobs["winback.start"].idempotencyKey({ subscriptionId }) };
  }

  private async audit(
    tx: unknown,
    winback: WinbackCase,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.d.audit.append(
      {
        merchantId: winback.merchantId,
        actor: winback.simulated ? "demo" : "system",
        kind,
        subjectIds: { subscriptionId: winback.subscriptionId, winbackCaseId: winback.id },
        payload: { ...payload, ...(winback.simulated && { simulated: true }) },
        simulated: winback.simulated,
      },
      tx,
    );
  }
}
