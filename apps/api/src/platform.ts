import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { actions, APP_ROLE_OPTIONS, createDb, runMigrations, type Db } from "@keepwell/db";
import { createPool, postgresReadiness, withStrictSsl } from "./db.js";
import { databaseUrl, type Env } from "./env.js";
import { DbActionEngine } from "./modules/actions/engine.js";
import { reviseReturn } from "./modules/actions/revise-return.js";
import { DbAudit } from "./modules/audit/log.js";
import { auditRoutes } from "./modules/audit/routes.js";
import {
  DbMerchantAuthStore,
  MerchantAuthService,
  MerchantAuthenticator,
  merchantAuthRoutes,
} from "./modules/merchant/auth.js";
import { merchantDataRoutes } from "./modules/merchant/data-routes.js";
import { merchantOnboardingRoutes } from "./modules/merchant/onboarding-routes.js";
import { DbCredentialSource } from "./modules/merchant/credentials.js";
import { policyRoutes } from "./modules/policy/routes.js";
import { PolicyService } from "./modules/policy/service.js";
import { DbMerchantCatalog, DbPolicyStore } from "./modules/policy/db-service.js";
import { DbDomainEvents } from "./modules/jobs/domain-events.js";
import { Jobs } from "./modules/jobs/jobs.js";
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
  const { pool, db, paypal, jobs, events, engine, sync, reconciler, audit } = core;
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
  await jobs.work("pool.health", () => core.judgePool.health());
  await jobs.schedule("pool.health", "*/5 * * * *", {});

  await app.register(webhookIntake, { db, jobs });
  await app.register(reviseReturn, { prefix: "/v1", db, engine });
  if (env.SESSION_SECRET && env.DASHBOARD_URL) {
    const authenticator = new MerchantAuthenticator(
      new MerchantAuthService(new DbMerchantAuthStore(db)),
      env.SESSION_SECRET,
      env.DASHBOARD_URL,
    );
    await app.register(merchantAuthRoutes, {
      prefix: "/v1/m",
      authenticator,
      secureCookies: env.NODE_ENV === "production",
    });
    await app.register(merchantDataRoutes, { prefix: "/v1/m", db, pool, authenticator });
    await app.register(auditRoutes, {
      prefix: "/v1/m",
      audit,
      authenticate: async (request) => authenticator.authenticate(request),
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
  return { pool, db, paypal, jobs, audit, events, engine, sync, reconciler, judgePool };
}
