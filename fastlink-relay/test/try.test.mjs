// /try: fixed actions through the real MCP path (gates apply), and the /try routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1, makeRelay, fakeSocket, mcpCall, reply, tick } from './helpers.mjs';
import { runTryAction } from '../src/try.js';
import { makeDefaultHandler } from '../src/auth.js';

const SNAP = {
  url: 'https://x.test/', title: 'X page',
  count: 3,
  items: [
    { i: 1, tag: 'button', label: 'Menu' },
    { i: 2, tag: 'a', label: '' },
    { i: 3, tag: 'a', label: 'More information' },
  ],
  content: [{ text: 'Hello   world' }, { text: 'second block' }],
};

// callTool over the real handler; the fake extension answers each call from `answers`.
function liveCallTool(r, ws, answers) {
  return async (name, args) => {
    const before = ws.sent.length;
    const p = mcpCall(r, name, args);
    for (let i = 0; i < 200 && ws.sent.length === before; i++) {
      if (await Promise.race([p.then(() => true), tick().then(() => false)])) break;
    }
    if (ws.sent.length > before) {
      const call = ws.lastCall();
      await reply(r, ws, call.id, { result: answers[call.action], origin: 'https://x.test', tabId: 5 });
    }
    const { data } = await p;
    return typeof data === 'string' ? { error: data } : data;
  };
}

async function oneBrowser(extra = {}) {
  const ws = fakeSocket('tokA');
  const { r } = await makeRelay({ devices: [{ name: 'work', token: 'tokA' }], sockets: [ws], ...extra });
  return { r, ws };
}

test('read: one fast_snapshot, summarized (title, url, clipped text, labelled controls)', async () => {
  const { r, ws } = await oneBrowser();
  const out = await runTryAction(liveCallTool(r, ws, { fast_snapshot: SNAP }), 'read', { browser: 'work' });
  assert.deepEqual(ws.sent.filter((m) => m.type === 'call').map((m) => m.action), ['fast_snapshot']);
  assert.equal(out.title, 'X page');
  assert.equal(out.url, 'https://x.test/');
  assert.equal(out.text, 'Hello world second block');
  assert.equal(out.controls, 3);
  assert.deepEqual(out.items, [{ tag: 'button', label: 'Menu' }, { tag: 'a', label: 'More information' }]);
});

test('click: snapshot, then fast_click on the first LABELLED link by id', async () => {
  const { r, ws } = await oneBrowser();
  const out = await runTryAction(liveCallTool(r, ws, {
    fast_snapshot: SNAP,
    fast_click: { url: 'https://x.test/more', urlChanged: true },
  }), 'click');
  const calls = ws.sent.filter((m) => m.type === 'call');
  assert.deepEqual(calls.map((m) => m.action), ['fast_snapshot', 'fast_click']);
  assert.equal(calls[1].args.id, '3');
  assert.deepEqual(out, { clicked: 'More information', from: 'https://x.test/', url: 'https://x.test/more', urlChanged: true });
});

test('tabs: the browser\'s web tabs, minus the relay\'s own pages and non-web tabs', async () => {
  const { r, ws } = await oneBrowser();
  const out = await runTryAction(liveCallTool(r, ws, { fast_list: [
    { id: 1, url: 'https://relay.test/try', title: 'Try FastLink' },
    { id: 2, url: 'chrome://extensions/', title: 'Extensions' },
    { id: 3, url: 'https://example.com/', title: 'Example Domain' },
  ] }), 'tabs', { relayOrigin: 'https://relay.test' });
  assert.deepEqual(out, { tabs: [{ tabId: 3, title: 'Example Domain', url: 'https://example.com/' }] });
});

test('read/click act on the chosen tab (tabId reaches every call)', async () => {
  const { r, ws } = await oneBrowser();
  await runTryAction(liveCallTool(r, ws, { fast_snapshot: SNAP, fast_click: { url: 'u' } }), 'click', { tabId: 3 });
  const calls = ws.sent.filter((m) => m.type === 'call');
  assert.deepEqual(calls.map((m) => [m.action, m.args.tabId]), [['fast_snapshot', 3], ['fast_click', 3]]);
});

test('click with no link on the page: an error, and nothing is clicked', async () => {
  const { r, ws } = await oneBrowser();
  const out = await runTryAction(liveCallTool(r, ws, { fast_snapshot: { ...SNAP, items: [SNAP.items[0]] } }), 'click');
  assert.match(out.error, /no link/);
  assert.deepEqual(ws.sent.filter((m) => m.type === 'call').map((m) => m.action), ['fast_snapshot']);
});

test('Stop driving applies: a paused account sends nothing to the browser', async () => {
  const { r, ws } = await oneBrowser();
  await r.setDrivingPaused(true);
  const out = await runTryAction(liveCallTool(r, ws, { fast_snapshot: SNAP }), 'read');
  assert.match(out.error, /paused/i);
  assert.equal(ws.sent.filter((m) => m.type === 'call').length, 0);
  const st = await runTryAction(liveCallTool(r, ws, {}), 'status');
  assert.equal(st.paused, true);
});

test('per-site rules apply: a read-only site can be read but the click is refused', async () => {
  const db = fakeD1();
  const { r, ws } = await oneBrowser({ db });
  db.raw.prepare(`INSERT INTO site_consent (user_id, origin, mode, updated_at) VALUES (?, ?, ?, ?)`).run('u1', 'https://x.test', 'readonly', Date.now());
  const out = await runTryAction(liveCallTool(r, ws, { fast_snapshot: SNAP, fast_click: { url: 'x' } }), 'click');
  assert.match(out.error, /read-only/);
  assert.deepEqual(ws.sent.filter((m) => m.type === 'call').map((m) => m.action), ['fast_snapshot']);
});

