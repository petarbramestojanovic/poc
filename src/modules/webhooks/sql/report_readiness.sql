-- The campaigns of a report whose source data ($3) does not yet cover the period ($4..$5): a
-- scheduled report waits for them (scheduler.ts). Only campaigns that should have numbers count —
-- not archived, flight touching the period (an unknown date never excludes one), and an enabled
-- link to the source. Each link must be fully written through the period's last day, or through
-- the campaign's end when it ends inside the period; a link never synced is not complete.
SELECT c.name
  FROM app.campaign c
  JOIN external.campaign_link l
    ON l.campaign_id = c.id AND l.source_id = $3 AND l.enabled
  LEFT JOIN external.sync_state s ON s.link_id = l.id
 WHERE c.company_id = $1
   AND ($2::uuid[] IS NULL OR c.id = ANY ($2::uuid[]))
   AND c.status <> 'archived'
   AND (c.starts_on IS NULL OR c.starts_on <= $5::date)
   AND (c.ends_on IS NULL OR c.ends_on >= $4::date)
   AND (s.data_complete_through IS NULL
        OR s.data_complete_through < least($5::date, coalesce(c.ends_on, $5::date)))
 GROUP BY c.id, c.name
 ORDER BY c.name, c.id;
