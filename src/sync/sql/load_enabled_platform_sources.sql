-- Boot check: these must equal the connector registry's ids.
SELECT id FROM external.source WHERE enabled AND kind = 'platform' ORDER BY id
