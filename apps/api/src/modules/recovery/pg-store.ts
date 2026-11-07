import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { DunningCase, type Money } from "@keepwell/contracts";
import { actions, auditLog, dunningCases, type Tx } from "@keepwell/db";
import type { DunningCasePatch, DunningStore, NewDunningCase } from "./ports.js";

// Postgres DunningStore. Callers pass the transaction from db.forMerchant (row-level security
// scopes it); the merchant id is repeated in every WHERE so a wrong scope can never match.

type Row = typeof dunningCases.$inferSelect;

const ACTIVE = ["open", "suspended"] as const;

const money = (value: string | null, currency: string | null): Money | null =>
  value !== null && currency !== null ? { value, currency } : null;

function toCase(row: Row): DunningCase {
  return DunningCase.parse({
    id: row.id,
    merchantId: row.merchantId,
    subscriptionId: row.subscriptionId,
    reasonCode: row.reasonCode,
    failedCount: row.failedCount,
    nextRetryTime: row.nextRetryTime?.toISOString() ?? null,
    playbook: row.playbook,
    state: row.state,
    outstanding: money(row.outstandingValue, row.outstandingCurrency),
    recoveredAmount: money(row.recoveredValue, row.recoveredCurrency),
    notificationId: row.notificationId,
    captureActionId: row.captureActionId,
    simulated: row.simulated,
    openedAt: row.openedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: row.closedAt?.toISOString() ?? null,
  });
}

const date = (iso: string | null): Date | null => (iso === null ? null : new Date(iso));

/** Only the fields present in the patch, as columns (undefined means "leave alone"). */
function toColumns(patch: DunningCasePatch) {
  return {
    reasonCode: patch.reasonCode,
    failedCount: patch.failedCount,
    nextRetryTime: patch.nextRetryTime === undefined ? undefined : date(patch.nextRetryTime),
    playbook: patch.playbook,
    state: patch.state,
    outstandingValue: patch.outstanding === undefined ? undefined : (patch.outstanding?.value ?? null),
    outstandingCurrency: patch.outstanding === undefined ? undefined : (patch.outstanding?.currency ?? null),
    recoveredValue: patch.recoveredAmount === undefined ? undefined : (patch.recoveredAmount?.value ?? null),
    recoveredCurrency:
      patch.recoveredAmount === undefined ? undefined : (patch.recoveredAmount?.currency ?? null),
    notificationId: patch.notificationId,
    captureActionId: patch.captureActionId,
    simulated: patch.simulated,
    updatedAt: patch.updatedAt === undefined ? undefined : new Date(patch.updatedAt),
    closedAt: patch.resolvedAt === undefined ? undefined : date(patch.resolvedAt),
  };
}

export class PgDunningStore implements DunningStore<Tx> {
  async findActive(
    tx: Tx,
    merchantId: string,
    subscriptionId: string,
    options: { lock?: boolean } = {},
  ): Promise<DunningCase | null> {
    const query = tx
      .select()
      .from(dunningCases)
      .where(
        and(
          eq(dunningCases.merchantId, merchantId),
          eq(dunningCases.subscriptionId, subscriptionId),
          inArray(dunningCases.state, ACTIVE),
        ),
      );
    const [row] = await (options.lock ? query.for("update") : query);
    return row ? toCase(row) : null;
  }

  async insert(tx: Tx, c: NewDunningCase): Promise<DunningCase> {
    const [row] = await tx
      .insert(dunningCases)
      .values({
        merchantId: c.merchantId,
        subscriptionId: c.subscriptionId,
        reasonCode: c.reasonCode,
        failedCount: c.failedCount,
        nextRetryTime: date(c.nextRetryTime),
        playbook: c.playbook,
        state: c.state,
        outstandingValue: c.outstanding?.value ?? null,
        outstandingCurrency: c.outstanding?.currency ?? null,
        recoveredValue: c.recoveredAmount?.value ?? null,
        recoveredCurrency: c.recoveredAmount?.currency ?? null,
        notificationId: c.notificationId,
        captureActionId: c.captureActionId,
        simulated: c.simulated,
        openedAt: new Date(c.openedAt),
        updatedAt: new Date(c.updatedAt),
        closedAt: date(c.resolvedAt),
      })
      .returning();
    if (!row) throw new Error("dunning_cases insert returned nothing");
    return toCase(row);
  }

  async update(tx: Tx, merchantId: string, id: string, patch: DunningCasePatch): Promise<DunningCase> {
    const [row] = await tx
      .update(dunningCases)
      .set(toColumns(patch))
      .where(and(eq(dunningCases.merchantId, merchantId), eq(dunningCases.id, id)))
      .returning();
    if (!row) throw new Error(`No dunning case ${id} for merchant ${merchantId}`);
    return toCase(row);
  }

  async listUnnotified(tx: Tx): Promise<DunningCase[]> {
    const rows = await tx
      .select()
      .from(dunningCases)
      .where(
        and(
          eq(dunningCases.state, "open"),
          isNull(dunningCases.notificationId),
          ne(dunningCases.playbook, "wait_for_retry"),
        ),
      );
    return rows.map(toCase);
  }

  async findRecentVoluntarySuspend(
    tx: Tx,
    merchantId: string,
    subscriptionId: string,
    since: Date,
  ): Promise<{ id: string } | null> {
    // updatedAt is when the engine last moved the Action. While the row is still APPLIED or
    // CONFIRMED, that is when the suspend took effect (or was confirmed).
    const [row] = await tx
      .select({ id: actions.id })
      .from(actions)
      .where(
        and(
          eq(actions.merchantId, merchantId),
          eq(actions.subscriptionId, subscriptionId),
          eq(actions.type, "suspend"),
          inArray(actions.state, ["APPLIED", "CONFIRMED"]),
          ne(actions.origin, "recovery"),
          gte(actions.updatedAt, since),
        ),
      )
      .orderBy(desc(actions.updatedAt))
      .limit(1);
    return row ?? null;
  }

  async voluntarySuspendNoted(tx: Tx, merchantId: string, actionId: string): Promise<boolean> {
    const [row] = await tx
      .select({ seq: auditLog.seq })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.merchantId, merchantId),
          eq(auditLog.kind, "dunning.voluntary_suspend"),
          sql`exists (select 1 from jsonb_each_text(${auditLog.subjectIds}) s where s.value = ${actionId})`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }
}
