import {
  NotificationContent,
  parseDomainEventPayload,
  type ActionEngine,
  type Audit,
  type DomainEvent,
  type DomainEvents,
  type DunningCase,
  type Notifier,
  type PlanInfo,
  type PolicyStore,
  type SubscriptionSnapshot,
} from "@keepwell/contracts";
import type { RecoveryConfig } from "./config.js";
import { isPositive, messageDueAt, selectPlaybook } from "./playbooks.js";
import {
  identityPersonalise,
  type DunningStore,
  type JobQueue,
  type PersonaliseCopy,
  type PlanCatalog,
  type RecoveryDb,
  type RecoveryLogger,
  type SubscriptionSource,
} from "./ports.js";

// Recovery engine (ARCHITECTURE.md §6.9). All writes happen inside db.forMerchant, and every side
// effect (case change, message requested or withdrawn, capture requested) writes an audit entry in
// the same transaction. No PayPal mutation is made here: the capture is an Action. The one PayPal
// read (the subscriber's email) happens outside transactions, so a slow call holds no locks.

export interface RecoveryServiceOptions<Tx> {
  db: RecoveryDb<Tx>;
  store: DunningStore<Tx>;
  subscriptions: SubscriptionSource<Tx>;
  plans: PlanCatalog;
  /** Read for the sending-limit downgrade rule. */
  policies: Pick<PolicyStore, "current">;
  notifier: Notifier<Tx>;
  actions: ActionEngine<Tx>;
  audit: Audit<Tx>;
  jobs: JobQueue<Tx>;
  config: RecoveryConfig;
  log: RecoveryLogger;
  personalise?: PersonaliseCopy;
  clock?: () => Date;
}

interface QueueOptions {
  /** Only act on this failure (a stale dunning.evaluate job for an older failure is a no-op). */
  failedCount?: number;
  /** The time machine: send now and replace any message already waiting for the retry date. */
  timeShifted?: boolean;
}

/**
 * How long after a Keepwell suspend a SUSPENDED status change is still that pause.
 * The engine stamps `updatedAt` when the Action reaches APPLIED or CONFIRMED. The webhook
 * or the reconciler usually sees PayPal's new status within a minute of that. Fifteen
 * minutes covers a delayed webhook and one slow sweep, and is short enough that an older
 * pause cannot mask a later failure-threshold suspension of the same subscription.
 */
export const VOLUNTARY_SUSPEND_WINDOW_MS = 15 * 60 * 1000;

/** A threshold suspension has a failed attempt or money still owed. A zero balance is neither. */
function hasFailureEvidence(snapshot: SubscriptionSnapshot | null): boolean {
  if (!snapshot) return false;
  if (snapshot.failedPaymentsCount > 0) return true;
  const balance = snapshot.outstandingBalance;
  return balance !== null && isPositive(balance.value);
}

export class RecoveryService<Tx = unknown> {
  private readonly o: RecoveryServiceOptions<Tx>;
  private readonly clock: () => Date;
  private readonly personalise: PersonaliseCopy;

  constructor(options: RecoveryServiceOptions<Tx>) {
    this.o = options;
    this.clock = options.clock ?? (() => new Date());
    this.personalise = options.personalise ?? identityPersonalise;
  }

  /** Subscribes the three named handlers. The platform dispatcher keys retries on these names. */
  register(events: Pick<DomainEvents, "on">): void {
    events.on("subscription.payment_failed", "recovery.payment_failed", (e) => this.onPaymentFailed(e));
    events.on("subscription.payment_completed", "recovery.payment_completed", (e) =>
      this.onPaymentCompleted(e),
    );
    events.on("subscription.status_changed", "recovery.status_changed", (e) => this.onStatusChanged(e));
  }

