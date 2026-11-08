-- 0013_provisioning_run.sql — the record of one provisioning run.
--
-- Additive (approved with the provisioning plan, 2026-11-08). Provisioning creates a campaign and
-- its creatives on the platforms (CLAUDE.md, Provisioning): several HTTP calls, minutes long, each
-- step's resources committed as they are made (external.provisioned_resource, 0011). This table is
-- the run itself, like external.sync_run is for a sync: when it ran, why, how it ended, what it
-- warned about, and what it said to the platforms (redacted). One run per campaign at a time.

CREATE TABLE external.provisioning_run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES app.campaign(id) ON DELETE CASCADE,
  trigger       text NOT NULL CHECK (trigger IN ('manual', 'crm', 'creative')),
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  warnings      jsonb NOT NULL DEFAULT '[]',
  steps         jsonb NOT NULL DEFAULT '[]',                      -- redacted request/response pairs, in order, capped by the service

  error         text,
  CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX ON external.provisioning_run (campaign_id, started_at DESC);

COMMENT ON TABLE external.provisioning_run IS
  'One provisioning run of a campaign: when, why, how it ended, what it said to the platforms. Resources it made are in provisioned_resource.';

-- Row level security (0006): the console shows runs like it shows sync runs; a reader may select.
ALTER TABLE external.provisioning_run ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON external.provisioning_run TO authenticated;
CREATE POLICY read_authenticated ON external.provisioning_run FOR SELECT TO authenticated USING (true);
