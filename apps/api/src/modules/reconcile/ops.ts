import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginCallback } from "fastify";
import { and, desc, gt, sql } from "drizzle-orm";
import { actions, driftReports, merchants, webhookEvents, type Db } from "@keepwell/db";

// GET /status (public, Judge Mode shows it) and GET /ops (internal metrics, behind OPS_TOKEN):
// ARCHITECTURE.md §11. Status is cached for 30 s so a busy page can't load the database, and it
// says only how things are, never which merchant has what.

export interface OpsOptions {
  db: Db;
  /** True when PayPal answered recently (OAuth or a call). Omitted: not reported. */
  paypalCheck?: () => Promise<boolean>;
  /** Bearer token for /ops. Unset: /ops answers 404. */
  opsToken?: string;
  clock?: () => Date;
}

export type Health = "operational" | "degraded" | "down";

interface StatusBody {
  status: Health;
  checkedAt: string;
  components: {
    database: Health;
    paypal: Health | "unknown";
    webhooks: { status: Health; lagSeconds: number | null; rejectedLastHour: number };
    reconciler: { status: Health; lastSweepAt: string | null; drift: number };
  };
}

const CACHE_MS = 30_000;
const FORWARDING_HEADERS = ["x-forwarded-for", "cf-connecting-ip", "true-client-ip", "x-real-ip"];
/** Webhooks normally process in seconds; minutes means the job queue is stuck. */
const LAG_DEGRADED_SECONDS = 300;
/** Sweeps run every 30 minutes; well past that means the scheduler stopped. */
const SWEEP_STALE_MS = 90 * 60_000;

export const opsRoutes: FastifyPluginCallback<OpsOptions> = (app, options, done) => {
  const clock = options.clock ?? (() => new Date());
  let cached: { at: number; body: StatusBody } | null = null;

  app.get("/status", async (_request, reply) => {
    const now = clock();
    if (!cached || now.getTime() - cached.at > CACHE_MS) {
      cached = { at: now.getTime(), body: await status(options, now) };
    }
    return reply.header("cache-control", "public, max-age=30").send(cached.body);
  });

  /** 404 when ops is off, 401 without the token; null when the caller may go on. */
  const refuse = (authorization: string | undefined): 404 | 401 | null => {
    if (!options.opsToken) return 404;
    const given = Buffer.from(authorization ?? "");
    const expected = Buffer.from(`Bearer ${options.opsToken}`);
    return given.length === expected.length && timingSafeEqual(given, expected) ? null : 401;
  };

  app.get("/ops", async (request, reply) => {
    const refused = refuse(request.headers.authorization);
    if (refused) return reply.code(refused).send();
    return reply.send(await metrics(options.db, clock()));
  });

  // What the API takes as the caller's address (request.ip, which per-IP rate limits use), the
  // chain it was picked from, and the forwarding headers as received: for checking TRUST_PROXY_HOPS
  // against whatever proxies the host puts in front.
  app.get("/ops/whoami", (request, reply) => {
    const refused = refuse(request.headers.authorization);
    if (refused) return reply.code(refused).send();
    const header = (name: string): string | null => {
      const value = request.headers[name];
      return Array.isArray(value) ? value.join(", ") : (value ?? null);
    };
    return reply.send({
      ip: request.ip,
      ips: request.ips ?? [request.ip],
      headers: Object.fromEntries(FORWARDING_HEADERS.map((name) => [name, header(name)])),
    });
  });

  done();
};