test('status lists the account\'s browsers; unknown actions are refused', async () => {
  const { r, ws } = await oneBrowser();
  const st = await runTryAction(liveCallTool(r, ws, {}), 'status');
  assert.deepEqual(st, { browsers: [{ name: 'work', connected: true }], paused: false });
  assert.deepEqual(await runTryAction(async () => assert.fail('no call'), 'fast_type'), { error: 'Unknown action.' });
});

// ---- routes ---------------------------------------------------------------

const SECRET = 'test-cookie-secret-0123456789';
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sign(obj, secret = SECRET) {
  const data = b64u(JSON.stringify(obj));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return data + '.' + b64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}
const session = (uid = 'g-123', ms = 60_000) => sign({ p: 'try', uid, exp: Date.now() + ms });

function env(extra = {}) {
  const seen = [];
  const db = fakeD1();
  db.raw.prepare(`INSERT INTO users (user_id, email, created_at) VALUES (?, ?, ?)`).run('g-123', 'me@example.com', Date.now());
  return {
    seen,
    DB: db,
    IDENTITY_MODE: 'google',
    COOKIE_SECRET: SECRET,
    UPSTREAM_OAUTH_CLIENT_ID: 'cid',
    RELAY_BASE: 'https://relay.test',
    USER_RELAY: {
      idFromName: (n) => `id:${n}`,
      get: (id) => ({
        fetch: async (req) => {
          const rpc = await req.json();
          seen.push({ id, path: new URL(req.url).pathname, user: req.headers.get('X-Fastlink-User-Id'), caller: req.headers.get('X-Fastlink-Caller'), rpc });
          const text = JSON.stringify({ browsers: [{ name: 'work', connected: true }], drivingPaused: false });
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text }] } }));
        },
      }),
    },
    ...extra,
  };
}
const h = makeDefaultHandler();
const get = (e, cookie) => h.fetch(new Request('https://relay.test/try', { headers: cookie ? { cookie: `fl_try=${cookie}` } : {} }), e, {});
const run = (e, body, { cookie, header = true, origin } = {}) => h.fetch(new Request('https://relay.test/try/run', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(header ? { 'x-fastlink-try': '1' } : {}),
    ...(cookie ? { cookie: `fl_try=${cookie}` } : {}),
    ...(origin ? { origin } : {}),
  },
  body: JSON.stringify(body),
}), e, {});

test('GET /try without a session sends the human to Google sign-in (intent try)', async () => {
  const res = await get(env());
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.host, 'accounts.google.com');
  assert.ok(loc.searchParams.get('state'));
});

test('GET /try with a session shows the page for that account', async () => {
  const res = await get(env(), await session());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Signed in as <b>me@example.com<\/b>/);
  assert.match(html, /Read this tab/);
});

test('shared mode has no per-person identity: /try is not offered', async () => {
  const res = await get(env({ IDENTITY_MODE: 'shared', SHARED_USER_ID: 'owner' }));
  assert.equal(res.status, 404);
});

test('/try/run: forwards a tools/call to THIS user\'s DO, marked as the try page', async () => {
  const e = env();
  const res = await run(e, { action: 'status' }, { cookie: await session() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await res.json(), { browsers: [{ name: 'work', connected: true }], paused: false });
  assert.equal(e.seen.length, 1);
  assert.deepEqual(
    { id: e.seen[0].id, path: e.seen[0].path, user: e.seen[0].user, caller: e.seen[0].caller, method: e.seen[0].rpc.method, tool: e.seen[0].rpc.params.name },
    { id: 'id:g-123', path: '/__mcp', user: 'g-123', caller: 'try', method: 'tools/call', tool: 'fast_status' },
  );
});

test('/try/run refuses: no header, another origin, no/forged/expired session, bad input', async () => {
  const e = env();
  const ok = await session();
  assert.equal((await run(e, { action: 'status' }, { cookie: ok, header: false })).status, 403);
  assert.equal((await run(e, { action: 'status' }, { cookie: ok, origin: 'https://evil.test' })).status, 403);
  assert.equal((await run(e, { action: 'status' })).status, 401);
  assert.equal((await run(e, { action: 'status' }, { cookie: await sign({ p: 'try', uid: 'g-123', exp: Date.now() + 60_000 }, 'wrong-secret') })).status, 401);
  assert.equal((await run(e, { action: 'status' }, { cookie: await session('g-123', -1) })).status, 401);
  assert.equal((await run(e, { action: 'status' }, { cookie: await sign({ p: 'pair', uid: 'g-123', exp: Date.now() + 60_000 }) })).status, 401);
  assert.equal((await run(e, { action: 'fast_type' }, { cookie: ok })).status, 400);
  assert.equal((await run(e, { action: 'read', browser: 'Bad Name!' }, { cookie: ok })).status, 400);
  assert.equal((await run(e, { action: 'read', tabId: 'x' }, { cookie: ok })).status, 400);
  assert.equal((await run(e, { action: 'read', tabId: -1 }, { cookie: ok })).status, 400);
  assert.equal(e.seen.length, 0);
});

test('/try/run is rate limited per user (status/tab checks are free)', async () => {
  const e = env();
  const ok = await session();
  e.DB.raw.prepare(`INSERT INTO rate_limits (bucket, count, window_start, expires_at) VALUES (?, ?, ?, ?)`).run('try:user:g-123', 60, Date.now(), Date.now() + 3_600_000);
  assert.equal((await run(e, { action: 'read' }, { cookie: ok })).status, 429);
  assert.equal((await run(e, { action: 'status' }, { cookie: ok })).status, 200);
});
