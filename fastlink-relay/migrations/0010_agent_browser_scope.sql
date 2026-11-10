-- FastLink Relay — per-token browser scope (migration v10)
-- agents.browsers: JSON array of browser names this token may drive (e.g. ["winytx","office"]);
-- NULL = every browser on the account (machine helpers, as before). Enforced in mcp.js.
ALTER TABLE agents ADD COLUMN browsers TEXT;
