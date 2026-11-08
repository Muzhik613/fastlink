// Agent tokens (/agent/pair + Bearer fla_ on /mcp), fast_feedback, /admin/feedback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1, makeRelay, mcpCall, fakeSocket } from './helpers.mjs';
import { makeDefaultHandler } from '../src/auth.js';
import { sha256Hex, revokeAgent } from '../src/db.js';

const worker = (await import('../src/index.js')).default;

function env(db, extra = {}) {
  const seen = [];
  return {
    seen,
    DB: db,
    IDENTITY_MODE: 'shared',
    SHARED_USER_ID: 'owner',
    OAUTH_KV: { async get() { return null; }, async put() {}, async delete() {}, async list() { return { keys: [] }; } },
    USER_RELAY: {
      idFromName: (n) => `id:${n}`,
      get: (id) => ({ fetch: async (req) => { seen.push({ id, path: new URL(req.url).pathname, user: req.headers.get('X-Fastlink-User-Id') }); return new Response('{"ok":1}'); } }),
    },
    ...extra,
  };
}

function seedCode(db, code = 'ABCDEFGH', userId = 'owner') {
  db.raw.prepare(`INSERT OR IGNORE INTO users (user_id, email, created_at) VALUES (?, ?, ?)`).run(userId, 'owner@example.com', Date.now());
  db.raw.prepare(`INSERT INTO pairing_codes (code, user_id, expires_at) VALUES (?, ?, ?)`).run(code, userId, Date.now() + 600_000);
}

const pair = (e, body, ip = '') => makeDefaultHandler().fetch(new Request('https://relay.test/agent/pair', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(ip ? { 'CF-Connecting-IP': ip } : {}) }, body: JSON.stringify(body),
}), e, {});

const mcp = (e, token, path = '/mcp') => worker.fetch(new Request(`https://relay.test${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
}), e, { waitUntil() {}, passThroughOnException() {} });

test('/agent/pair claims a code once and stores only the token hash', async () => {
  const db = fakeD1(); seedCode(db, 'ABCDEFGH');
  const e = env(db);
  const res = await pair(e, { code: 'abcd-efgh', name: 'yjt-laptop' });
  assert.equal(res.status, 200);
  const { agentToken } = await res.json();
  assert.match(agentToken, /^fla_[A-Za-z0-9_-]{43,}$/);
  const row = db.raw.prepare('SELECT * FROM agents').get();
  assert.equal(row.token_hash, await sha256Hex(agentToken));
  assert.equal(row.user_id, 'owner');
  assert.equal(row.label, 'yjt-laptop');
  assert.equal(JSON.stringify(db.raw.prepare('SELECT * FROM agents').all()).includes(agentToken), false);
  const again = await pair(e, { code: 'ABCDEFGH', name: 'x' });
  assert.equal(again.status, 400);
});

test('/agent/pair shares the /pair/claim rate-limit bucket', async () => {
  const db = fakeD1();
  const e = env(db);
  db.raw.prepare(`INSERT INTO rate_limits (bucket, count, window_start, expires_at) VALUES (?, ?, ?, ?)`).run('claim:ip:9.9.9.9', 30, Date.now(), Date.now() + 3600e3);
  const res = await pair(e, { code: 'ZZZZZZZZ' }, '9.9.9.9');
  assert.equal(res.status, 429);
});

test('Bearer fla_ reaches the user\'s DO on /mcp; unknown or revoked → 401', async () => {
  const db = fakeD1(); seedCode(db);
  const e = env(db);
  const { agentToken } = await (await pair(e, { code: 'ABCDEFGH' })).json();
  const ok = await mcp(e, agentToken);
  assert.equal(ok.status, 200);
  assert.deepEqual(e.seen.at(-1), { id: 'id:owner', path: '/__mcp', user: 'owner' });
  assert.ok(db.raw.prepare('SELECT last_seen FROM agents').get().last_seen > 0);

  assert.equal((await mcp(e, 'fla_notarealtoken')).status, 401);
  await revokeAgent(db, agentToken);
  const n = e.seen.length;
  assert.equal((await mcp(e, agentToken)).status, 401);
  assert.equal(e.seen.length, n);
});

test('an fla_ token opens nothing but /mcp', async () => {
  const db = fakeD1(); seedCode(db);
  const e = env(db, { RELAY_ADMIN_TOKEN: 'admin-secret-xyz' });
  const { agentToken } = await (await pair(e, { code: 'ABCDEFGH' })).json();
  const h = makeDefaultHandler();
  const get = (p, auth) => h.fetch(new Request(`https://relay.test${p}`, { headers: auth ? { authorization: `Bearer ${auth}` } : {} }), e, {});
  assert.equal((await get('/admin/feedback', agentToken)).status, 401);
  assert.equal((await get(`/devices?deviceToken=${agentToken}`)).status, 401);
  assert.equal((await get(`/trace?deviceToken=${agentToken}`)).status, 401);
  assert.equal(e.seen.length, 0);
});

