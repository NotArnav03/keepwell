-- Tenant isolation and append-only tables. Hand-written: Drizzle can't express roles, RLS or triggers.
--
-- The app runs its queries as `keepwell_app`, a role without BYPASSRLS. That matters on Neon, whose
-- owner role (neondb_owner) has BYPASSRLS, so row-level security would never bind it. The app pool
-- switches to keepwell_app at connect (APP_ROLE_OPTIONS), and Db.forMerchant / Db.acrossMerchants
-- switch again per transaction (src/client.ts). Migrations keep running as the owner.
--
-- Every tenant table gets row-level security (also FORCEd, for owners without BYPASSRLS). A row is
-- visible and writable when its merchant_id equals `app.merchant_id`, or when `app.cross_tenant`
-- is 'on'; only the two helpers set them, per transaction. With neither set, a query sees nothing
-- and can write nothing. Foreign-key checks bypass RLS, as Postgres always does.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keepwell_app') THEN
    CREATE ROLE keepwell_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
-- The migrating role (the app's login role) may then SET ROLE keepwell_app.
GRANT keepwell_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO keepwell_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO keepwell_app;
--> statement-breakpoint
-- Tables from later migrations get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO keepwell_app;
--> statement-breakpoint
CREATE FUNCTION keepwell_can_see(row_merchant uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$
    SELECT coalesce(current_setting('app.cross_tenant', true), '') = 'on'
        OR row_merchant = nullif(current_setting('app.merchant_id', true), '')::uuid
  $$;
--> statement-breakpoint
ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE merchants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON merchants USING (keepwell_can_see(id)) WITH CHECK (keepwell_can_see(id));
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  -- Every table with merchant_id. llm_usage is deployment-wide and has none.
  -- A new tenant table must be added in its own migration; db.test.ts fails until it is.
  FOREACH t IN ARRAY ARRAY[
    'merchant_users', 'plans', 'subscriptions', 'webhook_events', 'domain_events', 'actions',
    'scheduled_resumes', 'audit_log', 'pool_subscriptions', 'policies', 'messages', 'offers',
    'sessions', 'session_events', 'delegations', 'dunning_cases', 'notifications', 'insights',
    'insight_actions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (keepwell_can_see(merchant_id)) WITH CHECK (keepwell_can_see(merchant_id))',
      t
    );
  END LOOP;
END $$;
--> statement-breakpoint
-- audit_log and policies never change once written (§6.16, #80). The app role has no UPDATE or
-- DELETE on them, and a trigger refuses both (and TRUNCATE) for every role, the owner included.
CREATE FUNCTION keepwell_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION keepwell_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION keepwell_append_only();
--> statement-breakpoint
CREATE TRIGGER policies_append_only BEFORE UPDATE OR DELETE ON policies
  FOR EACH ROW EXECUTE FUNCTION keepwell_append_only();
--> statement-breakpoint
CREATE TRIGGER policies_no_truncate BEFORE TRUNCATE ON policies
  FOR EACH STATEMENT EXECUTE FUNCTION keepwell_append_only();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log, policies FROM PUBLIC, keepwell_app;
