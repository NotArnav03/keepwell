# @keepwell/db (owner: Arnav, M1)

Drizzle schema for every table in ARCHITECTURE.md §7, forward-only migrations, and the only two ways to query: `forMerchant` and `acrossMerchants`.

## Querying

```ts
import pg from "pg";
import { APP_ROLE_OPTIONS, createDb, scheduledResumes, subscriptions } from "@keepwell/db";
import { eq } from "drizzle-orm";

const pool = new pg.Pool({ connectionString: env.DATABASE_URL_UNPOOLED, options: APP_ROLE_OPTIONS });
const db = createDb(pool);

// One transaction that can only see and write this merchant's rows.
const active = await db.forMerchant(merchantId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.status, "ACTIVE")),
);

// Every merchant: only for work that is cross-tenant by nature (reconciler sweep, due-work scan,
// login by email, webhook intake). Reviewers grep for it.
const due = await db.acrossMerchants((tx) => tx.select().from(scheduledResumes));
```

Pass `tx` on to the platform interfaces (`ActionEngine.create(input, tx)`, `Audit.append(entry, tx)`, …), so their writes commit or roll back with yours.

## How isolation works

Postgres enforces it, so it doesn't depend on every query remembering a `where`:
- **Row-level security** on every tenant table: a row is visible and writable only when its `merchant_id` equals the transaction's `app.merchant_id`, or `app.cross_tenant` is on. Only the two helpers set them, and only for their own transaction. A query outside them sees **no rows** and can't insert.
- **The app runs as `keepwell_app`.** Neon's owner role has BYPASSRLS, so policies alone wouldn't bind it. `APP_ROLE_OPTIONS` makes every pool connection `keepwell_app`, and the helpers switch to it again per transaction. Migrations run as the owner.
- **`audit_log` and `policies` are append-only.** `keepwell_app` has no UPDATE or DELETE on them, and a trigger refuses UPDATE, DELETE and TRUNCATE for every role, the owner included.
- **Tests** prove each of these, including that every table with `merchant_id` has a policy. A new tenant table without one fails CI.

## Migrations

```bash
pnpm db:generate    # after editing src/schema: writes the next drizzle/NNNN_*.sql
pnpm db:migrate     # applies pending migrations to DATABASE_URL_UNPOOLED (your Neon branch)
```

- Forward-only: never edit a merged migration; add a new one.
- Hand-written SQL (roles, RLS, triggers): `pnpm --filter @keepwell/db exec drizzle-kit generate --custom --name <what>`.
- A **new tenant table** must also get RLS in a migration: add it like `drizzle/0001_tenant_isolation.sql` does. The `db.test.ts` coverage check fails until it has.

## Conventions

- Column keys are camelCase in TypeScript and snake_case in Postgres (`casing: "snake_case"`).
- Ids are UUIDv7 (`uuidv7()`, Postgres 18), so they sort by creation time.
- Money is `numeric(12,2)` plus `char(3)`, read back as a decimal string ("12.00"), never a float.
- Enum-like columns are `text` typed from the zod enums in `@keepwell/contracts`, so values can grow without an `ALTER TYPE`.

## Tests

`db.test.ts` runs against a real Postgres 18. It creates a throwaway database, migrates it and drops it afterwards, so it never touches existing data.
- CI runs it in the `database (Postgres 18)` job.
- Locally, set `KEEPWELL_TEST_DATABASE_URL` to your Neon branch's direct URL (its owner can create databases and roles). Without it, these tests are skipped.

## Table owners

Each workstream reviews its file in `src/schema/`:

| File | Tables | Owner |
|---|---|---|
| `merchants.ts` | merchants, merchant_users | M4 Ayush |
| `billing.ts` | plans, subscriptions | M1 |
| `platform.ts` | webhook_events, domain_events, actions, scheduled_resumes, audit_log, pool_subscriptions | M1 |
| `brain.ts` | policies, messages, offers, llm_usage | M2 Ishan |
| `surfaces.ts` | sessions, session_events, delegations | M3 Aditya |
| `growth.ts` | dunning_cases, notifications, insights, insight_actions | M5 Om |
