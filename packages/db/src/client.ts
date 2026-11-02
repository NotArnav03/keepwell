import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { Id } from "@keepwell/contracts";
import * as schema from "./schema/index.js";

// Tenant isolation lives in Postgres, not in each query: every tenant table has row-level
// security comparing merchant_id with `app.merchant_id` (drizzle/0001_tenant_isolation.sql). A query
// that forgets its merchant sees no rows and can't write any, instead of seeing everyone's. The two
// helpers below are the only ways to set the scope.

/** The role every app query runs as. Unlike Neon's owner role, it can't bypass row-level security. */
export const APP_ROLE = "keepwell_app";

/**
 * pg connection options for the app's pool: each connection becomes APP_ROLE as it opens, so even
 * a raw `pool.query` outside the helpers obeys row-level security. Migrations use a pool without it.
 */
export const APP_ROLE_OPTIONS = `-c role=${APP_ROLE}`;

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;
/** A transaction with its merchant scope set. Platform interfaces take it as their `tx`. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface Db {
  /** Runs `fn` in one transaction that can only see and write this merchant's rows. */
  forMerchant<T>(merchantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` in one transaction that sees every merchant. Only for work that is cross-tenant by
   * nature: the reconciler sweep, the due-work scan, login by email, webhook intake before the
   * merchant is known. Reviewers grep for it.
   */
  acrossMerchants<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export function createDb(pool: Pool): Db {
  const db = drizzle(pool, { schema, casing: "snake_case" });
  // Both settings are transaction-local, so they end with the transaction and never leak to the
  // next query on the same pooled connection. The role is set again in case the pool lacks
  // APP_ROLE_OPTIONS: the helpers must hold even then.
  return {
    async forMerchant(merchantId, fn) {
      // A malformed id would be a cast error inside the policy; fail clearly instead.
      const id = Id.parse(merchantId);
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('role', ${APP_ROLE}, true), set_config('app.merchant_id', ${id}, true)`,
        );
        return fn(tx);
      });
    },
    async acrossMerchants(fn) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('role', ${APP_ROLE}, true), set_config('app.cross_tenant', 'on', true)`,
        );
        return fn(tx);
      });
    },
  };
}
