// src/timing.js — per-session tool-call timing trace for the cloud relay.
//
// Mirrors fast-dxt/server/handlers.js logTiming EXACTLY in semantics, so a relay
// run and a local run render through the same formatter (fast-dxt/server/
// timing-format.js) and can be compared side by side:
//   gapMs = thisCall.start - previousCall.end  → the MODEL's think/round-trip time
//   durMs = thisCall.end   - thisCall.start    → action execution time
//
// WHY DO STORAGE (not logs): the relay hibernates between calls and a Worker has
// no filesystem, so the trace has to be durable to survive a run and be readable
// afterwards without `wrangler tail`. The DO is already the per-user singleton
// every tools/call passes through, so its SQLite-backed storage is the natural
// home — no new binding, no D1 migration, no cross-user store.
//
// KEYS (all inside the user's own DO):
//   tidx                  → [{ id, startedAt }]      session index (pruned)
//   tmeta:<sessionId>     → { id, startedAt, client, ua, tokenKey, seq, lastReturnTs }
//   trow:<sessionId>:<6-digit seq> → { t, name, gapMs, durMs }
//   tcur:<tokenKey>       → sessionId    (the live session for one MCP connection)
//
// SESSION SCOPE: one session per MCP connection. Streamable HTTP is stateless, so
// a connection is identified by the Bearer access token it presents (each MCP
// client — Claude vs Grok vs GPT — holds its own OAuth grant/token), plus the
// Mcp-Session-Id we mint at `initialize` and hand back, which survives an access
// token refresh for clients that echo it. Concurrent clients therefore land in
// separate sessions instead of interleaving into one stream.
//
// COST: warm path is pure in-memory (gap math off a cached meta object); the two
// storage puts + at most one delete run in ctx.waitUntil AFTER the response is
// produced, so they add nothing to tool-call latency.

const MAX_ROWS = 500;              // ring buffer per session
const MAX_SESSIONS = 20;           // keep the last N sessions per user
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SID_RE = /^[0-9a-f-]{36}$/i;

const rowKey = (id, seq) => `trow:${id}:${String(seq).padStart(6, '0')}`;

// Lazy per-DO in-memory cache: { byToken: Map<tokenKey,sessionId>, meta: Map<sessionId,meta> }.
// Rebuilt from storage after a hibernation wake.
function state(relay) {
  if (!relay._trace) relay._trace = { byToken: new Map(), meta: new Map() };
  return relay._trace;
}

