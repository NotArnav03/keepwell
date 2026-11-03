import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  ActionParams,
  PolicyDocument,
  PolicyError,
  PolicyVersionSummary,
  StoredPolicy,
  SubscriptionSnapshot,
  type PlanInfo,
  type PolicyStore,
  type PublishPolicyInput,
  type SubscriberHistory,
} from "@keepwell/contracts";
import {
  actions,
  merchants,
  plans,
  scheduledResumes,
  subscriptions,
  policies,
  type Db,
  type Tx,
} from "@keepwell/db";
import type { MerchantCatalog } from "./service.js";

/** Postgres persistence for immutable policy versions, serialized per merchant. */
export class DbPolicyStore implements PolicyStore<Tx> {
  constructor(private readonly db: Db) {}

  async current(merchantId: string): Promise<StoredPolicy | null> {
    const [row] = await this.db.forMerchant(merchantId, (tx) =>
      tx
        .select()
        .from(policies)
        .where(eq(policies.merchantId, merchantId))
        .orderBy(desc(policies.version))
        .limit(1),
    );
    return row ? this.toStored(row) : null;
  }

  async get(merchantId: string, version: number): Promise<StoredPolicy | null> {
    const [row] = await this.db.forMerchant(merchantId, (tx) =>
      tx
        .select()
        .from(policies)
        .where(and(eq(policies.merchantId, merchantId), eq(policies.version, version)))
        .limit(1),
    );
    return row ? this.toStored(row) : null;
  }

  async list(merchantId: string): Promise<PolicyVersionSummary[]> {
    const rows = await this.db.forMerchant(merchantId, (tx) =>
      tx
        .select({
          version: policies.version,
          publishedAt: policies.publishedAt,
          publishedBy: policies.publishedBy,
          changeNote: policies.changeNote,
        })
        .from(policies)
        .where(eq(policies.merchantId, merchantId))
        .orderBy(desc(policies.version)),
    );
    return rows.map((row) =>
      PolicyVersionSummary.parse({ ...row, publishedAt: row.publishedAt.toISOString() }),
    );
  }

