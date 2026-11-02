import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import type { z } from "zod";
import { brainJobs, growthJobs, platformJobs } from "@keepwell/contracts";
import { APP_ROLE, type Tx } from "@keepwell/db";

// Jobs on Postgres with pg-boss (ARCHITECTURE.md §6.15), typed by the job registries in
// @keepwell/contracts. Every payload is validated going in and coming out, and each job's
// idempotencyKey becomes pg-boss's singletonKey, so a duplicate send is a no-op. A send can join
// the caller's transaction: the job then exists exactly when the caller's writes commit.

export const jobRegistry = { ...platformJobs, ...brainJobs, ...growthJobs } as const;
export type JobName = keyof typeof jobRegistry;
export type JobPayload<N extends JobName> = z.infer<(typeof jobRegistry)[N]["payload"]>;

export interface JobsLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface JobsOptions {
  /**
   * The owner's direct connection: pg-boss creates and migrates its own schema. Not the app pool
   * (keepwell_app may only use the queue, not change it).
   */
  connectionString: string;
  log: JobsLogger;
  /** How often idle workers look for work. pg-boss's floor is 0.5 s. */
  pollingIntervalSeconds?: number;
  /** First retry delay of a failed job, doubled each time (with jitter). Default 5 s. */
  retryDelaySeconds?: number;
  clock?: () => Date;
}

export interface SendOptions {
  /** Join this transaction: the job is created only if it commits. */
  tx?: Tx;
  startAfter?: Date;
}

const SCHEMA = "pgboss";

export class Jobs {
  private constructor(
    private readonly boss: PgBoss,
    private readonly options: JobsOptions,
  ) {}

  static async start(options: JobsOptions): Promise<Jobs> {
    const boss = new PgBoss({ connectionString: options.connectionString, schema: SCHEMA, max: 4 });
    boss.on("error", (err) => options.log.error({ err }, "pg-boss error"));
    await boss.start();
    // Sending inside a forMerchant transaction runs as keepwell_app, which then needs the queue
    // tables. Granted on every start, so queues created later are covered too.
    const db = boss.getDb();
    await db.executeSql(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${APP_ROLE}`);
    await db.executeSql(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${APP_ROLE}`);
    await db.executeSql(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO ${APP_ROLE}`);
    await db.executeSql(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${SCHEMA} TO ${APP_ROLE}`);
    for (const name of Object.keys(jobRegistry)) {
      if (!(await boss.getQueue(name))) {
        // "exclusive": one job per idempotency key while it is queued, retrying or running, so a
        // duplicate send is a no-op (the job registries' contract). pg-boss's default ignores the key.
        await boss.createQueue(name, {
          policy: "exclusive",
          retryLimit: 5,
          retryDelay: options.retryDelaySeconds ?? 5,
          retryBackoff: true,
        });
      }
    }
    // Queues may have added tables (partitions) since the first grant.
    await db.executeSql(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${APP_ROLE}`);
    return new Jobs(boss, options);
  }

  /** Enqueues a job. Returns its id, or null when a job with the same idempotency key is already queued. */
  async send<N extends JobName>(
    name: N,
    payload: JobPayload<N>,
    options: SendOptions = {},
  ): Promise<string | null> {
    const job = jobRegistry[name] as unknown as {
      payload: z.ZodType<JobPayload<N>>;
      idempotencyKey: (p: JobPayload<N>, now: Date) => string;
    };
    const data = job.payload.parse(payload);
    const now = this.options.clock?.() ?? new Date();
    return this.boss.send(name, data as object, {
      singletonKey: job.idempotencyKey(data, now),
      ...(options.startAfter && { startAfter: options.startAfter }),
      ...(options.tx && { db: fromDrizzle(options.tx, sql) }),
    });
  }

  /**
   * Runs `handler` for each job of `name`, one at a time. A throw fails the attempt and pg-boss
   * retries it with backoff; the payload is validated before the handler sees it.
   */
  async work<N extends JobName>(name: N, handler: (payload: JobPayload<N>) => Promise<void>): Promise<void> {
    const schema = jobRegistry[name].payload as unknown as z.ZodType<JobPayload<N>>;
    await this.boss.work<object>(
      name,
      { batchSize: 1, pollingIntervalSeconds: this.options.pollingIntervalSeconds ?? 2 },
      async (jobs) => {
        for (const job of jobs) {
          try {
            await handler(schema.parse(job.data));
          } catch (err) {
            this.options.log.error({ err, job: name, jobId: job.id, attempt: job.retryCount }, "job failed");
            throw err;
          }
        }
      },
    );
  }

  /** A recurring job, e.g. the due-work sweep every minute. */
  async schedule<N extends JobName>(name: N, cron: string, payload: JobPayload<N>): Promise<void> {
    await this.boss.schedule(name, cron, jobRegistry[name].payload.parse(payload));
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}
