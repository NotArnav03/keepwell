import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { actions, APP_ROLE_OPTIONS, createDb, runMigrations, type Db } from "@keepwell/db";
import { createPool, postgresReadiness, withStrictSsl } from "./db.js";
import { databaseUrl, type Env } from "./env.js";
import { DbActionEngine } from "./modules/actions/engine.js";
import { reviseReturn } from "./modules/actions/revise-return.js";
import { DbAudit } from "./modules/audit/log.js";
import { DbDomainEvents } from "./modules/jobs/domain-events.js";
import { Jobs } from "./modules/jobs/jobs.js";
import { PayPalClient } from "./modules/paypal/client.js";
import { singleAppCredentials } from "./modules/paypal/credentials.js";
import { opsRoutes } from "./modules/reconcile/ops.js";
import { Reconciler } from "./modules/reconcile/reconciler.js";
import { SubscriptionSync } from "./modules/reconcile/sync.js";
import { webhookIntake } from "./modules/webhooks/intake.js";
import { WebhookProcessor } from "./modules/webhooks/processor.js";
import { buildServer, type ReadinessCheck } from "./server.js";

// The composition root: builds the M1 platform from the environment and starts it. Migrations,
// pools, the PayPal gateway, jobs and their workers, domain events, the action engine, the
// webhook pipeline, the reconciler's every-minute schedule, and the routes they serve. Other
// workstreams' modules plug in here as they land (sessions, merchant APIs, growth).

/** paypal-mock's Pantry Plan app (see its README): not secrets, and only used with PAYPAL_USE_MOCK. */
const MOCK_CREDENTIALS = { clientId: "pantry-plan-mock-client", clientSecret: "mock-secret" };

export interface Platform {
  app: FastifyInstance;
  /** Stops the workers first, then the HTTP server and the pools. */
  stop(): Promise<void>;
}

export async function startPlatform(env: Env): Promise<Platform> {
  const url = databaseUrl(env);
  if (!url) {
    const app = buildServer(env);
    app.log.warn("No DATABASE_URL_UNPOOLED or DATABASE_URL set: running without a database or workers");
    return { app, stop: () => app.close() };
  }

  // The readiness checks need the pool, and the core needs the server's logger: checks join below.
  const readinessChecks: ReadinessCheck[] = [];
  // Waking a suspended Neon compute can take a few seconds.
  const app = buildServer(env, { readinessChecks, readinessTimeoutMs: 5000 });
  const core = await createCore(env, url, app.log);
  const { pool, db, paypal, jobs, events, engine, sync, reconciler } = core;
  readinessChecks.push(postgresReadiness(pool), {
    name: "paypal",
    check: async () => {
      if (!(await paypal.checkAuth("readiness"))) throw new Error("PayPal OAuth failed");
    },
  });
  const processor = new WebhookProcessor(db, paypal, sync, app.log);

  // Handlers before workers: an event reaches the handlers registered when it is emitted.
  events.on("subscription.synced", "actions.confirm", async (event) => {
    await engine.confirmFromSync(event.merchantId, event.payload.snapshot);
  });

  await events.startWorker();
  await jobs.work("webhook.process", async ({ webhookEventId }) => {
    await processor.process(webhookEventId);
  });
  await jobs.work("action.execute", async ({ actionId }) => {
    const merchantId = await merchantOf(db, actionId);
    // "busy" leaves the Action PENDING; the due sweep sends it again a minute later.
    if (merchantId) await engine.execute(merchantId, actionId);
  });
  await jobs.work("action.confirm", async ({ actionId }) => {
    const merchantId = await merchantOf(db, actionId);
    if (merchantId) await engine.confirm(merchantId, actionId);
  });
  await jobs.work("reconcile.subscription", ({ subscriptionId }) => reconciler.syncOne(subscriptionId));
  await jobs.work("reconcile.sweep", async ({ merchantId }) => {
    await reconciler.sweep(merchantId);
  });
  await jobs.work("reconcile.drift", async ({ merchantId }) => {
    await reconciler.drift(merchantId);
  });
  await jobs.work("due.sweep", () => reconciler.dueSweep());
  await jobs.schedule("due.sweep", "* * * * *", {});

  await app.register(webhookIntake, { db, jobs });
  await app.register(reviseReturn, { prefix: "/v1", db, engine });
  await app.register(opsRoutes, {
    db,
    paypalCheck: () => paypal.checkAuth("status"),
    ...(env.OPS_TOKEN && { opsToken: env.OPS_TOKEN }),
  });
  app.addHook("onClose", () => pool.end());

  app.log.info({ paypal: env.PAYPAL_USE_MOCK ? "mock" : "sandbox" }, "platform started");
  return {
    app,
    async stop() {
      await jobs.stop();
      await app.close();
    },
  };
}

/** Jobs carry only the Action id; the row says whose it is. */
async function merchantOf(db: Db, actionId: string): Promise<string | null> {
  const [row] = await db.acrossMerchants((tx) =>
    tx.select({ merchantId: actions.merchantId }).from(actions).where(eq(actions.id, actionId)),
  );
  return row?.merchantId ?? null;
}

export interface CoreLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** The platform's pieces, built and connected but not started: the server and `pnpm seed` share it. */
export async function createCore(env: Env, url: string, log: CoreLogger) {
  const onIdleError = (err: Error) => log.warn({ err }, "idle postgres connection closed");
  if (env.RUN_MIGRATIONS) {
    // As the owner role, the only one allowed to change the schema.
    const owner = createPool(url, onIdleError, { max: 1 });
    try {
      await runMigrations(owner);
    } finally {
      await owner.end();
    }
  }
  // Every app query runs as keepwell_app, which row-level security binds.
  const pool = createPool(url, onIdleError, { connectionOptions: APP_ROLE_OPTIONS });
  const db = createDb(pool);
  const credentials =
    env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
      ? { clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET }
      : MOCK_CREDENTIALS;
  const paypal = new PayPalClient({
    baseUrl: env.PAYPAL_USE_MOCK ? env.PAYPAL_MOCK_URL : env.PAYPAL_API_BASE,
    credentials: singleAppCredentials(credentials),
    log: { info: (obj, msg) => log.debug(obj, msg), warn: (obj, msg) => log.warn(obj, msg) },
  });
  const jobs = await Jobs.start({ connectionString: withStrictSsl(url), log });
  const audit = new DbAudit(db);
  const events = new DbDomainEvents(db, jobs, log);
  const engine = new DbActionEngine({
    db,
    lockPool: pool,
    paypal,
    audit,
    events,
    log,
    publicBaseUrl: env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`,
    enqueue: async (actionId, tx) => {
      await jobs.send("action.execute", { actionId }, { tx });
    },
  });
  const sync = new SubscriptionSync(db, paypal, events);
  const reconciler = new Reconciler({ db, paypal, sync, engine, jobs, log });
  return { pool, db, paypal, jobs, audit, events, engine, sync, reconciler };
}
