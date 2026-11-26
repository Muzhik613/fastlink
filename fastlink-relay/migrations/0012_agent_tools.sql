-- FastLink Relay — per-token tool allowlist (migration v12)
-- agents.tools: JSON array of tool names this token may list and call (e.g. ["fast_list","fast_watch"]).
-- NULL = every tool its other scopes allow.
ALTER TABLE agents ADD COLUMN tools TEXT;
