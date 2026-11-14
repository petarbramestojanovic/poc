-- Reports with how their latest delivery went. error_excerpt never holds an address.
SELECT r.id, r.company_id, co.name AS company_name, r.name, r.kind, r.campaign_ids, r.recipients,
       r.schedule_cron, r.timezone, r.report_window, r.settings, r.enabled, r.next_run_at,
       r.created_at,
       (SELECT jsonb_build_object(
                 'id', d.id,
                 'trigger', d.trigger,
                 'status', d.status,
                 'periodStart', d.period_start,
                 'periodEnd', d.period_end,
                 'attempts', d.attempts,
                 'lastAttemptAt', d.last_attempt_at,
                 'error', d.error_excerpt)
          FROM app.email_report_delivery d
         WHERE d.email_report_id = r.id
         ORDER BY d.created_at DESC
         LIMIT 1) AS last_delivery
  FROM app.email_report r
  JOIN app.company co ON co.id = r.company_id
 WHERE $1::uuid IS NULL OR r.id = $1::uuid
 ORDER BY r.created_at DESC
 LIMIT 500;
