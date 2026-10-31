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
  coalesce(se.outcome, 'none') AS outcome,
  count(*)::int AS insight_count
FROM insights i
LEFT JOIN sessions se ON se.id = i.session_id
LEFT JOIN subscriptions su ON su.id = se.subscription_id
GROUP BY 1, 2, 3, 4, 5;
--> statement-breakpoint
-- Required by REFRESH ... CONCURRENTLY, so readers are never blocked by a refresh.
CREATE UNIQUE INDEX insight_daily_mv_key ON insight_daily_mv (merchant_id, day, plan_name, reason, outcome);
--> statement-breakpoint
REVOKE ALL ON insight_daily_mv FROM PUBLIC, keepwell_app;
--> statement-breakpoint
CREATE VIEW insight_daily AS
SELECT merchant_id, day, plan_name, reason, outcome, insight_count
FROM insight_daily_mv
WHERE keepwell_can_see(merchant_id);
--> statement-breakpoint
REVOKE ALL ON insight_daily FROM PUBLIC, keepwell_app;
--> statement-breakpoint
GRANT SELECT ON insight_daily TO keepwell_app;
--> statement-breakpoint
-- The app role can't own the materialized view, so it refreshes it through this definer function.
-- It builds the view across all merchants, hence the cross-tenant switch (transaction-local).
CREATE FUNCTION refresh_insight_views() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    PERFORM set_config('app.cross_tenant', 'on', true);
    REFRESH MATERIALIZED VIEW CONCURRENTLY insight_daily_mv;
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION refresh_insight_views() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION refresh_insight_views() TO keepwell_app;
