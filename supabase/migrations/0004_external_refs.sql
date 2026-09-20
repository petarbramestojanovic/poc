-- 0004_external_refs.sql — where a company or campaign came from, when it came from another system.
--
-- ADDITIVE CHANGE TO RFC-004 TABLES, approved by the product owner on 2026-09-20. RFC-004 §4
-- defines app.company and app.campaign without these columns; docs/RFC-004 is kept verbatim, so
-- this header is the record of the deviation.
--
-- Campaign setup is one reusable service (src/campaigns/). A person types a campaign into a form
-- today; a CRM (Salesforce first) will push the same data tomorrow. A push has to be repeatable:
-- the second time the same record arrives it must update our row, not create a twin. That needs a
-- key the caller owns. `legacy_*_id` is not it — RFC-004 reserves those for the Brame parent-app
-- ids and the phase-2 backfill.
--
--   external_system   who owns the id: 'salesforce', 'hubspot', … a short lowercase slug
--   external_id       that system's id for the record
--
-- Both are NULL for rows created by hand. Campaign setup never depends on them: they identify a
-- row, they do not describe it, so no CRM field leaks into the model.

ALTER TABLE app.company
  ADD COLUMN external_system text,
  ADD COLUMN external_id     text,
  ADD CONSTRAINT company_external_ref_pair
    CHECK ((external_system IS NULL) = (external_id IS NULL)),
  ADD CONSTRAINT company_external_ref_format
    CHECK (external_system ~ '^[a-z][a-z0-9_]{0,31}$' AND external_id <> '');

ALTER TABLE app.campaign
  ADD COLUMN external_system text,
  ADD COLUMN external_id     text,
  ADD CONSTRAINT campaign_external_ref_pair
    CHECK ((external_system IS NULL) = (external_id IS NULL)),
  ADD CONSTRAINT campaign_external_ref_format
    CHECK (external_system ~ '^[a-z][a-z0-9_]{0,31}$' AND external_id <> '');

-- NEW INDEXES (flag in the PR). One row per (system, id); rows created by hand are not indexed.
CREATE UNIQUE INDEX company_external_ref_key
  ON app.company (external_system, external_id) WHERE external_system IS NOT NULL;
CREATE UNIQUE INDEX campaign_external_ref_key
  ON app.campaign (external_system, external_id) WHERE external_system IS NOT NULL;

COMMENT ON COLUMN app.company.external_system  IS 'System that owns external_id (e.g. salesforce); NULL for rows created by hand.';
COMMENT ON COLUMN app.campaign.external_system IS 'System that owns external_id (e.g. salesforce); NULL for rows created by hand.';
