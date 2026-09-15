-- FastLink Relay — device NAMES (multi-browser targeting)
-- Apply with: wrangler d1 migrations apply fastlink-relay --remote   (and --local for dev)
--
-- `devices.label` already existed but was never used as an identity: every
-- pairing path hard-coded the literal 'browser', so a user with two paired
-- browsers had two devices both called "browser" and no way to say which one a
-- chat session should drive. This migration turns `label` into the user-facing
-- NAME and makes it addressable:
--
--   1. Renumber existing labels to browser-1, browser-2 … per user (ordered by
--      pairing time). Nothing is lost: every pre-migration label is the same
--      hard-coded 'browser' string. The names are already sanitized under the
--      shared rule ([a-z0-9_-], ≤32) and users rename them from the extension's
--      options page.
--   2. Enforce per-user uniqueness. PARTIAL index (revoked = 0) so revoking a
--      browser frees its name for a replacement.

UPDATE devices
   SET label = 'browser-' || (
         SELECT COUNT(*)
           FROM devices d2
          WHERE d2.user_id = devices.user_id
            AND (d2.created_at < devices.created_at
                 OR (d2.created_at = devices.created_at AND d2.device_token <= devices.device_token))
       );

CREATE UNIQUE INDEX idx_devices_user_label
    ON devices(user_id, label)
 WHERE revoked = 0;
