-- The outcome of a connection probe, shown next to the credential (RFC-004 §3).
UPDATE external.credential
   SET last_checked_at = now(), last_check_ok = $2
 WHERE id = $1
