import { and, eq } from "drizzle-orm";
import type { PolicyDocument } from "@keepwell/contracts";
import { actions, merchants, policies, type Db } from "@keepwell/db";
import { pantryPlanPolicy } from "@keepwell/policy";
import type { DbActionEngine } from "./modules/actions/engine.js";
import type { PayPalClient } from "./modules/paypal/client.js";
import type { Reconciler } from "./modules/reconcile/reconciler.js";

// The demo merchant, Pantry Plan, set up end to end (#15): the merchant row, its product and
// three plans at PayPal, our webhook registered, policy v1 published, and every existing
// subscription imported. Safe to run again: each step looks for what exists before creating it.
// Plans are created as create_plan Actions, so even the seed's PayPal changes are audited.

export const PANTRY_PLANS = [
  { key: "lite", name: "Lite", price: "6.00", interval: { unit: "MONTH", count: 1 } },
  { key: "standard", name: "Standard", price: "12.00", interval: { unit: "MONTH", count: 1 } },
  { key: "standardAnnual", name: "Standard Annual", price: "120.00", interval: { unit: "YEAR", count: 1 } },
] as const;

/** The event types the webhook pipeline reads (ARCHITECTURE.md §6.2). */
export const WEBHOOK_EVENT_TYPES = [
  "BILLING.SUBSCRIPTION.CREATED",
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.EXPIRED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "PAYMENT.SALE.COMPLETED",
  "PAYMENT.SALE.REFUNDED",
  "PAYMENT.SALE.REVERSED",
];

export interface SeedDeps {
  db: Db;
  paypal: Pick<PayPalClient, "listPlans" | "createProduct" | "listWebhooks" | "createWebhook">;
  engine: DbActionEngine;
  reconciler: Pick<Reconciler, "sweep">;
  log: { info(obj: object, msg: string): void };
}

export interface SeedOptions {
  merchantId: string;
  /** The merchant's URL name, unique across merchants. Default "pantry-plan". */
  slug?: string;
  /** Where PayPal delivers our webhooks: API_PUBLIC_URL + /webhooks/paypal/<merchantId>. */
  webhookUrl: string;
}

export interface SeedResult {
  createdMerchant: boolean;
  createdPlans: string[];
  planIds: Record<(typeof PANTRY_PLANS)[number]["key"], string>;
  webhookId: string;
  policyVersion: number;
  importedSubscriptions: number;
}

export async function seedDemoMerchant(deps: SeedDeps, options: SeedOptions): Promise<SeedResult> {
  const { db, paypal, engine, log } = deps;
  const { merchantId } = options;

  const createdMerchant = await db.forMerchant(merchantId, async (tx) => {
    const rows = await tx
      .insert(merchants)
      .values({ id: merchantId, slug: options.slug ?? "pantry-plan", name: "Pantry Plan", mode: "demo" })
      // Only an existing row with this id counts as "already seeded"; a slug taken by another
      // merchant is an error, not something to skip quietly.
      .onConflictDoNothing({ target: merchants.id })
      .returning({ id: merchants.id });
    return rows.length > 0;
  });

  // Plans: reuse any with the right name; otherwise create them on one product.
  const existing = await paypal.listPlans(merchantId);
  const byName = new Map(existing.filter((p) => p.status === "ACTIVE").map((p) => [p.name, p]));
  let productId = existing[0]?.productId ?? null;
  const planIds = {} as SeedResult["planIds"];
  const createdPlans: string[] = [];
  for (const plan of PANTRY_PLANS) {
    const found = byName.get(plan.name);
    if (found) {
      planIds[plan.key] = found.id;
      continue;
    }
    productId ??= (
      await paypal.createProduct(merchantId, { name: "Pantry Plan", requestId: `seed:product:${merchantId}` })
    ).id;
    const action = await engine.create({
      merchantId,
      subscriptionId: null,
      type: "create_plan",
      origin: "demo",
      params: {
        productId,
        name: plan.name,
        price: { value: plan.price, currency: "USD" },
        interval: plan.interval,
      },
      idempotencyKey: `seed:plan:${plan.key}`,
    });
    await engine.execute(merchantId, action.id);
    const { state, planId } = await createdPlan(db, merchantId, action.id);
    if (planId === null) throw new Error(`Creating plan ${plan.name} didn't complete (${state})`);
    planIds[plan.key] = planId;
    createdPlans.push(planId);
  }

  // Our webhook: one registration for our intake URL.
  const hooks = await paypal.listWebhooks(merchantId);
  const webhookId =
    hooks.find((h) => h.url === options.webhookUrl)?.id ??
    (await paypal.createWebhook(merchantId, { url: options.webhookUrl, eventTypes: WEBHOOK_EVENT_TYPES })).id;

  // Policy v1, unless one is already published.
  const policyVersion = await db.forMerchant(merchantId, async (tx) => {
    await tx.update(merchants).set({ webhookId }).where(eq(merchants.id, merchantId));
    const [current] = await tx
      .select({ version: policies.version })
      .from(policies)
      .where(and(eq(policies.merchantId, merchantId), eq(policies.version, 1)));
    if (current) return current.version;
    const document: PolicyDocument = pantryPlanPolicy(planIds);
    await tx
      .insert(policies)
      .values({ merchantId, version: 1, document, publishedBy: "system", changeNote: "Seed" });
    await tx.update(merchants).set({ activePolicyVersion: 1 }).where(eq(merchants.id, merchantId));
    return 1;
  });

  // Every subscription PayPal already has, imported through the normal sync.
  const importedSubscriptions = await deps.reconciler.sweep(merchantId);

  const result = { createdMerchant, createdPlans, planIds, webhookId, policyVersion, importedSubscriptions };
  log.info(result, "seeded Pantry Plan");
  return result;
}

/** A create_plan Action's state, and PayPal's new plan id from its result (plans.ts). */
async function createdPlan(
  db: Db,
  merchantId: string,
  actionId: string,
): Promise<{ state: string; planId: string | null }> {
  const [row] = await db.forMerchant(merchantId, (tx) =>
    tx.select({ state: actions.state, result: actions.result }).from(actions).where(eq(actions.id, actionId)),
  );
  const result = row?.result;
  const planId =
    row?.state === "CONFIRMED" &&
    typeof result === "object" &&
    result !== null &&
    "planId" in result &&
    typeof result.planId === "string"
      ? result.planId
      : null;
  return { state: row?.state ?? "missing", planId };
}
