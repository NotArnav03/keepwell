import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { plans, subscriptions, type Db, type Tx } from "@keepwell/db";
import type { Audit, DomainEvents, JudgePool } from "@keepwell/contracts";
import type { Env } from "../env.js";
import type { DbActionEngine } from "./actions/engine.js";
import { createAgent, PgLlmUsageStore } from "./agent/index.js";
import { DbTimeMachine, judgeRoutes } from "./demo/judge.js";
import { demoStoreRoutes } from "./demo/store-routes.js";
import type { Jobs } from "./jobs/jobs.js";
import { subscriberMcpRoutes } from "./mcp/subscriber.js";
import type { PayPalClient } from "./paypal/client.js";
import { DbMerchantCatalog, DbPolicyStore } from "./policy/db-service.js";
import { DelegationService } from "./portal/delegations.js";
import { PgDelegationStore, PgPortalDirectory } from "./portal/pg.js";
import { RateLimiter } from "./portal/rate-limit.js";
import { demoMerchantWidgetSecret, sessionAuthenticator, signStreamTicket } from "./sessions/auth.js";
import { sessionRoutes } from "./sessions/routes.js";
import { DbSessionsApi } from "./sessions/service.js";

// M3's subscriber surfaces in the composition root (HANDOFF-M1 §5 A): the sessions API (#32), the
// subscriber-agent MCP server (#41), Judge Mode (#39) and the demo store's backend (#34). Each part
// mounts only when the secrets it signs with are set, and says so in the log when it doesn't, so a
// deploy without them runs exactly as before.
//
// Not here: the hosted portal (#38). Its sign-in links go out by email, and the notifier (#91) has no
// sign-in template yet; a mailer that logs links would put live sign-in links in the logs.

export interface MountSurfacesOptions {
  app: FastifyInstance;
  env: Env;
  db: Db;
  paypal: PayPalClient;
  engine: DbActionEngine;
  events: DomainEvents<Tx>;
  audit: Audit<Tx>;
  jobs: Jobs;
  judgePool: JudgePool;
  log: FastifyBaseLogger;
}

/** What got mounted, for the log and for tests. */
export interface MountedSurfaces {
  sessions: boolean;
  mcp: boolean;
  judge: boolean;
  demoStore: boolean;
}

/**
 * Registers the surfaces' domain-event handlers and jobs, then their routes. Call it before
 * `events.startWorker()`: an event reaches only the handlers registered when it is emitted.
 */
