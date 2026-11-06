// Shared fakes for the relay tests: a D1 shim over node:sqlite (real migrations),
// fake hibernatable sockets, and a UserRelay wired to them.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

globalThis.WebSocketRequestResponsePair ??= class { constructor(a, b) { this.a = a; this.b = b; } };
const { UserRelay } = await import('../src/userRelay.js');

const MIGRATIONS = new URL('../migrations/', import.meta.url);

// Minimal D1 binding: prepare(sql).bind(...).run()/first()/all().
export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    async run() {
      const r = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { success: true, results: db.prepare(sql).all(...params) }; },
  });
  return { prepare: (sql) => stmt(sql), raw: db };
}

export function fakeStorage() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.get(k); },
    async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); },
    async delete(k) { for (const x of [].concat(k)) m.delete(x); },
    async list({ prefix }) { return new Map([...m].filter(([k]) => k.startsWith(prefix))); },
  };
}

// A hibernatable ext socket stamped with a device token; records what the relay sends.
export function fakeSocket(deviceToken, connectedAt = Date.now()) {
  let att = { connectedAt, deviceToken };
  return {
    readyState: 1,
    sent: [],
    send(s) { this.sent.push(JSON.parse(s)); },
    close() { this.readyState = 3; },
    serializeAttachment(v) { att = v; },
    deserializeAttachment() { return att; },
    lastCall() { return this.sent.filter((m) => m.type === 'call').at(-1); },
  };
}

// UserRelay with fake storage/sockets. `devices` = [{name, token}]; DB rows are
// seeded when `db` is given, else the device cache is primed directly.
export async function makeRelay({ devices = [], sockets = [], db = null, userId = 'u1', env = {} } = {}) {
  const storage = fakeStorage();
  const ctx = {
    storage,
    getWebSockets: () => sockets,
    setWebSocketAutoResponse() {},
    acceptWebSocket() {},
    waitUntil() {},
  };
  const r = new UserRelay(ctx, { ...(db ? { DB: db } : {}), IDENTITY_MODE: 'shared', ...env });
  r.userId = userId;
  if (db) {
    db.raw.prepare(`INSERT OR IGNORE INTO users (user_id, email, created_at) VALUES (?, ?, ?)`).run(userId, 'me@example.com', Date.now());
    for (const d of devices) {
      db.raw.prepare(`INSERT INTO devices (device_token, user_id, label, created_at) VALUES (?, ?, ?, ?)`).run(d.token, userId, d.name, Date.now());
    }
  } else {
    r._devices = { at: Date.now() + 1e9, rows: devices.map((d) => ({ name: d.name, deviceToken: d.token, lastSeen: null })) };
  }
  return { r, storage, ctx };
}

// Answer the most recent call on `ws` with a result frame, delivered on `via`.
export async function reply(r, via, id, body) {
  await r.webSocketMessage(via, JSON.stringify({ type: 'result', id, ...body }));
}

// MCP tools/call through the real handler.
export async function mcpCall(r, name, args = {}, headers = {}) {
  const { handleMcpRequest } = await import('../src/mcp.js');
  const req = new Request('https://relay.test/__mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await handleMcpRequest(req, r);
  const body = await res.json();
  const text = body.result?.content?.[0]?.text;
  return { body, data: text && !text.startsWith('Error') ? JSON.parse(text) : text };
}

export const tick = () => new Promise((res) => setImmediate(res));
