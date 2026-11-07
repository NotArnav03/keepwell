import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  ErrorEnvelope,
  Id,
  JudgeLeaseClaims,
  JudgeLeaseResponse,
  JudgeResumeResponse,
  JudgeReturnResponse,
  JudgeWidgetTokenResponse,
  type Audit,
  type JudgePool,
} from "@keepwell/contracts";
import { scheduledResumes, type Db, type Tx } from "@keepwell/db";
import { signJwt, signWidgetToken, verifyJwt } from "../portal/jwt.js";
import { RateLimiter } from "../portal/rate-limit.js";
import { allowCors } from "../sessions/cors.js";

// Judge Mode's API (ARCHITECTURE.md §6.17, #39): a stranger leases one pooled, already-approved
// sandbox subscription for 30 minutes, gets widget tokens for it, can run a pause's resume early
// (TIME SHIFT, a real activate), and hands it back. The pool (M1) decides what a returned
// subscription becomes from PayPal's own state, never from what the page says.
//
// Auth: POST /demo/leases is public and rate limited per IP; everything else takes the lease token
// it returns (`Authorization: Bearer …`), which only reaches that one lease and subscription.

/** Runs a subscription's scheduled resume now. */
export interface TimeMachine {
  resumeNow(merchantId: string, subscriptionId: string): Promise<{ actionId: string | null; note: string }>;
}

export interface JudgeRoutesOptions {
  pool: JudgePool;
  timeMachine: TimeMachine;
  /** The prod-demo merchant whose pool judges lease from. */
  merchantId: string;
  /** Signs lease tokens; a secret of its own. */
  leaseSecret: string;
  /** The demo merchant's widget-token secret (WIDGET_TOKEN_SECRET). */
  widgetSecret: string;
  /** The judge page's origin, if it calls the API directly rather than through a /v1 rewrite. */
  allowOrigin: (origin: string) => boolean;
  clock?: () => Date;
  /** Default: 10 leases an hour per IP. */
  leasesPerIp?: RateLimiter;
}

class JudgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const LeaseParams = z.object({ id: Id });
const ClientError = z.object({ statusCode: z.number().int().min(400).max(499), message: z.string() });
const SubscriptionParams = z.object({ subscriptionId: Id });

export const judgeRoutes: FastifyPluginCallback<JudgeRoutesOptions> = (app, options, done) => {
  const clock = options.clock ?? (() => new Date());
  const leasesPerIp = options.leasesPerIp ?? new RateLimiter({ limit: 10, windowMs: 3600_000, clock });
  allowCors(app, {
    allowOrigin: options.allowOrigin,
    paths: ["/demo/*"],
    headers: "authorization, content-type",
    methods: "GET, POST, DELETE",
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof JudgeHttpError) {
      if (error.retryAfterSeconds !== undefined) reply.header("retry-after", error.retryAfterSeconds);
      return sendError(request, reply, error.status, error.code, error.message);
    }
    // Fastify's own refusals (a malformed body, an empty JSON body) are the caller's, not ours.
    const client = ClientError.safeParse(error);
    if (client.success) {
      return sendError(request, reply, client.data.statusCode, "invalid_request", client.data.message);
    }
    request.log.error({ err: error }, "judge route failed");
    return sendError(request, reply, 500, "internal", "Something went wrong on our side");
  });

  app.post("/demo/leases", async (request, reply) => {
    // Only a lease that was issued counts: asking while the pool is empty costs nothing.
    const key = `ip:${request.ip}`;
    const room = leasesPerIp.check(key);
    if (!room.allowed) {
      throw new JudgeHttpError(
        429,
        "rate_limited",
        "Too many leases from here; try again later",
        room.retryAfterSeconds,
      );
    }
    const lease = await options.pool.lease(options.merchantId);
    if (lease === null) {
      throw new JudgeHttpError(503, "pool_empty", "Every demo subscription is in use right now");
    }
    leasesPerIp.hit(key);
    const iat = Math.floor(clock().getTime() / 1000);
    const exp = Math.floor(new Date(lease.leasedUntil).getTime() / 1000);
    const claims = JudgeLeaseClaims.parse({
      kind: "judge_lease",
      mid: options.merchantId,
      pe: lease.poolEntryId,
      sub: lease.subscriptionId,
      sid: lease.paypalSubscriptionId,
      iat,
      exp,
    });
    return reply.code(201).send(
      JudgeLeaseResponse.parse({
        leaseId: lease.poolEntryId,
        leaseToken: signJwt(claims, options.leaseSecret),
        expiresAt: lease.leasedUntil,
        subscriptionId: lease.subscriptionId,
      }),
    );
  });

  app.post("/demo/leases/:id/token", async (request, reply) => {
    const lease = await leaseOf(request, options, clock());
    const { token, expiresAt } = signWidgetToken(
      { merchantId: lease.mid, paypalSubscriptionId: lease.sid },
      options.widgetSecret,
      clock(),
    );
    return reply
      .header("cache-control", "no-store")
      .send(JudgeWidgetTokenResponse.parse({ token, expiresAt }));
  });

  app.delete("/demo/leases/:id", async (request, reply) => {
    const lease = await leaseOf(request, options, clock());
    // The pool settles only this exact lease, re-checked under its row lock: never the next judge's.
    const result = await options.pool.release(lease.mid, lease.pe, leasedUntilOf(lease));
    if (result === null) throw leaseEnded();
    return reply.send(JudgeReturnResponse.parse({ result }));
  });

  app.post("/demo/time-machine/resume/:subscriptionId", async (request, reply) => {
    const lease = await leaseOf(request, options, clock(), { lease: false });
    const { subscriptionId } = parse(SubscriptionParams, request.params);
    if (subscriptionId !== lease.sub) {
      throw new JudgeHttpError(403, "forbidden", "That isn't the subscription you leased");
    }
    const { actionId, note } = await options.timeMachine.resumeNow(lease.mid, lease.sub);
    return reply.send(
      JudgeResumeResponse.parse({
        resumed: actionId !== null,
        actionId,
        label: "TIME SHIFT",
        simulated: true,
        note,
      }),
    );
  });

  done();
};

