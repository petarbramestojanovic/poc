-- 0010_campaign_deal.sql — what the deal behind a campaign says.
--
-- CHANGE TO RFC-004 TABLES, approved by the product owner on 2026-11-02. RFC-004 §4 defines
-- app.campaign without these columns; docs/RFC-004 is kept verbatim, so this header is the record
-- of the deviation. It also narrows a grant of 0006, so it is not purely additive.
--
-- The CRM record of a campaign carries more than the campaign needs: its total, what it is, who
-- sells and who runs it. People want to read that on the campaign. Nothing decides anything by it:
-- no sync, report or rule reads these columns.
--
--   amount, amount_currency    the deal's total ('Amount' in Salesforce: price × impressions / 1000).
--                              Both or neither, NULL when not known, and 0 only when the CRM says 0.
--                              Its own currency because campaign_price_pair keeps `currency` NULL
--                              exactly when the price is, and a deal can have a total without a price.
--   deal_type                  what kind of deal it is, as the CRM names it ('Media Solutions')
--   country                    the market, as the CRM names it ('Austria')
--   creative_types             the creative formats sold, as the CRM names them ('Reveal Ad')
--   owner_name                 the person who owns the deal
--   manager_external_id        the CRM's id of the campaign's manager
--   manager_name               that person's name; a name needs its id, since an id may come alone
--   external_modified_at       when the CRM last changed the record

ALTER TABLE app.campaign
  ADD COLUMN amount                numeric(14, 2),
  ADD COLUMN amount_currency       text,
  ADD COLUMN deal_type             text,
  ADD COLUMN country               text,
  ADD COLUMN creative_types        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN owner_name            text,
  ADD COLUMN manager_external_id   text,
  ADD COLUMN manager_name          text,
  ADD COLUMN external_modified_at  timestamptz,
  ADD CONSTRAINT campaign_amount_pair
    CHECK ((amount IS NULL) = (amount_currency IS NULL)),
  ADD CONSTRAINT campaign_amount_not_negative
    CHECK (amount >= 0),
  ADD CONSTRAINT campaign_amount_currency_format
    CHECK (amount_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT campaign_manager_name_needs_id
    CHECK (manager_name IS NULL OR manager_external_id IS NOT NULL);

COMMENT ON COLUMN app.campaign.amount IS 'The deal''s total in amount_currency; NULL when not known.';

-- A logged-in reader keeps every column it had and gains the manager, whom the product owner wants
-- readers to see; the rest of these stay closed. 0006 granted SELECT on the whole table, which would
-- have shown every logged-in user every company's totals and owners. A table-wide grant cannot be
-- narrowed by revoking a column, so it is replaced by a list: what it covered until now, which is
-- all the read functions need, and the manager's two columns. Since then a reader must name its
-- columns (SELECT * is refused) and a column added later stays closed until someone grants it.
REVOKE SELECT ON app.campaign FROM authenticated;
GRANT SELECT (
  id, company_id, name, legacy_campaign_id, primary_source, timezone, languages, starts_on, ends_on,
  status, created_at, updated_at, external_system, external_id, price, currency,
  manager_external_id, manager_name
) ON app.campaign TO authenticated;
