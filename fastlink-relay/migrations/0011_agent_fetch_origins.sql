-- FastLink Relay — per-token page-fetch origins (migration v11)
-- agents.fetch_origins: JSON array of origins (e.g. ["https://www.jewelosco.com"]) where this token
-- may use fast_fetch (a fetch from inside a tab on that origin). NULL = no fast_fetch at all.
ALTER TABLE agents ADD COLUMN fetch_origins TEXT;