async function status(options: OpsOptions, now: Date): Promise<StatusBody> {
  const hourAgo = new Date(now.getTime() - 60 * 60_000);
  interface Readings {
    lagSeconds: number | null;
    rejectedLastHour: number;
    lastSweepAt: Date | null;
    drift: number;
    merchants: number;
  }
  const readings: Readings | null = await options.db
    .acrossMerchants(async (tx): Promise<Readings> => {
      const [webhooks] = await tx
        .select({
          lag: sql<
            number | null
          >`avg(extract(epoch from ${webhookEvents.processedAt} - ${webhookEvents.receivedAt}))`,
          rejected: sql<number>`count(*) filter (where ${webhookEvents.status} = 'rejected')::int`,
        })
        .from(webhookEvents)
        .where(gt(webhookEvents.receivedAt, hourAgo));
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(merchants);
      const [sweep] = await tx
        .select({ at: sql<Date | null>`max(${merchants.lastSweepAt})` })
        .from(merchants);
      // The latest report per merchant, summed.
      const latest = await tx
        .selectDistinctOn([driftReports.merchantId], { drifted: driftReports.drifted })
        .from(driftReports)
        .orderBy(driftReports.merchantId, desc(driftReports.ranAt));
      return {
        lagSeconds: webhooks?.lag == null ? null : Math.round(Number(webhooks.lag)),
        rejectedLastHour: webhooks?.rejected ?? 0,
        lastSweepAt: sweep?.at ? new Date(sweep.at) : null,
        drift: latest.reduce((sum, r) => sum + r.drifted, 0),
        merchants: count?.n ?? 0,
      };
    })
    // The database can't be reached: that is the status, not an error to throw.
    .catch(() => null);
  const database: Health = readings === null ? "down" : "operational";
  const {
    lagSeconds = null,
    rejectedLastHour = 0,
    lastSweepAt = null,
    drift = 0,
    merchants: merchantCount = 0,
  } = readings ?? {};
  const paypal: Health | "unknown" = options.paypalCheck
    ? await options.paypalCheck().then(
        (ok) => (ok ? "operational" : "down"),
        () => "down" as const,
      )
    : "unknown";
  const webhooksHealth: Health =
    lagSeconds !== null && lagSeconds > LAG_DEGRADED_SECONDS ? "degraded" : "operational";
  const sweepAt = lastSweepAt;
  // With no merchants yet (a fresh deployment) there is nothing to sweep, so nothing is stale.
  const stale = merchantCount > 0 && (sweepAt === null || now.getTime() - sweepAt.getTime() > SWEEP_STALE_MS);
  const reconcilerHealth: Health = drift > 0 || stale ? "degraded" : "operational";
  const parts = [database, paypal === "unknown" ? "operational" : paypal, webhooksHealth, reconcilerHealth];
  const overall: Health =
    database === "down" ? "down" : parts.every((p) => p === "operational") ? "operational" : "degraded";
  return {
    status: overall,
    checkedAt: now.toISOString(),
    components: {
      database,
      paypal,
      webhooks: { status: webhooksHealth, lagSeconds, rejectedLastHour },
      reconciler: { status: reconcilerHealth, lastSweepAt: sweepAt?.toISOString() ?? null, drift },
    },
  };
}

async function metrics(db: Db, now: Date) {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
  return db.acrossMerchants(async (tx) => {
    const webhooks = await tx
      .select({ status: webhookEvents.status, count: sql<number>`count(*)::int` })
      .from(webhookEvents)
      .where(gt(webhookEvents.receivedAt, dayAgo))
      .groupBy(webhookEvents.status);
    const actionStates = await tx
      .select({ type: actions.type, state: actions.state, count: sql<number>`count(*)::int` })
      .from(actions)
      .where(and(gt(actions.createdAt, dayAgo)))
      .groupBy(actions.type, actions.state);
    const confirmed = actionStates.filter((a) => a.state === "CONFIRMED").reduce((s, a) => s + a.count, 0);
    const failed = actionStates.filter((a) => a.state === "FAILED").reduce((s, a) => s + a.count, 0);
    const drift = await tx
      .selectDistinctOn([driftReports.merchantId], {
        merchantId: driftReports.merchantId,
        checked: driftReports.checked,
        drifted: driftReports.drifted,
        ranAt: driftReports.ranAt,
      })
      .from(driftReports)
      .orderBy(driftReports.merchantId, desc(driftReports.ranAt));
    return {
      generatedAt: now.toISOString(),
      webhooksLast24h: Object.fromEntries(webhooks.map((w) => [w.status, w.count])),
      actionsLast24h: actionStates,
      actionSuccessRate: confirmed + failed === 0 ? null : confirmed / (confirmed + failed),
      drift,
    };
  });
}
