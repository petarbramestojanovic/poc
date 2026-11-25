-- The day zone of our own instrumentation: a page event is counted on its day there.
SELECT s.day_timezone
  FROM external.source s
 WHERE s.id = 'brame'
