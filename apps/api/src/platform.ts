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
import { createNotify, notifyConfigFromEnv, notifyRoutes, wireNotify } from "./modules/notify/index.js";
import { mountRecovery } from "./modules/recovery/mount.js";
import { PayPalClient } from "./modules/paypal/client.js";
import { MOCK_CREDENTIALS, singleAppCredentials } from "./modules/paypal/credentials.js";
import { DbJudgePool } from "./modules/pool/pool.js";
import { opsRoutes } from "./modules/reconcile/ops.js";
import { Reconciler } from "./modules/reconcile/reconciler.js";
import { SubscriptionSync } from "./modules/reconcile/sync.js";
import { webhookIntake } from "./modules/webhooks/intake.js";
import { mountSurfaces } from "./modules/surfaces.js";
import { WebhookProcessor } from "./modules/webhooks/processor.js";
import { buildServer, type ReadinessCheck } from "./server.js";

// The composition root: builds the M1 platform from the environment and starts it. Migrations,
// pools, the PayPal gateway, jobs and their workers, domain events, the action engine, the
// webhook pipeline, the reconciler's every-minute schedule, and the routes they serve. Other
// workstreams' modules plug in here as they land (sessions, merchant APIs, growth).

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
  const { pool, db, paypal, jobs, audit, events, engine, sync, reconciler, notify, notifyConfig } = core;
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

  // Growth: failed-payment recovery. Its handlers and due work register before the workers start.
  await mountRecovery({
    db,
    jobs,
    events,
    audit,
    engine,
    reconciler,
    paypal,
    notifier: notify.notifier,
    log: app.log,
  });

  // M3: sessions, subscriber MCP, Judge Mode and the demo store backend (each only with its secrets).
  await mountSurfaces({
    app,
    env,
    db,
    paypal,
    engine,
    events,
    audit,
    jobs,
    judgePool: core.judgePool,
    log: app.log,
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
  await jobs.work("pool.health", () => core.judgePool.health());
  await jobs.schedule("pool.health", "*/5 * * * *", {});

  // Sends what recovery and win-back enqueue; the minute-by-minute sweep feeds the worker.
  await wireNotify({
    db,
    dispatcher: notify.dispatcher,
    jobs,
    registerDueWork: (name, fn) => reconciler.registerDueWork(name, fn),
  });
  // Merchant auth (#48) isn't merged, so only the public unsubscribe route is mounted. Pass
  // `authenticate` here when it lands to serve GET /v1/m/outbox (the Demo Inbox).
  await app.register(notifyRoutes, { prefix: "/v1", db, audit, config: notifyConfig, log: app.log });
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
  // The mock only knows its own app, so sandbox credentials in .env must not reach it.
  const credentials =
    !env.PAYPAL_USE_MOCK && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
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
  const judgePool = new DbJudgePool({ db, engine, sync, audit, log });
  // Other modules enqueue email through `notify.notifier` (inside their own transaction).
  const notifyConfig = notifyConfigFromEnv(env, env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`);
  if (!env.UNSUBSCRIBE_TOKEN_SECRET) {
    log.warn(
      {},
      "UNSUBSCRIBE_TOKEN_SECRET is not set: unsubscribe links use a key that dies with this process",
    );
  }
  const notify = createNotify({ db, audit, events, config: notifyConfig, log });
  return { pool, db, paypal, jobs, audit, events, engine, sync, reconciler, judgePool, notify, notifyConfig };
}