test('fast_feedback inserts a row (no browser needed) with email, browser, client', async () => {
  const db = fakeD1();
  // 'work' is the only browser online, so an unnamed note is about it
  const { r } = await makeRelay({ db, userId: 'owner', devices: [{ name: 'work', token: 'tokA' }], sockets: [fakeSocket('tokA')] });
  let { data } = await mcpCall(r, 'fast_feedback', { text: 'snapshot misses the dialog', kind: 'bug' }, { 'user-agent': 'ua-test/1' });
  assert.equal(data.ok, true);
  let row = db.raw.prepare('SELECT * FROM feedback WHERE id = ?').get(data.id);
  assert.equal(row.user_id, 'owner'); assert.equal(row.email, 'me@example.com');
  assert.equal(row.browser, 'work'); assert.equal(row.kind, 'bug'); assert.equal(row.client, 'ua-test/1');

  ({ data } = await mcpCall(r, 'fast_feedback', { text: 'idea', browser: 'Home' }));
  row = db.raw.prepare('SELECT * FROM feedback WHERE id = ?').get(data.id);
  assert.equal(row.browser, 'home'); assert.equal(row.kind, 'other');

  ({ data } = await mcpCall(r, 'fast_feedback', { text: 'x'.repeat(4001) }));
  assert.match(data.error, /4000/);
  ({ data } = await mcpCall(r, 'fast_feedback', { text: 'x', kind: 'rant' }));
  assert.match(data.error, /kind/);
});

