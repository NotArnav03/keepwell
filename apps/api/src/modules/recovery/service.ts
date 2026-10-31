import {
  NotificationContent,
  growthJobs,
  parseDomainEventPayload,
  type Audit,
  type DomainEvent,
  type DomainEvents,
  type DunningCase,
  type Notifier,
  type ActionEngine,
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
  type SubscriberView,
  type SubscriptionSource,
} from "./ports.js";

// Recovery engine (ARCHITECTURE.md §6.9). All writes happen inside db.forMerchant, and every side
// effect (case change, message requested, capture requested) writes an audit entry in the same
// transaction. No PayPal call is made here: the capture is an Action.

export interface RecoveryServiceOptions<Tx> {
  db: RecoveryDb<Tx>;
  store: DunningStore<Tx>;
  subscriptions: SubscriptionSource<Tx>;
  plans: PlanCatalog;
  /** Read for the sending-limit downgrade rule. */
  policies: PolicyStore;
  notifier: Notifier<Tx>;
  actions: ActionEngine<Tx>;
  audit: Audit<Tx>;
  jobs: JobQueue<Tx>;
  config: RecoveryConfig;
  log: RecoveryLogger;
  personalise?: PersonaliseCopy;
  clock?: () => Date;
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
  register(events: DomainEvents): void {
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
        // A new failure has new facts (retry date), so the message is re-planned. The old queued
        // one can't be withdrawn (Notifier has no cancel); the 1/day cap stops a double send.
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
      const payload = { subscriptionId: c.subscriptionId, failedCount: c.failedCount };
      await this.o.jobs.send(
        "dunning.evaluate",
        payload,
        growthJobs["dunning.evaluate"].idempotencyKey(payload),
        tx,
      );
    });
  }

  /** Job handler for dunning.evaluate. A stale failedCount (a newer failure replaced it) is a no-op. */
  async evaluate(merchantId: string, job: { subscriptionId: string; failedCount: number }): Promise<void> {
    await this.o.db.forMerchant(merchantId, async (tx) => {
      const c = await this.o.store.findActive(tx, merchantId, job.subscriptionId);
      // A message already queued means this is a duplicate run (or the sweep got there first).
      if (c?.state !== "open" || c.failedCount !== job.failedCount || c.notificationId !== null) return;
      await this.requestMessage(tx, c, this.clock());
    });
  }

  /** Called by the M1 due-work sweep: finds cases whose message time passed with no message queued. */
  async sweepDueWork(): Promise<number> {
    const now = this.clock();
    const pending = await this.o.db.acrossMerchants((tx) => this.o.store.listUnnotified(tx));
    const due = pending.filter(
      (c) => new Date(messageDueAt(c.nextRetryTime, now)).getTime() <= now.getTime(),
    );
    let requested = 0;
    for (const c of due) {
      try {
        const done = await this.o.db.forMerchant(c.merchantId, async (tx) => {
          // Re-read: the evaluate job may have won the race since the list was taken.
          const fresh = await this.o.store.findActive(tx, c.merchantId, c.subscriptionId);
          if (fresh?.state !== "open" || fresh.notificationId !== null) return false;
          return (await this.requestMessage(tx, fresh, now)) !== null;
        });
        if (done) requested++;
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
    const now = this.clock();
    return this.o.db.forMerchant(merchantId, async (tx) => {
      const c = await this.o.store.findActive(tx, merchantId, subscriptionId);
      if (c?.state !== "open") return { notificationId: null };
      const notificationId = await this.requestMessage(tx, c, now, { timeShifted: true });
      return { notificationId };
    });
  }

  async onPaymentCompleted(event: DomainEvent<"subscription.payment_completed">): Promise<void> {
    const p = parseDomainEventPayload("subscription.payment_completed", event.payload);
    const { merchantId } = event;
    await this.o.db.forMerchant(merchantId, async (tx) => {
      const existing = await this.o.store.findActive(tx, merchantId, p.subscriptionId);
      // No case: an ordinary renewal. A closed case: a duplicate of an event already handled.
      if (!existing) return;
      const now = this.clock().toISOString();
      let c = await this.o.store.update(tx, merchantId, existing.id, {
        state: "recovered",
        recoveredAmount: p.amount,
        resolvedAt: now,
        updatedAt: now,
      });
      await this.audit(tx, c, "dunning.case_recovered", { recoveredAmount: p.amount });

      const view = await this.o.subscriptions.get(tx, merchantId, p.subscriptionId);
      const balance = view?.snapshot.outstandingBalance;
      if (view?.snapshot.status !== "ACTIVE" || !balance || !isPositive(balance.value)) return;
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
    await this.o.db.forMerchant(merchantId, async (tx) => {
      const c = await this.o.store.findActive(tx, merchantId, p.subscriptionId);
      if (!c) return;
      const now = this.clock().toISOString();
      if (p.to === "SUSPENDED" && c.state === "open") {
        const updated = await this.o.store.update(tx, merchantId, c.id, {
          state: "suspended",
          updatedAt: now,
        });
        await this.audit(tx, updated, "dunning.case_suspended", {});
        await this.requestReactivation(tx, updated);
      } else if (p.to === "CANCELLED" || p.to === "EXPIRED") {
        const updated = await this.o.store.update(tx, merchantId, c.id, {
          state: "closed",
          resolvedAt: now,
          updatedAt: now,
        });
        await this.audit(tx, updated, "dunning.case_closed", { subscriptionStatus: p.to });
      }
    });
  }

  // ---------- internals ----------

  /** Queues the playbook's message. Returns its id, or null when nothing was queued (reason is logged). */
  private async requestMessage(
    tx: Tx,
    c: DunningCase,
    now: Date,
    opts: { timeShifted?: boolean } = {},
  ): Promise<string | null> {
    const ids = { merchantId: c.merchantId, subscriptionId: c.subscriptionId };
    if (c.playbook === "wait_for_retry") {
      this.o.log.info(ids, "no message: PayPal retries on its own");
      return null;
    }
    const view = await this.o.subscriptions.get(tx, c.merchantId, c.subscriptionId);
    if (!view?.email) {
      this.o.log.warn(ids, "no subscriber email available, dunning message not queued");
      return null;
    }
    const content = NotificationContent.parse(
      await this.personalise.personalise(await this.buildContent(c, view)),
    );
    const timeShifted = opts.timeShifted === true;
    const simulated = c.simulated || timeShifted;
    const dueAt = timeShifted ? now.toISOString() : messageDueAt(c.nextRetryTime, now);
    const notificationId = await this.o.notifier.enqueue(
      {
        merchantId: c.merchantId,
        subscriptionId: c.subscriptionId,
        to: view.email,
        content,
        dueAt,
        simulated,
      },
      tx,
    );
    const updated = await this.o.store.update(tx, c.merchantId, c.id, {
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
  }

  private async requestReactivation(tx: Tx, c: DunningCase): Promise<void> {
    const view = await this.o.subscriptions.get(tx, c.merchantId, c.subscriptionId);
    if (!view?.email) {
      this.o.log.warn(
        { merchantId: c.merchantId, subscriptionId: c.subscriptionId },
        "no subscriber email available, reactivation message not queued",
      );
      return;
    }
    const content = NotificationContent.parse(
      await this.personalise.personalise({
        template: "dunning.reactivate",
        payload: {
          firstName: view.snapshot.subscriberFirstName,
          planName: view.snapshot.planName,
          portalUrl: this.o.config.portalUrl,
        },
      }),
    );
    const notificationId = await this.o.notifier.enqueue(
      {
        merchantId: c.merchantId,
        subscriptionId: c.subscriptionId,
        to: view.email,
        content,
        dueAt: this.clock().toISOString(),
        simulated: c.simulated,
      },
      tx,
    );
    await this.audit(
      tx,
      c,
      "dunning.notification_requested",
      { template: content.template },
      { notificationId },
    );
  }

  private async buildContent(c: DunningCase, view: SubscriberView): Promise<NotificationContent> {
    const s = view.snapshot;
    // Facts come from the snapshot, never from a model.
    const base = { firstName: s.subscriberFirstName, planName: s.planName };
    const amount = s.outstandingBalance ?? s.priceOverride ?? s.price;
    const retryAt = c.nextRetryTime;
    const { paypalWebUrl, portalUrl } = this.o.config;
    switch (c.playbook) {
      case "update_payment_method":
        return {
          template: "dunning.update_payment_method",
          payload: {
            ...base,
            amount,
            retryAt,
            updatePaymentUrl: `${paypalWebUrl}/myaccount/autopay/connect/${s.paypalSubscriptionId}`,
          },
        };
      case "account_restricted":
        return {
          template: "dunning.account_restricted",
          payload: { ...base, amount, resolutionUrl: `${paypalWebUrl}/resolutioncenter` },
        };
      case "sending_limit":
        return {
          template: "dunning.sending_limit",
          payload: { ...base, amount, retryAt, smallerPlan: await this.smallerPlan(c.merchantId, s) },
        };
      default:
        return {
          template: "dunning.generic",
          payload: { ...base, amount, retryAt, helpUrl: `${portalUrl}/help` },
        };
    }
  }

  /** Only when the merchant's policy allows a downgrade from this plan; the cheapest allowed target. */
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
    // The most expensive allowed plan that is still cheaper: the smallest step down.
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
