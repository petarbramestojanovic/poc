-- 0011_creative.sql — a creative is one record of ours; every platform points at it.
--
-- CHANGE TO RFC-004 TABLES, approved by the product owner on 2026-11-08 (phase-2 provisioning
-- plan). RFC-004 has no creative table: a creative was two unrelated external.link_entity rows,
-- one per platform, that happened to share a campaign_tag, each with its own label. From now on a
-- campaign's creatives are created by us (soon by provisioning on NEXD, and derived ids on Zeus),
-- so they exist before any platform knows them and have facts of their own. docs/RFC-004 is kept
-- verbatim; this header is the record of the deviation.
--
-- Three things, all additive:
--
--   app.creative                 the identity: campaign, tag, type (the CRM's creative type) and
--                                name. `tag` is what the analytics writer stamps on the creative's
--                                rows, and from now on it is the creative's own id — no platform id
--                                ever enters an analytics row. It never changes (trigger). The rows
--                                already written keep the tags they have: existing creatives are
--                                backfilled below with their current tag, so no analytics row moves.
--   external.link_entity         gains creative_id: the NEXD live id, the Zeus creative id and a
--                                pixel all point at the one creative whose rows they feed. A
--                                trigger keeps the copy honest: an entity with a non-empty tag names
--                                a creative of its link's campaign, and carries that creative's tag.
--   external.provisioned_resource what a platform hands us when we create something there and the
--                                sync never asks for (a NEXD import id, a publish id, a NEXD
--                                campaign id). By source, never by column, like external.credential:
--                                `kind` is the connector's word. Nothing writes it yet; provisioning
--                                does.
--
-- `app` names no platform anywhere here, so replacing NEXD or Zeus is a new connector, not a
-- migration (CLAUDE.md, Campaign setup).

-- ---------------------------------------------------------------------------------------------
-- 1. app.creative
-- ---------------------------------------------------------------------------------------------

CREATE TABLE app.creative (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES app.campaign(id) ON DELETE CASCADE,
  tag          text NOT NULL CHECK (tag <> ''),                 -- what the writer stamps; = id::text for creatives created from now on
  type         text CHECK (type <> ''),                         -- the creative type as the CRM names it ('Swipe Card'); NULL = not known
  name         text NOT NULL CHECK (name <> ''),                -- what a report prints for the creative's rows
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, tag)
);

COMMENT ON TABLE app.creative IS
  'One creative of a campaign, ours: the platforms'' ids for it are link_entity rows pointing here. tag is the analytics dimension its rows carry and never changes.';

-- The tag keys every analytics row of the creative. Changing it would orphan them.
CREATE FUNCTION app.creative_tag_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.tag <> OLD.tag THEN
    RAISE EXCEPTION 'creative: tag of % cannot change (% -> %)', OLD.id, OLD.tag, NEW.tag
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER creative_tag_immutable
  BEFORE UPDATE ON app.creative
  FOR EACH ROW EXECUTE FUNCTION app.creative_tag_immutable();

-- ---------------------------------------------------------------------------------------------
-- 2. external.link_entity → app.creative
-- ---------------------------------------------------------------------------------------------

ALTER TABLE external.link_entity
  ADD COLUMN creative_id uuid REFERENCES app.creative(id) ON DELETE RESTRICT;

CREATE INDEX ON external.link_entity (creative_id);

-- Backfill: one creative per (campaign, tag) that a creative entity stamps today, named the way
-- the reports have named it so far (webhooks/sql/report_labels.sql: the smallest label; the id
-- when nobody labelled it). The tag stays what it is, so no analytics row is re-keyed. Every
-- entity with that tag — the creative's own ids on each platform, and the pixels that count for
-- it — then points at the creative.
INSERT INTO app.creative (campaign_id, tag, name)
SELECT l.campaign_id, e.campaign_tag, coalesce(min(e.label), min(e.external_id))
  FROM external.link_entity e
  JOIN external.campaign_link l ON l.id = e.link_id
 WHERE e.level = 'creative'
   AND e.campaign_tag <> ''
 GROUP BY l.campaign_id, e.campaign_tag;

UPDATE external.link_entity e
   SET creative_id = c.id
  FROM external.campaign_link l
  JOIN app.creative c ON c.campaign_id = l.campaign_id
 WHERE l.id = e.link_id
   AND e.campaign_tag <> ''
   AND c.tag = e.campaign_tag;

-- A non-empty tag is a creative's tag: the entity names the creative, the creative belongs to the
-- link's campaign, and the stamped tag is the creative's. '' stays the campaign's own row and
-- names nothing. Raised as 'link_entity: …' so the setup service can answer it as the caller's
-- mistake (a 4xx), like the event_map trigger.
CREATE FUNCTION external.validate_entity_creative() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_creative     app.creative%ROWTYPE;
  v_campaign_id  uuid;
BEGIN
  IF NEW.campaign_tag = '' THEN
    IF NEW.creative_id IS NOT NULL THEN
      RAISE EXCEPTION 'link_entity: % % has no tag and so names no creative', NEW.level, NEW.external_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.creative_id IS NULL THEN
    RAISE EXCEPTION 'link_entity: % % carries tag % without a creative', NEW.level, NEW.external_id, NEW.campaign_tag
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_creative FROM app.creative WHERE id = NEW.creative_id;
  SELECT campaign_id INTO v_campaign_id FROM external.campaign_link WHERE id = NEW.link_id;

  IF v_creative.campaign_id IS DISTINCT FROM v_campaign_id THEN
    RAISE EXCEPTION 'link_entity: creative % belongs to another campaign', NEW.creative_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_creative.tag <> NEW.campaign_tag THEN
    RAISE EXCEPTION 'link_entity: % % carries tag % but its creative is tagged %', NEW.level, NEW.external_id, NEW.campaign_tag, v_creative.tag
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_entity_creative
  BEFORE INSERT OR UPDATE ON external.link_entity
  FOR EACH ROW EXECUTE FUNCTION external.validate_entity_creative();

-- ---------------------------------------------------------------------------------------------
-- 3. external.provisioned_resource
-- ---------------------------------------------------------------------------------------------

CREATE TABLE external.provisioned_resource (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    text NOT NULL REFERENCES external.source(id),
  campaign_id  uuid NOT NULL REFERENCES app.campaign(id) ON DELETE CASCADE,
  creative_id  uuid REFERENCES app.creative(id) ON DELETE CASCADE,   -- NULL = a campaign-level resource
  kind         text NOT NULL CHECK (kind <> ''),                     -- the connector's word: 'campaign', 'creative', 'publish' …
  external_id  text NOT NULL CHECK (external_id <> ''),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, kind, external_id)                              -- a platform's thing is ours once
);
CREATE INDEX ON external.provisioned_resource (campaign_id);
CREATE INDEX ON external.provisioned_resource (creative_id);

COMMENT ON TABLE external.provisioned_resource IS
  'Ids a platform handed us when we created something there and the sync never asks for. Written by provisioning only.';

-- ---------------------------------------------------------------------------------------------
-- 4. Row level security (0006). The console shows a campaign's creatives, so a logged-in reader
--    may select app.creative. provisioned_resource stays closed, like the rest of external.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE app.creative                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE external.provisioned_resource  ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON app.creative TO authenticated;
CREATE POLICY read_authenticated ON app.creative FOR SELECT TO authenticated USING (true);