test('fast_feedback client comes from the initialize clientInfo when known', async () => {
  const db = fakeD1();
  const { r } = await makeRelay({ db, userId: 'owner' });
  const { handleMcpRequest } = await import('../src/mcp.js');
  const init = await handleMcpRequest(new Request('https://relay.test/__mcp', {
    method: 'POST', headers: { authorization: 'Bearer t1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'fastlink-helper@box', version: '1.2' } } }),
  }), r);
  const sid = init.headers.get('mcp-session-id');
  const { data } = await mcpCall(r, 'fast_feedback', { text: 'hi' }, { authorization: 'Bearer t1', 'mcp-session-id': sid });
  assert.equal(db.raw.prepare('SELECT client FROM feedback WHERE id = ?').get(data.id).client, 'fastlink-helper@box/1.2');
});

test('/admin/feedback: 404 without the secret, 401 on a wrong bearer, pages by after/limit', async () => {
  const db = fakeD1();
  db.raw.prepare(`INSERT INTO users (user_id, created_at) VALUES ('u', 0)`).run();
  for (let i = 0; i < 5; i++) db.raw.prepare(`INSERT INTO feedback (user_id, text, ts) VALUES ('u', ?, ?)`).run(`n${i}`, i);
  const h = makeDefaultHandler();
  const get = (e, q, auth) => h.fetch(new Request(`https://relay.test/admin/feedback${q}`, { headers: auth ? { authorization: `Bearer ${auth}` } : {} }), e, {});
  assert.equal((await get(env(db), '', 'anything')).status, 404);
  const e = env(db, { RELAY_ADMIN_TOKEN: 'admin-secret-xyz' });
  assert.equal((await get(e, '', 'wrong')).status, 401);
  assert.equal((await get(e, '')).status, 401);
  const page = await (await get(e, '?after=1&limit=2', 'admin-secret-xyz')).json();
  assert.deepEqual(page.items.map((x) => x.text), ['n1', 'n2']);
  assert.equal(page.last, 3);
  const empty = await (await get(e, '?after=99', 'admin-secret-xyz')).json();
  assert.deepEqual(empty, { items: [], last: 99 });
  const post = await h.fetch(new Request('https://relay.test/admin/feedback', { method: 'POST', headers: { authorization: 'Bearer admin-secret-xyz' } }), e, {});
  assert.equal(post.status, 405);
});

const machines = (e, token, method = 'GET', body) => makeDefaultHandler().fetch(new Request('https://relay.test/agent/machines', {
  method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
}), e, {});

test('/agent/machines: a machine lists its owner\'s machines and revokes one by id; never another user\'s', async () => {
  const db = fakeD1(); const e = env(db);
  seedCode(db, 'AAAAAAAA'); seedCode(db, 'BBBBBBBB'); seedCode(db, 'CCCCCCCC', 'other');
  const t1 = (await (await pair(e, { code: 'AAAAAAAA', name: 'laptop' }, '1.1.1.1')).json()).agentToken;
  const t2 = (await (await pair(e, { code: 'BBBBBBBB', name: 'hvm' }, '1.1.1.2')).json()).agentToken;
  const t3 = (await (await pair(e, { code: 'CCCCCCCC', name: 'theirs' }, '1.1.1.3')).json()).agentToken;
  assert.equal((await machines(e, null)).status, 401);
  const list = (await (await machines(e, t1)).json()).machines;
  assert.deepEqual(list.map((m) => [m.name, m.self]), [['laptop', true], ['hvm', false]]);
  assert.ok(list.every((m) => /^[0-9a-f]{12}$/.test(m.id)));
  // another user's machine id is not found
  const theirs = (await (await machines(e, t3)).json()).machines[0].id;
  assert.equal((await machines(e, t1, 'POST', { revoke: theirs })).status, 404);
  // revoke hvm from laptop → hvm's token stops working
  const hvm = list.find((m) => m.name === 'hvm').id;
  assert.deepEqual(await (await machines(e, t1, 'POST', { revoke: hvm })).json(), { ok: true, revoked: hvm });
  assert.equal((await machines(e, t2)).status, 401);
  assert.equal((await mcp(e, t2)).status, 401);
  // unpair = revoke self
  assert.deepEqual(await (await machines(e, t1, 'POST', { revoke: 'self' })).json(), { ok: true });
  assert.equal((await machines(e, t1)).status, 401);
  assert.equal((await machines(e, t3)).status, 200);
});

test('/admin/extension-ids: admin-only list of extra ids for one-click sign-in', async () => {
  const db = fakeD1();
  const e = env(db, { RELAY_ADMIN_TOKEN: 'adm', EXTENSION_ID: 'ockcjadbkdfgfllidpcoamcepahfmlpf' });
  const call = (method, body, tok = 'adm') => makeDefaultHandler().fetch(new Request('https://relay.test/admin/extension-ids', {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), e, {});
  assert.equal((await call('GET', null, 'wrong')).status, 401);
  assert.equal((await call('POST', { add: 'not-an-id' })).status, 400);
  const r = await (await call('POST', { add: 'abcdefghijklmnopabcdefghijklmnop' })).json();
  assert.deepEqual(r.ids, ['ockcjadbkdfgfllidpcoamcepahfmlpf', 'abcdefghijklmnopabcdefghijklmnop']);
  const r2 = await (await call('POST', { remove: 'abcdefghijklmnopabcdefghijklmnop' })).json();
  assert.deepEqual(r2.ids, ['ockcjadbkdfgfllidpcoamcepahfmlpf']);
});

test('pruneOld: drops activity-log rows older than 30 days and expired pairing codes', async () => {
  const { pruneOld } = await import('../src/db.js');
  const db = fakeD1();
  db.raw.prepare(`INSERT INTO users (user_id, email, created_at) VALUES ('u', 'u@x', 1)`).run();
  const day = 86400_000, now = Date.now();
  db.raw.prepare(`INSERT INTO grants_audit (user_id, ts, action, detail) VALUES ('u', ?, 'old', '{}'), ('u', ?, 'new', '{}')`).run(now - 31 * day, now - 29 * day);
  db.raw.prepare(`INSERT INTO pairing_codes (code, user_id, expires_at) VALUES ('OLD', 'u', ?), ('NEW', 'u', ?)`).run(now - 2 * day, now + 600_000);
  assert.deepEqual(await pruneOld(db), { audit: 1, pairingCodes: 1 });
  assert.deepEqual(db.raw.prepare(`SELECT action FROM grants_audit`).all().map((r) => r.action), ['new']);
});
