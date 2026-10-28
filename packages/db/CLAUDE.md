# packages/db

**Owner: Arnav (M1 Rails).** Drizzle schema and migrations.

Root `CLAUDE.md` rules apply. Rules specific to this package:

- Migrations are forward-only and reviewed by Arnav. Never edit a migration that has been merged.
- Every tenant table has `merchant_id`. Money columns are `numeric(12,2)` plus a currency, never floats.
- `audit_log` is append-only: the app's database role has no UPDATE or DELETE on it.
