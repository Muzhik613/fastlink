-- Secure browsers (fast-ext/src/secure/): once a device reports it is locked, the relay
-- records the lock's key id here and enforces it server-side from then on (sealed calls
-- only, and only while the connected client reports this same lock). Never cleared by the
-- client; revoke the device and pair again to reset.
ALTER TABLE devices ADD COLUMN locked_key_id TEXT;
