-- Extra extension ids allowed for one-click sign-in (the Chrome Web Store copy gets its
-- own id). The built-in id stays EXTENSION_ID in wrangler.toml; add others with
-- POST /admin/extension-ids (RELAY_ADMIN_TOKEN). No deploy needed to add one.
CREATE TABLE IF NOT EXISTS extension_ids (
  id        TEXT PRIMARY KEY,          -- 32 chars a-p
  added_at  INTEGER NOT NULL
);
-- users.allow_evaluate / eval_allow_all / is_operator and eval_allowed_origins are no
-- longer read or written (fast_evaluate left the relay on 11-08). They are dropped in a
-- LATER migration, once this code has been live a while: dropping them now would make a
-- rollback to the previous relay version fail at sign-in (it writes is_operator).