export async function mountSurfaces(o: MountSurfacesOptions): Promise<MountedSurfaces> {
  const { app, env, db, log } = o;
  const mounted: MountedSurfaces = { sessions: false, mcp: false, judge: false, demoStore: false };
  const publicUrl = (env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, "");
  const portalUrl = env.PORTAL_URL ?? `${publicUrl}/`;
  const widgetOrigins = new Set(env.WIDGET_ALLOWED_ORIGINS?.map((o) => new URL(o).origin) ?? []);
  const allowWidgetOrigin = (origin: string) => widgetOrigins.has(origin);

  if (!env.SESSION_TICKET_SECRET) {
    log.warn({}, "SESSION_TICKET_SECRET is not set: the sessions API, subscriber MCP and Judge Mode are off");
    return mounted;
  }
  const ticketSecret = env.SESSION_TICKET_SECRET;

  const agent = createAgent({
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    dailyBudgetUsd: env.LLM_DAILY_BUDGET_USD,
    usageStore: new PgLlmUsageStore(db),
    events: o.events,
    audit: o.audit,
    log,
  });
  const sessions = new DbSessionsApi({
    db,
    agent,
    engine: o.engine,
    events: o.events,
    audit: o.audit,
    policies: new DbPolicyStore(db),
    catalog: new DbMerchantCatalog(db),
    payments: o.paypal,
    streamUrl: (sessionId, principal) =>
      `${publicUrl}/v1/sessions/${sessionId}/stream?ticket=${signStreamTicket({ sessionId, principal }, ticketSecret, new Date())}`,
    log,
  });

  // A session follows its Actions; idle ones close as abandoned every five minutes.
  o.events.on("action.state_changed", "sessions.stream", (event) => sessions.onActionStateChanged(event));
  await o.jobs.work("sessions.abandon_sweep", async () => {
    const closed = await sessions.abandonIdle();
    if (closed > 0) log.info({ closed }, "idle sessions closed as abandoned");
  });
  await o.jobs.schedule("sessions.abandon_sweep", "*/5 * * * *", {});

  const widgetSecret = env.DEMO_MERCHANT_ID
    ? demoMerchantWidgetSecret(env.DEMO_MERCHANT_ID, env.WIDGET_TOKEN_SECRET)
    : () => Promise.resolve(null);
  await app.register(sessionRoutes, {
    prefix: "/v1",
    sessions,
    authenticate: sessionAuthenticator({
      widgetSecret,
      // Until the portal mounts, nothing issues portal tokens; a per-process key accepts none.
      portalSecret: env.MAGIC_LINK_SECRET ?? randomBytes(32).toString("hex"),
      ticketSecret,
      subscriptionByPayPalId: (merchantId, paypalSubscriptionId) =>
        subscriptionIdFor(db, merchantId, paypalSubscriptionId),
    }),
    allowOrigin: allowWidgetOrigin,
  });
  mounted.sessions = true;

  // The subscriber's own agent, with delegation tokens from the portal (none exist until it mounts).
  const directory = new PgPortalDirectory(db);
  await app.register(subscriberMcpRoutes, {
    sessions,
    delegations: new DelegationService({ store: new PgDelegationStore(db), directory, audit: o.audit }),
    publicUrl,
    portalUrl,
  });
  mounted.mcp = true;

  if (env.DEMO_MERCHANT_ID && env.WIDGET_TOKEN_SECRET) {
    const merchantId = env.DEMO_MERCHANT_ID;
    // Pantry Plan's "backend": verify a new subscription with PayPal, then sign its widget tokens.
    await app.register(demoStoreRoutes, {
      prefix: "/v1",
      gateway: o.paypal,
      merchantId,
      plans: await demoPlans(db, merchantId),
      signingSecret: env.WIDGET_TOKEN_SECRET,
      allowOrigin: allowWidgetOrigin,
      rateLimiter: new RateLimiter({ limit: 60, windowMs: 60_000 }),
    });
    mounted.demoStore = true;

    if (env.JUDGE_LEASE_SECRET) {
      await app.register(judgeRoutes, {
        prefix: "/v1",
        pool: o.judgePool,
        timeMachine: new DbTimeMachine({ db, engine: o.engine, audit: o.audit }),
        merchantId,
        leaseSecret: env.JUDGE_LEASE_SECRET,
        widgetSecret: env.WIDGET_TOKEN_SECRET,
        // The judge site calls through its own /v1 rewrite; no cross-origin caller needs it.
        allowOrigin: () => false,
      });
      mounted.judge = true;
    } else {
      log.warn({}, "JUDGE_LEASE_SECRET is not set: Judge Mode is off");
    }
  } else {
    log.warn(
      {},
      "DEMO_MERCHANT_ID or WIDGET_TOKEN_SECRET is not set: the demo store backend and Judge Mode are off",
    );
  }

  log.info({ mounted }, "subscriber surfaces mounted");
  return mounted;
}

/** Our subscription id for one of the merchant's PayPal subscriptions, or null. */
async function subscriptionIdFor(
  db: Db,
  merchantId: string,
  paypalSubscriptionId: string,
): Promise<string | null> {
  const [row] = await db.forMerchant(merchantId, (tx) =>
    tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.merchantId, merchantId),
          eq(subscriptions.paypalSubscriptionId, paypalSubscriptionId),
        ),
      )
      .limit(1),
  );
  return row?.id ?? null;
}

/** PayPal plan id → name, for the plans the demo store sells (the seed writes them). */
async function demoPlans(db: Db, merchantId: string): Promise<Record<string, string>> {
  const rows = await db.forMerchant(merchantId, (tx) =>
    tx
      .select({ id: plans.paypalPlanId, name: plans.name })
      .from(plans)
      .where(and(eq(plans.merchantId, merchantId), eq(plans.status, "ACTIVE"))),
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}
