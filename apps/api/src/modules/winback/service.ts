import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { Id, type Audit, type DomainEvent, type DomainEvents, type Notifier } from "@keepwell/contracts";
import type { Tx } from "@keepwell/db";
import type {
  JobQueue,
  SubscriptionDirectory,
  WinbackCase,
  WinbackPolicy,
  WinbackState,
  WinbackStore,
} from "./ports.js";
import { signReplyToken } from "./tokens.js";

// ARCHITECTURE.md 6.10: cancelled inside PayPal -> wait 1 h -> ONE message -> reply -> insights.
// The case row's dueAt is the durable timer; the winback.start job is only its trigger, and
// sweepDueWinbacks() lets the M1 due-work sweep re-fire anything a lost job missed (section 9).

export const WINBACK_DELAY_MS = 60 * 60 * 1000;

export interface WinbackDeps {
  store: WinbackStore;
  directory: SubscriptionDirectory;
  policy: WinbackPolicy;
  notifier: Notifier<Tx>;
  audit: Audit<Tx>;
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

/** Insight-to-action sends at most this many subscriptions in one call. */
const START_BATCH_MAX = 500;

const StartBatchInput = z.object({
  merchantId: Id,
  subscriptionIds: z.array(Id).max(START_BATCH_MAX),
});

export type StartBatchSkipReason =
  "not_found" | "not_cancelled" | "already_pending" | "already_sent" | "already_replied" | "already_skipped";

export interface StartBatchSkip {
  subscriptionId: string;
  reason: StartBatchSkipReason;
}

export interface StartBatchResult {
  queued: number;
  skipped: StartBatchSkip[];
}

const ALREADY: Record<WinbackState, StartBatchSkipReason> = {
  pending: "already_pending",
  sent: "already_sent",
  replied: "already_replied",
  skipped: "already_skipped",
};

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

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
      await this.d.jobs.send("winback.start", { subscriptionId }, { startAfter: dueAt, ...(tx && { tx }) });
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

  /**
   * Opens a due-now case and enqueues the normal `winback.start` for each CANCELLED subscription
   * that does not already have one. One message per cancellation: a case that is already pending,
   * sent, replied or skipped is not queued again, so a second call is a no-op. At most 500 ids.
   */
  async startBatch(merchantId: string, subscriptionIds: string[]): Promise<StartBatchResult> {
    const input = StartBatchInput.parse({ merchantId, subscriptionIds });
    const ids = uniqueIds(input.subscriptionIds);
    if (ids.length === 0) return { queued: 0, skipped: [] };
    const now = this.now();

    return this.d.store.withMerchant(input.merchantId, async (repo, tx) => {
      const byId = new Map((await repo.inspect(ids)).map((fact) => [fact.subscriptionId, fact]));
      const toOpen: string[] = [];
      const skipped: StartBatchSkip[] = [];
      for (const subscriptionId of ids) {
        const fact = byId.get(subscriptionId);
        if (!fact) {
          skipped.push({ subscriptionId, reason: "not_found" });
          continue;
        }
        if (fact.status !== "CANCELLED") {
          skipped.push({ subscriptionId, reason: "not_cancelled" });
          continue;
        }
        if (fact.winback) {
          skipped.push({ subscriptionId, reason: ALREADY[fact.winback.state] });
          continue;
        }
        toOpen.push(subscriptionId);
      }

      const opened = await repo.openCases(
        toOpen.map((subscriptionId) => ({
          merchantId: input.merchantId,
          subscriptionId,
          dueAt: now,
          // A batch is a real send. Time-machine sends go through startWinbackNow, which forces
          // the flag; start() still copies whatever this row carries onto the notification.
          simulated: false,
        })),
      );

      const queuedIds: string[] = [];
      const queuedCases: WinbackCase[] = [];
      const raced: StartBatchSkip[] = [];
      for (const row of opened) {
        if (!row.created) {
          raced.push({ subscriptionId: row.case.subscriptionId, reason: ALREADY[row.case.state] });
          continue;
        }
        // Same transaction as the insert, so the job exists only when the case commits.
        // One connection runs one statement at a time, so the sends stay serial.
        await this.d.jobs.send(
          "winback.start",
          { subscriptionId: row.case.subscriptionId },
          { startAfter: row.case.dueAt, ...(tx && { tx }) },
        );
        queuedIds.push(row.case.subscriptionId);
        queuedCases.push(row.case);
      }

      if (raced.length > 0) {
        const rank = new Map(ids.map((id, index) => [id, index]));
        skipped.push(...raced);
        skipped.sort((a, b) => (rank.get(a.subscriptionId) ?? 0) - (rank.get(b.subscriptionId) ?? 0));
      }

      // Nothing new was written on a repeat call, same as a duplicate cancel event: no second audit.
      if (queuedCases.length > 0) {
        const simulated = queuedCases.every((winback) => winback.simulated);
        await this.d.audit.append(
          {
            merchantId: input.merchantId,
            actor: simulated ? "demo" : "system",
            kind: "winback.batch_queued",
            // Many subscriptions, and subjectIds values are single strings, so the ids live in the payload.
            subjectIds: {},
            payload: {
              queued: queuedIds.length,
              subscriptionIds: queuedIds,
              skipped,
              ...(simulated && { simulated: true }),
            },
            simulated,
          },
          tx,
        );
      }

      this.d.log.info(
        { merchantId: input.merchantId, queued: queuedIds.length, skipped: skipped.length },
        "winback batch finished",
      );
      return { queued: queuedIds.length, skipped };
    });
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

  private async audit(
    tx: Tx | undefined,
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