  /** Opens or updates the case, then hands the timing decision to the dunning.evaluate job. */
  async onPaymentFailed(event: DomainEvent<"subscription.payment_failed">): Promise<void> {
    const p = parseDomainEventPayload("subscription.payment_failed", event.payload);
    const { merchantId } = event;
    const now = this.clock();
    await this.o.db.forMerchant(merchantId, async (tx) => {
      const existing = await this.o.store.findActive(tx, merchantId, p.subscriptionId);
      const playbook = selectPlaybook(p.reasonCode);
      let c: DunningCase;
      if (!existing) {
        c = await this.o.store.insert(tx, {
          merchantId,
          subscriptionId: p.subscriptionId,
          reasonCode: p.reasonCode,
          failedCount: p.failedCount,
          nextRetryTime: p.nextRetryTime,
          playbook,
          state: "open",
          outstanding: null,
          recoveredAmount: null,
          notificationId: null,
          captureActionId: null,
          simulated: event.simulated,
          openedAt: now.toISOString(),
          updatedAt: now.toISOString(),
          resolvedAt: null,
        });
        await this.audit(tx, c, "dunning.case_opened", { reasonCode: p.reasonCode, playbook });
      } else if (existing.state === "open" && p.failedCount > existing.failedCount) {
        // A new failure has new facts (the retry date), so the message is re-planned and the
        // old one, if still waiting in the outbox, is withdrawn.
        await this.withdraw(tx, existing, "newer_failure");
        c = await this.o.store.update(tx, merchantId, existing.id, {
          reasonCode: p.reasonCode,
          failedCount: p.failedCount,
          nextRetryTime: p.nextRetryTime,
          playbook,
          notificationId: null,
          simulated: existing.simulated || event.simulated,
          updatedAt: now.toISOString(),
        });
        await this.audit(tx, c, "dunning.case_updated", { reasonCode: p.reasonCode, playbook });
      } else {
        // Same or older failure count: a duplicate or out-of-order delivery. Nothing to do.
        this.o.log.info(
          { merchantId, subscriptionId: p.subscriptionId, failedCount: p.failedCount },
          "duplicate payment_failed ignored",
        );
        return;
      }
      await this.o.jobs.send(
        "dunning.evaluate",
        { subscriptionId: c.subscriptionId, failedCount: c.failedCount },
        tx,
      );
    });
  }

  /** Job handler for dunning.evaluate. A stale failedCount (a newer failure replaced it) is a no-op. */
  async evaluate(merchantId: string, job: { subscriptionId: string; failedCount: number }): Promise<void> {
    await this.queueMessage(merchantId, job.subscriptionId, { failedCount: job.failedCount });
  }

  /** Called by the M1 due-work sweep: finds cases whose message time passed with no message queued. */
  async sweepDueWork(): Promise<number> {
    const now = this.clock();
    const pending = await this.o.db.acrossMerchants((tx) => this.o.store.listUnnotified(tx));
    let requested = 0;
    for (const c of pending) {
      if (new Date(messageDueAt(c.nextRetryTime, now)).getTime() > now.getTime()) continue;
      try {
        if ((await this.queueMessage(c.merchantId, c.subscriptionId, {})) !== null) requested++;
      } catch (err) {
        // One bad case must not starve the rest; the next sweep tries again.
        this.o.log.error(
          { err, merchantId: c.merchantId, subscriptionId: c.subscriptionId },
          "dunning sweep failed for case",
        );
      }
    }
    return requested;
  }

  /** Time machine (Judge Mode "advance to the retry"): send the pending message now, flagged simulated. */
  async sendDunningNow(
    merchantId: string,
    subscriptionId: string,
  ): Promise<{ notificationId: string | null }> {
    return { notificationId: await this.queueMessage(merchantId, subscriptionId, { timeShifted: true }) };
  }

