-- FastLink Relay — per-token page origins (migration v13)
-- agents.origins: JSON array of origins (e.g. ["https://messages.google.com"]). A token with a list
-- may act only on tabs on those origins, and fast_nav / fast_tab only to URLs on them. NULL = any.
ALTER TABLE agents ADD COLUMN origins TEXT;