/**
 * The lease token's claims, for a lease that is still this token's. Pool entries are lent again and
 * again, so a valid signature isn't enough: after a return, the next judge may hold the same entry,
 * and the old token must not reach it. The pool confirms (entry, leasedUntil) is still leased, and
 * the token's exp is that leasedUntil to the second. For /demo/leases/:id the id must be its lease.
 */
async function leaseOf(
  request: FastifyRequest,
  options: JudgeRoutesOptions,
  now: Date,
  check: { lease?: boolean } = {},
): Promise<JudgeLeaseClaims> {
  const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  const verified =
    bearer === undefined ? null : verifyJwt(bearer, options.leaseSecret, JudgeLeaseClaims, now);
  if (verified === null || !verified.ok || verified.claims.mid !== options.merchantId) throw leaseEnded();
  const claims = verified.claims;
  if (check.lease !== false) {
    const { id } = parse(LeaseParams, request.params);
    if (id !== claims.pe) throw new JudgeHttpError(403, "forbidden", "That isn't your lease");
  }
  if (!(await options.pool.holds(claims.mid, claims.pe, leasedUntilOf(claims)))) throw leaseEnded();
  return claims;
}

/** The lease's end as the pool stores it: the token's exp, which is whole seconds. */
function leasedUntilOf(claims: JudgeLeaseClaims): string {
  return new Date(claims.exp * 1000).toISOString();
}

function leaseEnded(): JudgeHttpError {
  return new JudgeHttpError(401, "unauthorized", "This lease has ended; start a new one");
}

/**
 * The time machine's resume: makes the subscription's scheduled resume due now, then lets the
 * engine turn due resumes into `activate` Actions as it always does. Only a resume whose suspend
 * has applied ("scheduled") can run; one still waiting on its suspend can't.
 */
export class DbTimeMachine implements TimeMachine {
  constructor(
    private readonly o: {
      db: Db;
      engine: { runDueResumes(limit?: number): Promise<string[]> };
      audit: Audit<Tx>;
      clock?: () => Date;
    },
  ) {}

  async resumeNow(
    merchantId: string,
    subscriptionId: string,
  ): Promise<{ actionId: string | null; note: string }> {
    const now = this.o.clock?.() ?? new Date();
    const moved = await this.o.db.forMerchant(merchantId, async (tx) => {
      const rows = await tx
        .update(scheduledResumes)
        .set({ dueAt: now })
        .where(
          and(
            eq(scheduledResumes.merchantId, merchantId),
            eq(scheduledResumes.subscriptionId, subscriptionId),
            eq(scheduledResumes.status, "scheduled"),
          ),
        )
        .returning({ id: scheduledResumes.id });
      if (rows.length > 0) {
        // Simulated (law 9): the shift in time is ours. The activate it leads to is a real Action.
        await this.o.audit.append(
          {
            merchantId,
            actor: "demo",
            kind: "demo.time_shift",
            subjectIds: { subscriptionId, scheduledResumeId: rows[0]?.id ?? "" },
            payload: {
              label: "TIME SHIFT",
              simulated: true,
              what: "scheduled resume brought forward to now",
            },
            simulated: true,
          },
          tx,
        );
      }
      return rows.map((r) => r.id);
    });

    if (moved.length === 0) {
      // A second press, or the minute sweep got there first: report the resume that already ran.
      const [last] = await this.o.db.forMerchant(merchantId, (tx) =>
        tx
          .select({ status: scheduledResumes.status, actionId: scheduledResumes.actionId })
          .from(scheduledResumes)
          .where(
            and(
              eq(scheduledResumes.merchantId, merchantId),
              eq(scheduledResumes.subscriptionId, subscriptionId),
            ),
          )
          .orderBy(desc(scheduledResumes.dueAt))
          .limit(1),
      );
      if (last?.status === "done" && last.actionId !== null) {
        return { actionId: last.actionId, note: "This pause's resume has already run." };
      }
      return {
        actionId: null,
        note: "Nothing to resume: there is no pause whose suspend PayPal has applied. Pause first, then wait a few seconds.",
      };
    }

    // The engine's own sweep turns due resumes into activate Actions (SKIP LOCKED, so it is safe to
    // run from a request). Whichever run claimed ours, this one or the minute's, its Action is ours.
    await this.o.engine.runDueResumes();
    const ours = await this.o.db.forMerchant(merchantId, (tx) =>
      tx
        .select({ actionId: scheduledResumes.actionId })
        .from(scheduledResumes)
        .where(and(eq(scheduledResumes.merchantId, merchantId), inArray(scheduledResumes.id, moved))),
    );
    const actionId = ours.find((r) => r.actionId !== null)?.actionId ?? null;
    return {
      actionId,
      note: actionId
        ? "TIME SHIFT: the pause's resume ran now instead of on its date. PayPal reactivates the subscription in a few seconds."
        : "The resume was brought forward; the next minute's sweep runs it.",
    };
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new JudgeHttpError(400, "invalid_request", z.prettifyError(result.error));
  return result.data;
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send(ErrorEnvelope.parse({ error: { code, message, requestId: request.id } }));
}
