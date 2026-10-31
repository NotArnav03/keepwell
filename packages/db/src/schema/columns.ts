import { sql } from "drizzle-orm";
import { char, numeric, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Shared column builders. Column names come from the keys (camelCase → snake_case via `casing`).
// Ids are UUIDv7 from Postgres 18's uuidv7(), so they sort by creation time.

export const id = () =>
  uuid()
    .primaryKey()
    .default(sql`uuidv7()`);

/** Every tenant table has it, and row-level security filters on it (0001_tenant_isolation.sql). */
export const merchantId = () => uuid().notNull();

export const at = () => timestamp({ withTimezone: true, mode: "date" });

export const createdAt = () => at().notNull().defaultNow();

/** Money is numeric(12,2) plus char(3), read as a decimal string, never a float (CLAUDE.md §3). */
export const amount = () => numeric({ precision: 12, scale: 2 });
export const currency = () => char({ length: 3 });

/** A text column limited to a zod enum's values. zod's `.options` is an array; Drizzle wants a tuple. */
export const enumText = <T extends string>(values: readonly T[]) => text({ enum: values as [T, ...T[]] });
