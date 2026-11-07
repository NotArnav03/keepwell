import { eq } from "drizzle-orm";
import type { ActionEngine, Audit, Notifier } from "@keepwell/contracts";
import { subscriptions, type Db, type Tx } from "@keepwell/db";
import type { DbDomainEvents } from "../jobs/domain-events.js";
import type { Jobs } from "../jobs/jobs.js";
import type { Reconciler } from "../reconcile/reconciler.js";
import { recoveryConfigFromEnv } from "./config.js";
import { PgPlanCatalog, PgPolicyReader, PgSubscriptionSource, type EmailGateway } from "./pg-source.js";
import { PgDunningStore } from "./pg-store.js";
import type { RecoveryLogger } from "./ports.js";
import { RecoveryService } from "./service.js";

// Plugs the recovery engine into the platform (platform.ts calls this once, before workers start).

export interface RecoveryMountDeps {
  db: Db;
  jobs: Pick<Jobs, "send" | "work">;
  events: Pick<DbDomainEvents, "on">;
  audit: Audit<Tx>;
  engine: ActionEngine<Tx>;
  reconciler: Pick<Reconciler, "registerDueWork">;
  paypal: EmailGateway;
  notifier: Notifier<Tx>;
  log: RecoveryLogger;
  env?: NodeJS.ProcessEnv;
}

export async function mountRecovery(d: RecoveryMountDeps): Promise<RecoveryService<Tx>> {
  const service = new RecoveryService<Tx>({
    db: d.db,
    store: new PgDunningStore(),
    subscriptions: new PgSubscriptionSource(d.db, d.paypal),
    plans: new PgPlanCatalog(d.db),
    policies: new PgPolicyReader(d.db),
    notifier: d.notifier,
    actions: d.engine,
    audit: d.audit,
    jobs: {
      send: async (name, payload, tx) => {
        await d.jobs.send(name, payload, tx ? { tx } : {});
      },
    },
    config: recoveryConfigFromEnv(d.env),
    log: d.log,
  });
  // Handlers before workers: an event reaches the handlers registered when it is emitted.
  service.register(d.events);
  await d.jobs.work("dunning.evaluate", async ({ subscriptionId, failedCount }) => {
    // The job carries only the subscription id; its case says whose it is.
    const merchantId = await merchantOfSubscription(d.db, subscriptionId);
    if (merchantId) await service.evaluate(merchantId, { subscriptionId, failedCount });
  });
  d.reconciler.registerDueWork("recovery.dunning", async () => {
    await service.sweepDueWork();
  });
  return service;
}

async function merchantOfSubscription(db: Db, subscriptionId: string): Promise<string | null> {
  const [row] = await db.acrossMerchants((tx) =>
    tx
      .select({ merchantId: subscriptions.merchantId })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId)),
  );
  return row?.merchantId ?? null;
}