// Stable, non-reversible 8-byte hex digest. THE fingerprint primitive for the
// relay — used here to key a trace session by its credential and by
// userRelay.js to key a browser selection by the chat product driving it.
// Nothing sensitive is ever stored: only the digest.
export async function fingerprint(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Stable, non-reversible id for the MCP connection's credential. We never store
// the token itself — just 8 bytes of its SHA-256.
export async function tokenKey(request) {
  const auth = request.headers.get('authorization') || '';
  if (!auth) return 'anon';
  return fingerprint(auth);
}

async function loadMeta(relay, sessionId) {
  const st = state(relay);
  let meta = st.meta.get(sessionId);
  if (meta) return meta;
  try { meta = await relay.ctx.storage.get(`tmeta:${sessionId}`); } catch { meta = null; }
  if (meta) st.meta.set(sessionId, meta);
  return meta || null;
}

// Which session does this POST belong to? null = none yet (caller starts one).
export async function resolveTraceSession(relay, request) {
  const sid = request.headers.get('mcp-session-id');
  if (sid && SID_RE.test(sid) && (await loadMeta(relay, sid))) return sid;
  const tk = await tokenKey(request);
  const st = state(relay);
  const cached = st.byToken.get(tk);
  if (cached) return cached;
  let cur = null;
  try { cur = await relay.ctx.storage.get(`tcur:${tk}`); } catch { /* fresh session below */ }
  if (cur) { st.byToken.set(tk, cur); return cur; }
  return null;
}

// Open a session and record who is driving. `clientInfo` is the MCP
// initialize params.clientInfo ({name, version}) — this is what attributes a
// trace to "claude" vs "grok" vs "gpt"; the User-Agent is kept as a backstop for
// clients that send no clientInfo.
export async function startTraceSession(relay, request, clientInfo) {
  const tk = await tokenKey(request);
  const id = crypto.randomUUID();
  const meta = {
    id,
    startedAt: Date.now(),
    client: {
      name: str(clientInfo?.name) || null,
      version: str(clientInfo?.version) || null,
    },
    ua: str(request.headers.get('user-agent')) || null,
    tokenKey: tk,
    seq: 0,
    lastReturnTs: null,
  };
  const st = state(relay);
  st.meta.set(id, meta);
  st.byToken.set(tk, id);
  waitUntil(relay, persistNewSession(relay, meta));
  return id;
}

async function persistNewSession(relay, meta) {
  const storage = relay.ctx.storage;
  await storage.put({ [`tmeta:${meta.id}`]: meta, [`tcur:${meta.tokenKey}`]: meta.id });
  // Index + prune old sessions (and their rows) so a long-lived DO can't grow
  // without bound.
  let idx = [];
  try { idx = (await storage.get('tidx')) || []; } catch { /* rebuild */ }
  idx = idx.filter((s) => s && s.id !== meta.id);
  idx.push({ id: meta.id, startedAt: meta.startedAt });
  const cutoff = Date.now() - SESSION_TTL_MS;
  const keep = idx.filter((s) => (s.startedAt || 0) >= cutoff).slice(-MAX_SESSIONS);
  const drop = idx.filter((s) => !keep.some((k) => k.id === s.id));
  await storage.put('tidx', keep);
  for (const s of drop) await dropSession(relay, s.id);
}

async function dropSession(relay, id) {
  const storage = relay.ctx.storage;
  try {
    const rows = await storage.list({ prefix: `trow:${id}:` });
    const keys = [...rows.keys()];
    for (let i = 0; i < keys.length; i += 100) await storage.delete(keys.slice(i, i + 100));
    const meta = await storage.get(`tmeta:${id}`);
    await storage.delete(`tmeta:${id}`);
    if (meta?.tokenKey && (await storage.get(`tcur:${meta.tokenKey}`)) === id) {
      await storage.delete(`tcur:${meta.tokenKey}`);
    }
  } catch { /* best-effort cleanup */ }
  const st = state(relay);
  st.meta.delete(id);
}

// Record one tool call. Call it as the LAST thing in the tools/call path — it
// never throws into that path and never blocks it (storage writes are deferred).
export function recordTiming(relay, sessionId, name, startTs, endTs) {
  if (!sessionId) return;
  waitUntil(relay, writeRow(relay, sessionId, name, startTs, endTs));
}

async function writeRow(relay, sessionId, name, startTs, endTs) {
  const meta = await loadMeta(relay, sessionId);
  if (!meta) return;
  const gapMs = meta.lastReturnTs == null ? null : startTs - meta.lastReturnTs;
  meta.lastReturnTs = endTs;
  const seq = meta.seq++;
  const row = { t: endTs, name, gapMs, durMs: endTs - startTs };
  const storage = relay.ctx.storage;
  await storage.put({ [rowKey(sessionId, seq)]: row, [`tmeta:${sessionId}`]: meta });
  if (seq >= MAX_ROWS) await storage.delete(rowKey(sessionId, seq - MAX_ROWS));
}

// Read the trace back (served to the device-token-authed /trace endpoint).
//   no `session`  → { sessions: [...] } newest first
//   ?session=<id> → { session: meta, rows: [...] }  (`session=latest` = newest)
export async function readTrace(relay, url) {
  const storage = relay.ctx.storage;
  let idx = [];
  try { idx = (await storage.get('tidx')) || []; } catch { /* empty */ }
  // Newest first. The index is push-ordered, so a same-millisecond tie is broken
  // by position (later push = newer) — otherwise "latest" could pick the older one.
  idx = idx.map((s, i) => ({ ...s, i }))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || b.i - a.i);

  const want = url.searchParams.get('session');
  if (!want) {
    const sessions = [];
    for (const s of idx) {
      const meta = await loadMeta(relay, s.id);
      if (meta) sessions.push(publicMeta(meta));
    }
    return { sessions };
  }

  const id = want === 'latest' ? idx[0]?.id : want;
  const meta = id && SID_RE.test(id) ? await loadMeta(relay, id) : null;
  if (!meta) return { error: 'unknown_session' };
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '0', 10) || MAX_ROWS, 1), MAX_ROWS);
  const listed = await storage.list({ prefix: `trow:${meta.id}:` });
  const rows = [...listed.values()].slice(-limit);
  return { session: publicMeta(meta), rows };
}

const publicMeta = (m) => ({
  id: m.id,
  startedAt: m.startedAt,
  client: m.client,
  ua: m.ua,
  calls: m.seq,
});

const str = (v) => (typeof v === 'string' && v ? v.slice(0, 200) : '');

// Defer work past the response without ever throwing into the call path.
function waitUntil(relay, promise) {
  const p = promise.catch(() => {});
  try { relay.ctx.waitUntil(p); } catch { /* no waitUntil here — the promise still runs */ }
}