  async publish(input: PublishPolicyInput, tx?: Tx): Promise<StoredPolicy> {
    if (!tx) return this.db.forMerchant(input.merchantId, (scoped) => this.publish(input, scoped));
    const merchantId = input.merchantId;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`policy:${merchantId}`}, 0))`);
    const [latest] = await tx
      .select({ version: policies.version })
      .from(policies)
      .where(eq(policies.merchantId, merchantId))
      .orderBy(desc(policies.version))
      .limit(1);
    const currentVersion = latest?.version ?? null;
    if (currentVersion !== input.baseVersion) {
      throw new PolicyError("version_conflict", "A newer policy was published. Reload before publishing.");
    }
    const version = (currentVersion ?? 0) + 1;
    const document = PolicyDocument.parse({ ...input.document, version });
    const publishedAt = new Date();
    await tx.insert(policies).values({
      merchantId,
      version,
      document,
      publishedBy: input.publishedBy,
      changeNote: input.changeNote,
      publishedAt,
    });
    await tx.update(merchants).set({ activePolicyVersion: version }).where(eq(merchants.id, merchantId));
    return StoredPolicy.parse({
      merchantId,
      version,
      publishedAt: publishedAt.toISOString(),
      publishedBy: input.publishedBy,
      changeNote: input.changeNote,
      document,
    });
  }

  private toStored(row: typeof policies.$inferSelect): StoredPolicy {
    return StoredPolicy.parse({
      merchantId: row.merchantId,
      version: row.version,
      publishedAt: row.publishedAt.toISOString(),
      publishedBy: row.publishedBy,
      changeNote: row.changeNote,
      document: row.document,
    });
  }
}

/** Reads fresh plan and subscription data for PolicyService dry-runs. */
export class DbMerchantCatalog implements MerchantCatalog {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async plans(merchantId: string): Promise<PlanInfo[]> {
    const rows = await this.db.forMerchant(merchantId, (tx) =>
      tx
        .select()
        .from(plans)
        .where(and(eq(plans.merchantId, merchantId), eq(plans.status, "ACTIVE"))),
    );
    return rows.map((row) => ({
      planId: row.paypalPlanId,
      name: row.name,
      price: { value: row.priceValue, currency: row.priceCurrency },
      interval: { unit: row.intervalUnit, count: row.intervalCount },
    }));
  }

  async samples(
    merchantId: string,
    subscriptionIds: string[],
  ): Promise<{ subscription: SubscriptionSnapshot; history: SubscriberHistory }[]> {
    if (subscriptionIds.length === 0) return [];
    const now = this.clock();
    const yearAgo = new Date(now.getTime() - 365 * 86_400_000);
    const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
    const { subscriptionRows, actionRows, resumeRows } = await this.db.forMerchant(merchantId, async (tx) => {
      const subscriptionRows = await tx
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.merchantId, merchantId), inArray(subscriptions.id, subscriptionIds)));
      const actionRows = await tx
        .select()
        .from(actions)
        .where(
          and(
            eq(actions.merchantId, merchantId),
            inArray(actions.subscriptionId, subscriptionIds),
            gte(actions.createdAt, yearAgo),
          ),
        );
      const resumeRows = await tx
        .select()
        .from(scheduledResumes)
        .where(
          and(
            eq(scheduledResumes.merchantId, merchantId),
            inArray(scheduledResumes.subscriptionId, subscriptionIds),
            eq(scheduledResumes.status, "done"),
            gte(scheduledResumes.dueAt, yearAgo),
          ),
        )
        .orderBy(desc(scheduledResumes.dueAt));
      return { subscriptionRows, actionRows, resumeRows };
    });
    const subscriptionById = new Map(subscriptionRows.map((row) => [row.id, row]));
    const resumesById = new Map<string, (typeof resumeRows)[number]>();
    for (const resume of resumeRows)
      if (!resumesById.has(resume.subscriptionId)) resumesById.set(resume.subscriptionId, resume);
    return subscriptionIds.flatMap((id) => {
      const row = subscriptionById.get(id);
      if (!row) return [];
      const historyActions = actionRows.filter(
        (action) =>
          action.subscriptionId === id &&
          action.createdAt >= yearAgo &&
          action.state === "CONFIRMED" &&
          ["session", "insight"].includes(action.origin),
      );
      const refundAmounts = actionRows
        .filter(
          (action) =>
            action.subscriptionId === id &&
            action.type === "refund" &&
            action.createdAt >= monthAgo &&
            ["APPLIED", "CONFIRMED"].includes(action.state),
        )
        .map((action) => ActionParams.refund.safeParse(action.params))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data.amount)
        .filter((amount) => amount.currency === row.priceCurrency)
        .reduce((total, amount) => total + moneyCents(amount.value), 0n);
      const subscription = subscriptionFromRow(row);
      const history: SubscriberHistory = {
        savesLast365d: historyActions.filter((action) =>
          ["suspend", "revise", "patch_price", "refund"].includes(action.type),
        ).length,
        pausesLast365d: historyActions.filter((action) => action.type === "suspend").length,
        lastPauseEndedAt: resumesById.get(id)?.dueAt.toISOString() ?? null,
        refundedLast30d: { value: centsMoney(refundAmounts), currency: row.priceCurrency },
      };
      return [{ subscription, history }];
    });
  }
}

function subscriptionFromRow(row: typeof subscriptions.$inferSelect): SubscriptionSnapshot {
  const money = (value: string | null, currency: string | null) =>
    value === null || currency === null ? null : { value, currency };
  return SubscriptionSnapshot.parse({
    id: row.id,
    merchantId: row.merchantId,
    paypalSubscriptionId: row.paypalSubscriptionId,
    paypalPlanId: row.paypalPlanId,
    planName: row.planName,
    price: { value: row.priceValue, currency: row.priceCurrency },
    priceOverride: money(row.overrideValue, row.overrideCurrency),
    interval: { unit: row.intervalUnit, count: row.intervalCount },
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    nextBillingTime: row.nextBillingTime?.toISOString() ?? null,
    lastPayment:
      row.lastPaymentAt && row.lastPaymentValue && row.lastPaymentCurrency
        ? {
            amount: { value: row.lastPaymentValue, currency: row.lastPaymentCurrency },
            time: row.lastPaymentAt.toISOString(),
          }
        : null,
    outstandingBalance: money(row.outstandingValue, row.outstandingCurrency),
    failedPaymentsCount: row.failedPaymentsCount,
    lastFailure:
      row.lastFailureAt && row.lastFailureReason
        ? {
            reasonCode: row.lastFailureReason,
            time: row.lastFailureAt.toISOString(),
            nextRetryTime: row.nextRetryTime?.toISOString() ?? null,
          }
        : null,
    subscriberFirstName: row.subscriberFirstName,
    syncedAt: row.syncedAt.toISOString(),
  });
}

function moneyCents(value: string): bigint {
  const match = /^(\d+)\.(\d{2})$/.exec(value);
  if (!match) throw new Error("Stored money is not a two-decimal value");
  return BigInt(match[1] ?? "0") * 100n + BigInt(match[2] ?? "0");
}

function centsMoney(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}
