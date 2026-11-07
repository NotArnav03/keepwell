-- Insight aggregates (ARCHITECTURE.md §6.12). Hand-written: Drizzle can't express views.
--
-- A materialized view can't carry row-level security, so tenancy is enforced in two steps: the
-- materialized view itself is unreadable by keepwell_app, and the app reads it through
-- insight_daily, which filters with the same keepwell_can_see() every RLS policy uses. The view is
-- owned by the migrating role (not security_invoker), which is what lets it read the materialized
-- view the app role can't.
--
-- Daily grain, so any from/to range is exact and weeks (date_trunc) are built at query time.
-- Windows are UTC days. The insights.refresh_views job refreshes it hourly.

CREATE MATERIALIZED VIEW insight_daily_mv AS
SELECT
  i.merchant_id,
  (i.created_at AT TIME ZONE 'UTC')::date AS day,
  coalesce(su.plan_name, '(unknown)') AS plan_name,
  i.reason,
  -- Win-back replies have no session; they get their own outcome label instead of 'none'.
  CASE WHEN i.source = 'winback_reply' THEN 'winback_reply' ELSE coalesce(se.outcome, 'none') END AS outcome,
  count(*)::int AS insight_count
FROM insights i
LEFT JOIN sessions se ON se.id = i.session_id
LEFT JOIN subscriptions su ON su.id = coalesce(i.subscription_id, se.subscription_id)
-- Simulated sessions (time machine, injected events) stay out of merchant numbers.
WHERE se.simulated IS NOT TRUE
GROUP BY 1, 2, 3, 4, 5;
--> statement-breakpoint
-- Required by REFRESH ... CONCURRENTLY, so readers are never blocked by a refresh.
CREATE UNIQUE INDEX insight_daily_mv_key ON insight_daily_mv (merchant_id, day, plan_name, reason, outcome);
--> statement-breakpoint
REVOKE ALL ON insight_daily_mv FROM PUBLIC, keepwell_app;
--> statement-breakpoint
-- security_barrier so keepwell_can_see() runs before any function in a caller's WHERE. The view
-- executes as its owner, who can read every row of the materialized view; a leaky predicate must
-- not observe another tenant.
CREATE VIEW insight_daily WITH (security_barrier) AS
SELECT merchant_id, day, plan_name, reason, outcome, insight_count
FROM insight_daily_mv
WHERE keepwell_can_see(merchant_id);
--> statement-breakpoint
REVOKE ALL ON insight_daily FROM PUBLIC, keepwell_app;
--> statement-breakpoint
GRANT SELECT ON insight_daily TO keepwell_app;
--> statement-breakpoint
-- The app role can't own the materialized view, so it refreshes it through this definer function.
-- The cross-tenant switch is transaction-local and would otherwise stay on until the caller
-- commits, so a forMerchant transaction that called this would then see every tenant. Put the
-- previous value back before returning ('' if it was unset: only 'on' opens keepwell_can_see) and
-- keep is_local so a pooled connection never inherits it. Meant to be called from acrossMerchants
-- only. That caller already had the flag on, so restoring it changes nothing there.
CREATE FUNCTION refresh_insight_views() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    previous text;
  BEGIN
    -- Schema-qualified: search_path lists pg_temp, which would otherwise shadow these.
    previous := pg_catalog.current_setting('app.cross_tenant', true);
    PERFORM pg_catalog.set_config('app.cross_tenant', 'on', true);
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.insight_daily_mv;
    PERFORM pg_catalog.set_config('app.cross_tenant', coalesce(previous, ''), true);
  END
  $$;
--> statement-breakpoint
COMMENT ON FUNCTION refresh_insight_views() IS
  'Refreshes insight_daily_mv for every merchant. Meant to be called from acrossMerchants only.';
--> statement-breakpoint
REVOKE ALL ON FUNCTION refresh_insight_views() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION refresh_insight_views() TO keepwell_app;