  async onPaymentCompleted(event: DomainEvent<"subscription.payment_completed">): Promise<void> {
    const p = parseDomainEventPayload("subscription.payment_completed", event.payload);
    const { merchantId } = event;
    await this.o.db.forMerchant(merchantId, async (tx) => {
      const existing = await this.o.store.findActive(tx, merchantId, p.subscriptionId);
      // No case: an ordinary renewal. A closed case: a duplicate of an event already handled.
      if (!existing) return;
      const now = this.clock().toISOString();
      // The subscriber has paid: a reminder still waiting in the outbox would only confuse them.
      await this.withdraw(tx, existing, "recovered");
      let c = await this.o.store.update(tx, merchantId, existing.id, {
        state: "recovered",
        recoveredAmount: p.amount,
        resolvedAt: now,
        updatedAt: now,
      });
      await this.audit(tx, c, "dunning.case_recovered", { recoveredAmount: p.amount });

      const snapshot = await this.o.subscriptions.snapshot(tx, merchantId, p.subscriptionId);
      const balance = snapshot?.outstandingBalance;
      if (snapshot?.status !== "ACTIVE" || !balance || !isPositive(balance.value)) return;
      const action = await this.o.actions.create(
        {
          type: "capture_outstanding",
          merchantId,
          subscriptionId: p.subscriptionId,
          params: { amount: balance },
          origin: "recovery",
          idempotencyKey: `recovery-capture:${c.id}`,
          simulated: c.simulated,
        },
        tx,
      );
      c = await this.o.store.update(tx, merchantId, c.id, {
        captureActionId: action.id,
        outstanding: balance,
        updatedAt: now,
      });
      await this.audit(tx, c, "dunning.capture_requested", { amount: balance }, { actionId: action.id });
      this.o.log.info(
        { merchantId, subscriptionId: p.subscriptionId, actionId: action.id },
        "capture requested",
      );
    });
  }

  async onStatusChanged(event: DomainEvent<"subscription.status_changed">): Promise<void> {
    const p = parseDomainEventPayload("subscription.status_changed", event.payload);
    const { merchantId } = event;
    if (p.to === "SUSPENDED") return this.suspend(merchantId, p.subscriptionId);
    if (p.to !== "CANCELLED" && p.to !== "EXPIRED") return;
    await this.o.db.forMerchant(merchantId, async (tx) => {
      const c = await this.o.store.findActive(tx, merchantId, p.subscriptionId);
      if (!c) return;
      const now = this.clock().toISOString();
      await this.withdraw(tx, c, "subscription_ended");
      const updated = await this.o.store.update(tx, merchantId, c.id, {
        state: "closed",
        resolvedAt: now,
        updatedAt: now,
      });
      await this.audit(tx, updated, "dunning.case_closed", { subscriptionStatus: p.to });
    });
  }

  // ---------- internals ----------

  private async suspend(merchantId: string, subscriptionId: string): Promise<void> {
    const gate = await this.o.db.forMerchant(merchantId, (tx) =>
      this.suspensionGate(tx, merchantId, subscriptionId),
    );
    if (gate !== "send") return;
    // PayPal is read outside the transaction. The gate runs again afterwards: a pause Action
    // can commit while this call is in flight.
    const email = await this.o.subscriptions.email(merchantId, subscriptionId);
    await this.o.db.forMerchant(merchantId, async (tx) => {
      if ((await this.suspensionGate(tx, merchantId, subscriptionId)) !== "send") return;
      const c = await this.o.store.findActive(tx, merchantId, subscriptionId, { lock: true });
      if (c?.state !== "open") return;
      await this.withdraw(tx, c, "suspended");
      const updated = await this.o.store.update(tx, merchantId, c.id, {
        state: "suspended",
        notificationId: null,
        updatedAt: this.clock().toISOString(),
      });
      await this.audit(tx, updated, "dunning.case_suspended", {});
      const snapshot = await this.o.subscriptions.snapshot(tx, merchantId, subscriptionId);
      if (!email || !snapshot) {
        this.o.log.warn(
          { merchantId, subscriptionId },
          "no email or snapshot, reactivation message not queued",
        );
        return;
      }
      const content = NotificationContent.parse(
        await this.personalise.personalise({
          template: "dunning.reactivate",
          payload: {
            firstName: snapshot.subscriberFirstName,
            planName: snapshot.planName,
            portalUrl: this.o.config.portalUrl,
          },
        }),
      );
      const notificationId = await this.o.notifier.enqueue(
        {
          merchantId,
          subscriptionId,
          to: email,
          content,
          dueAt: this.clock().toISOString(),
          simulated: updated.simulated,
        },
        tx,
      );
      await this.audit(
        tx,
        updated,
        "dunning.notification_requested",
        { template: content.template },
        { notificationId },
      );
    });
  }

