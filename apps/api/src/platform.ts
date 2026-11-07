import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { actions, APP_ROLE_OPTIONS, createDb, runMigrations, type Db } from "@keepwell/db";
import { createPool, postgresReadiness, withStrictSsl } from "./db.js";
import { databaseUrl, type Env } from "./env.js";
import { DbActionEngine } from "./modules/actions/engine.js";
import { reviseReturn } from "./modules/actions/revise-return.js";
import { createLlmClient, LlmBudget, PgLlmUsageStore } from "./modules/agent/index.js";
import { DbAudit } from "./modules/audit/log.js";
import { registerWinback } from "./modules/winback/index.js";
import { auditRoutes } from "./modules/audit/routes.js";
import {
  DbMerchantAuthStore,
  MerchantAuthService,
  MerchantAuthenticator,
  merchantAuthRoutes,
} from "./modules/merchant/auth.js";
import { merchantDataRoutes } from "./modules/merchant/data-routes.js";
import { PgFeedHub } from "./modules/merchant/feed-hub.js";
import { merchantOnboardingRoutes } from "./modules/merchant/onboarding-routes.js";
import { DbCredentialSource } from "./modules/merchant/credentials.js";
import { policyRoutes } from "./modules/policy/routes.js";
import { PolicyService } from "./modules/policy/service.js";
import { DbMerchantCatalog, DbPolicyStore } from "./modules/policy/db-service.js";
import { DbDomainEvents } from "./modules/jobs/domain-events.js";
import { Jobs } from "./modules/jobs/jobs.js";
import { DrizzleInsightStore, DrizzleSessionReader } from "./modules/insights/drizzle-store.js";
import { InsightExtractor, noReplies } from "./modules/insights/extractor.js";
import { registerInsights } from "./modules/insights/jobs.js";
import { insightsOverview } from "./modules/insights/queries.js";
import { insightsRoutes } from "./modules/insights/routes.js";
import { createNotify, notifyConfigFromEnv, notifyRoutes, wireNotify } from "./modules/notify/index.js";
import { mountRecovery } from "./modules/recovery/mount.js";
import { PayPalClient } from "./modules/paypal/client.js";
import { MOCK_CREDENTIALS, singleAppCredentials } from "./modules/paypal/credentials.js";
import { DbJudgePool } from "./modules/pool/pool.js";
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

  // Win-back records every PayPal-side cancellation and sends one message through the notifier.
  await registerWinback({
    app,
    db,
    jobs,
    events,
    audit: core.audit,
    reconciler,
    paypal,
    notifier: notify.notifier,
    ...(env.PORTAL_URL && { portalUrl: env.PORTAL_URL }),
    ...(env.MAGIC_LINK_SECRET && { tokenSecret: env.MAGIC_LINK_SECRET }),
  });

  // M5 insights: the session.closed handler registers before the events worker starts. One
  // LlmBudget for every model caller, so the daily cap and in-flight reservations are shared.
  const llmBudget = new LlmBudget({
    store: new PgLlmUsageStore(db),
    dailyBudgetUsd: env.LLM_DAILY_BUDGET_USD,
  });
  const extractor = new InsightExtractor({
    llm: createLlmClient({ anthropicApiKey: env.ANTHROPIC_API_KEY, budget: llmBudget, log: app.log }),
    sessions: new DrizzleSessionReader(db),
    // The win-back module supplies the real reader once it owns a replies table.
    replies: noReplies,
    store: new DrizzleInsightStore(db),
    audit,
    log: app.log,
  });
  await registerInsights({ db, jobs, events, extractor, log: app.log });

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
  // Merchant sign-in: absent until SESSION_SECRET and DASHBOARD_URL are set, and every merchant route
  // below waits for it. The public unsubscribe route never does.
  const authenticator =
    env.SESSION_SECRET && env.DASHBOARD_URL
      ? new MerchantAuthenticator(
          new MerchantAuthService(new DbMerchantAuthStore(db)),
          env.SESSION_SECRET,
          env.DASHBOARD_URL,
        )
      : undefined;
  // With a signed-in merchant this also serves GET /v1/m/outbox (the Demo Inbox).
  await app.register(notifyRoutes, {
    prefix: "/v1",
    db,
    audit,
    config: notifyConfig,
    log: app.log,
    ...(authenticator && { authenticate: (request) => authenticator.authenticate(request) }),
  });
  await app.register(webhookIntake, { db, jobs });
  await app.register(reviseReturn, { prefix: "/v1", db, engine });
  let feedHub: PgFeedHub | undefined;
  if (authenticator) {
    await app.register(merchantAuthRoutes, {
      prefix: "/v1/m",
      authenticator,
      secureCookies: env.NODE_ENV === "production",
    });
    // One LISTEN connection for every open dashboard, not one per tab (the pool is shared with the workers).
    feedHub = new PgFeedHub(pool, app.log);
    await feedHub.start();
    await app.register(merchantDataRoutes, { prefix: "/v1/m", db, feed: feedHub, audit, authenticator });
    await app.register(auditRoutes, {
      prefix: "/v1/m",
      audit,
      authenticate: async (request) => authenticator.authenticate(request),
    });
    // GET /v1/m/insights?from&to (M5): the dashboard's insights panels.
    await app.register(insightsRoutes, {
      prefix: "/v1/m",
      authenticate: (request) => authenticator.authenticate(request),
      load: (merchantId, range, quoteLimit) => insightsOverview(db, merchantId, range, quoteLimit),
    });
    const policyService = new PolicyService({
      store: new DbPolicyStore(db),
      catalog: new DbMerchantCatalog(db),
      events,
      audit,
    });
    await app.register(policyRoutes, {
      prefix: "/v1/m",
      service: policyService,
      authenticate: async (request) => {
        const user = await authenticator.authenticate(request, request.method !== "GET");
        return { merchantId: user.merchantId, userLabel: user.email };
      },
    });
    if (!env.PAYPAL_USE_MOCK && env.PAYPAL_CREDENTIALS_ENCRYPTION_KEY) {
      await app.register(merchantOnboardingRoutes, {
        prefix: "/v1/m",
        db,
        authenticator,
        paypal,
        audit,
        jobs,
        apiPublicUrl: env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`,
        encryptionKey: env.PAYPAL_CREDENTIALS_ENCRYPTION_KEY,
        verifyCredentials: async (merchantId, credentials) => {
          const verification = new PayPalClient({
            baseUrl: env.PAYPAL_API_BASE,
            credentials: singleAppCredentials(credentials),
            log: {
              info: (obj, msg) => app.log.info(obj, msg),
              warn: (obj, msg) => app.log.warn(obj, msg),
            },
          });
          return verification.checkAuth(merchantId);
        },
      });
    }
  } else {
    app.log.warn("Merchant authentication is disabled: configure SESSION_SECRET and DASHBOARD_URL");
  }
  await app.register(opsRoutes, {
    db,
    paypalCheck: () => paypal.checkAuth("status"),
    ...(env.OPS_TOKEN && { opsToken: env.OPS_TOKEN }),
  });
  app.addHook("onClose", async () => {
    // The hub holds a pool connection; pool.end() waits for it to be released.
    feedHub?.close();
    await pool.end();
  });

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
  const fallbackCredentials =
    !env.PAYPAL_USE_MOCK && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
      ? { clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET }
      : undefined;
  const credentials = env.PAYPAL_USE_MOCK
    ? singleAppCredentials(MOCK_CREDENTIALS)
    : env.PAYPAL_CREDENTIALS_ENCRYPTION_KEY
      ? new DbCredentialSource(db, env.PAYPAL_CREDENTIALS_ENCRYPTION_KEY, fallbackCredentials)
      : singleAppCredentials(fallbackCredentials ?? MOCK_CREDENTIALS);
  const paypal = new PayPalClient({
    baseUrl: env.PAYPAL_USE_MOCK ? env.PAYPAL_MOCK_URL : env.PAYPAL_API_BASE,
    credentials,
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
