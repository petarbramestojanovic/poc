-- May this link's platform ids still change? Not while a real sync run is fetching with them (the
-- same 'running' rule as sync/sql/run_gate_status.sql, read under the same gate lock), and not once
-- any row was written with them: those rows would stay attributed to the wrong ids.
-- The analytics primary keys start with (campaign_id, source, language), so each EXISTS is a probe.
SELECT EXISTS (
         SELECT 1 FROM external.sync_run
          WHERE link_id = $1 AND NOT dry_run AND status = 'running'
            AND started_at > now() - interval '6 hours'
       ) AS running,
       EXISTS (SELECT 1 FROM analytics.advanced_analytics
                WHERE campaign_id = $2 AND source = $3 AND language = $4)
    OR EXISTS (SELECT 1 FROM analytics.page_views
                WHERE campaign_id = $2 AND source = $3 AND language = $4)
    OR EXISTS (SELECT 1 FROM analytics.cta_clicks
                WHERE campaign_id = $2 AND source = $3 AND language = $4) AS has_data;
