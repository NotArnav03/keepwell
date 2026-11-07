import { and, eq, gte, lt, sql } from "drizzle-orm";
import { llmUsage, type Db } from "@keepwell/db";
import type { LlmUsageEntry, LlmUsageStore, NanoUsd } from "./budget.js";

// The budget guard's usage store on Postgres (#26, #83): one llm_usage row per model call. The
// table is deployment-wide (no merchant_id, no row-level security), so every query runs through
// acrossMerchants. Recorded rows are append-only for the app role (migration 0004).

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export class PgLlmUsageStore implements LlmUsageStore {
  constructor(private readonly db: Db) {}

  /** Spend in [day 00:00Z, next day 00:00Z), as a range on `at` so the index on it serves the sum. */
  async spentOn(day: string): Promise<NanoUsd> {
    if (!DAY.test(day)) throw new Error(`Expected a UTC day like 2026-11-03, got ${day}`);
    const from = new Date(`${day}T00:00:00.000Z`);
    const to = new Date(from.getTime() + DAY_MS);
    const [row] = await this.db.acrossMerchants((tx) =>
      tx
        // sum(bigint) is numeric, which pg returns as a string.
        .select({ total: sql<string>`coalesce(sum(${llmUsage.costNanoUsd}), 0)` })
        .from(llmUsage)
        .where(and(gte(llmUsage.at, from), lt(llmUsage.at, to))),
    );
    return Number(row?.total ?? 0);
  }

  async sessionTotals(sessionId: string): Promise<{ durationMs: number; tokens: number }> {
    const [row] = await this.db.acrossMerchants((tx) =>
      tx
        .select({
          durationMs: sql<string>`coalesce(sum(${llmUsage.durationMs}), 0)`,
          tokens: sql<string>`coalesce(sum(${llmUsage.inputTokens} + ${llmUsage.outputTokens} + ${llmUsage.cacheReadTokens} + ${llmUsage.cacheWriteTokens}), 0)`,
        })
        .from(llmUsage)
        .where(eq(llmUsage.sessionId, sessionId)),
    );
    return { durationMs: Number(row?.durationMs ?? 0), tokens: Number(row?.tokens ?? 0) };
  }

  async record(entry: LlmUsageEntry): Promise<void> {
    await this.db.acrossMerchants((tx) =>
      tx.insert(llmUsage).values({
        at: new Date(entry.at),
        sessionId: entry.sessionId,
        purpose: entry.purpose,
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheReadTokens: entry.cacheReadTokens,
        cacheWriteTokens: entry.cacheWriteTokens,
        costNanoUsd: entry.costNanoUsd,
        durationMs: entry.durationMs,
      }),
    );
  }
}