  /**
   * "send" only for PayPal's failure-threshold suspension. A pause we just applied leaves the
   * case open: the next failed renewal still has to find it (see the module README).
   */
  private async suspensionGate(tx: Tx, merchantId: string, subscriptionId: string): Promise<"send" | "held"> {
    const c = await this.o.store.findActive(tx, merchantId, subscriptionId);
    if (c?.state !== "open") return "held";
    const since = new Date(this.clock().getTime() - VOLUNTARY_SUSPEND_WINDOW_MS);
    const voluntary = await this.o.store.findRecentVoluntarySuspend(tx, merchantId, subscriptionId, since);
    if (voluntary) {
      // The case stays open, so a second delivery of this event would append the note again
      // unless we hold the row across the check and the audit.
      const locked = await this.o.store.findActive(tx, merchantId, subscriptionId, { lock: true });
      if (locked?.state !== "open") return "held";
      if (!(await this.o.store.voluntarySuspendNoted(tx, merchantId, voluntary.id))) {
        await this.audit(
          tx,
          locked,
          "dunning.voluntary_suspend",
          {
            actionId: voluntary.id,
            reason: "status change was a voluntary suspend, not a PayPal failure-threshold suspension",
          },
          { actionId: voluntary.id },
        );
      }
      this.o.log.info(
        { merchantId, subscriptionId, actionId: voluntary.id },
        "status change is a voluntary suspend, reactivation message not sent",
      );
      return "held";
    }
    const snapshot = await this.o.subscriptions.snapshot(tx, merchantId, subscriptionId);
    if (!hasFailureEvidence(snapshot)) {
      this.o.log.info(
        { merchantId, subscriptionId, failedPaymentsCount: snapshot?.failedPaymentsCount ?? null },
        "suspension has no failed payment or outstanding balance, reactivation message not sent",
      );
      return "held";
    }
    return "send";
  }

  /**
   * Queues the playbook's message. Returns its id, or null when nothing was queued (the reason is
   * logged). Two short transactions around the email lookup: the second re-reads the case under a
   * row lock, so a concurrent evaluate, sweep or time-machine call can't queue a second message.
   */
  private async queueMessage(
    merchantId: string,
    subscriptionId: string,
    opts: QueueOptions,
  ): Promise<string | null> {
    const ids = { merchantId, subscriptionId };
    const eligible = (c: DunningCase | null): boolean =>
      c?.state === "open" &&
      c.playbook !== "wait_for_retry" &&
      (opts.failedCount === undefined || c.failedCount === opts.failedCount) &&
      (opts.timeShifted === true || c.notificationId === null);

    const peek = await this.o.db.forMerchant(merchantId, (tx) =>
      this.o.store.findActive(tx, merchantId, subscriptionId),
    );
    if (peek === null || !eligible(peek)) {
      if (peek?.playbook === "wait_for_retry") this.o.log.info(ids, "no message: PayPal retries on its own");
      return null;
    }
    const email = await this.o.subscriptions.email(merchantId, subscriptionId);
    if (!email) {
      this.o.log.warn(ids, "no subscriber email available, dunning message not queued");
      return null;
    }

    const now = this.clock();
    return this.o.db.forMerchant(merchantId, async (tx) => {
      const c = await this.o.store.findActive(tx, merchantId, subscriptionId, { lock: true });
      if (c === null || !eligible(c)) return null;
      const snapshot = await this.o.subscriptions.snapshot(tx, merchantId, subscriptionId);
      if (!snapshot) {
        this.o.log.warn(ids, "no subscription snapshot, dunning message not queued");
        return null;
      }
      const timeShifted = opts.timeShifted === true;
      // The time machine replaces a message that was waiting for the retry date.
      if (timeShifted) await this.withdraw(tx, c, "time_shift");
      const content = NotificationContent.parse(
        await this.personalise.personalise(await this.buildContent(c, snapshot)),
      );
      const simulated = c.simulated || timeShifted;
      const dueAt = timeShifted ? now.toISOString() : messageDueAt(c.nextRetryTime, now);
      const notificationId = await this.o.notifier.enqueue(
        { merchantId, subscriptionId, to: email, content, dueAt, simulated },
        tx,
      );
      const updated = await this.o.store.update(tx, merchantId, c.id, {
        notificationId,
        updatedAt: now.toISOString(),
      });
      await this.audit(
        tx,
        updated,
        "dunning.notification_requested",
        { template: content.template, dueAt, ...(timeShifted && { timeShifted: true }) },
        { notificationId },
        simulated,
      );
      return notificationId;
    });
  }

