-- FastLink Relay — agent tokens + feedback (migration v7)
-- Apply with: wrangler d1 migrations apply fastlink-relay --local   (and --remote at deploy time, with Yaakov's OK)
--
-- agents: one row per paired MACHINE (the fast-dxt helper). `node fast-dxt/server/index.js pair <CODE>`
-- POSTs /agent/pair, which claims a pairing code and mints an `fla_…` bearer. Only the
-- sha256 hex of the token is stored. /mcp resolves Bearer fla_… → user_id → the user's DO.
-- No expiry; `revoked = 1` kills it.
--
-- feedback: fast_feedback rows, read by the operator via GET /admin/feedback.
-- Timestamps are epoch MILLISECONDS (Date.now()).

CREATE TABLE agents (
  token_hash  TEXT PRIMARY KEY,          -- sha256(agentToken) hex; the token itself is never stored
  user_id     TEXT NOT NULL,
  label       TEXT,                      -- machine name given at pairing (--name)
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);
CREATE INDEX idx_agents_user ON agents(user_id);

CREATE TABLE feedback (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  TEXT NOT NULL,
  email    TEXT,
  browser  TEXT,                         -- browser name the feedback is about (may be NULL)
  client   TEXT,                         -- MCP clientInfo name/version, else the User-Agent
  kind     TEXT,                         -- 'bug' | 'idea' | 'other'
  text     TEXT NOT NULL,
  ts       INTEGER NOT NULL
);