  /** Withdraws the case's queued message, if any and still unsent. Audited when something changed. */
  private async withdraw(tx: Tx, c: DunningCase, because: string): Promise<void> {
    if (c.notificationId === null) return;
    const withdrawn = await this.o.notifier.supersede(c.merchantId, c.notificationId, tx);
    if (withdrawn) {
      await this.audit(
        tx,
        c,
        "dunning.notification_withdrawn",
        { because },
        { notificationId: c.notificationId },
      );
    }
  }

  private buildContent(c: DunningCase, s: SubscriptionSnapshot): Promise<NotificationContent> {
    // Facts come from the snapshot, never from a model.
    const base = { firstName: s.subscriberFirstName, planName: s.planName };
    const amount = s.outstandingBalance ?? s.priceOverride ?? s.price;
    const retryAt = c.nextRetryTime;
    const { paypalWebUrl, portalUrl } = this.o.config;
    switch (c.playbook) {
      case "update_payment_method":
        return Promise.resolve({
          template: "dunning.update_payment_method",
          payload: {
            ...base,
            amount,
            retryAt,
            updatePaymentUrl: `${paypalWebUrl}/myaccount/autopay/connect/${s.paypalSubscriptionId}`,
          },
        });
      case "account_restricted":
        return Promise.resolve({
          template: "dunning.account_restricted",
          payload: { ...base, amount, resolutionUrl: `${paypalWebUrl}/resolutioncenter` },
        });
      case "sending_limit":
        return this.smallerPlan(c.merchantId, s).then((smallerPlan) => ({
          template: "dunning.sending_limit",
          payload: { ...base, amount, retryAt, smallerPlan },
        }));
      default:
        return Promise.resolve({
          template: "dunning.generic",
          payload: { ...base, amount, retryAt, helpUrl: `${portalUrl}/help` },
        });
    }
  }

  /** Only when the merchant's policy allows a downgrade from this plan; the smallest step down. */
  private async smallerPlan(
    merchantId: string,
    s: SubscriptionSnapshot,
  ): Promise<{ name: string; price: PlanInfo["price"] } | null> {
    const policy = await this.o.policies.current(merchantId);
    const downgrade = policy?.document.offers.downgrade;
    if (!downgrade?.enabled) return null;
    const allowed = downgrade.targets[s.paypalPlanId] ?? [];
    if (allowed.length === 0) return null;
    const cents = (m: PlanInfo["price"]) => BigInt(m.value.replace(".", ""));
    const candidates = (await this.o.plans.plans(merchantId))
      .filter((p) => allowed.includes(p.planId) && p.price.currency === s.price.currency)
      .filter((p) => cents(p.price) < cents(s.price))
      .sort((a, b) => Number(cents(b.price) - cents(a.price)));
    const pick = candidates[0];
    return pick ? { name: pick.name, price: pick.price } : null;
  }

  private async audit(
    tx: Tx,
    c: DunningCase,
    kind: string,
    payload: Record<string, unknown>,
    extraIds: Record<string, string> = {},
    simulated: boolean = c.simulated,
  ): Promise<void> {
    await this.o.audit.append(
      {
        merchantId: c.merchantId,
        actor: "system",
        kind,
        subjectIds: { subscriptionId: c.subscriptionId, dunningCaseId: c.id, ...extraIds },
        payload,
        simulated,
      },
      tx,
    );
  }
}
