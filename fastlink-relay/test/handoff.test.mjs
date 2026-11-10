// Human hand-off: fast_handoff makes a one-device, expiring link; the phone page sees only the
// challenge crop; taps map into that crop on the bound tab; Done ends the link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSocket, makeRelay, mcpCall, reply, tick } from './helpers.mjs';
import { handleHandoffRoute } from '../src/handoff.js';

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const CROP = { x: 10, y: 20, w: 100, h: 50 };

function fakeKV() {
  const m = new Map();
  return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } };
}

// A browser that answers every call: handoff_frame/handoff_tap/fast_list, or `override(call)`.
function autoAnswer(r, ws, override = () => null) {
  const seen = new Set();
  const calls = [];
  let on = true;
  (async () => {
    while (on) {
      for (const c of ws.sent.filter((m) => m.type === 'call' && !seen.has(m.id))) {
        seen.add(c.id); calls.push(c);
        const o = override(c);
        const body = o || (c.action === 'handoff_frame' ? { result: { tabId: 7, found: true, crop: CROP, dataUrl: JPEG }, tabId: 7, origin: 'https://demo.test' }
          : c.action === 'handoff_tap' ? { result: { tabId: 7, clickedAt: { x: c.args.x, y: c.args.y } }, tabId: 7, origin: 'https://demo.test' }
          : c.action === 'fast_list' ? { result: [{ id: 7, url: 'https://demo.test/page', active: true, targetTab: true }] }
          : { error: 'unexpected ' + c.action });
        await reply(r, ws, c.id, body);
      }
      await tick();
    }
  })();
  return { calls, stop() { on = false; } };
}

async function setup(override) {
  const ws = fakeSocket('tokB', Date.now(), '0.4.16');
  const kv = fakeKV();
  const { r, storage } = await makeRelay({ devices: [{ name: 'b', token: 'tokB' }], sockets: [ws], env: { OAUTH_KV: kv, RELAY_BASE: 'https://relay.test' } });
  const env = { OAUTH_KV: kv, USER_RELAY: { idFromName: (n) => n, get: () => ({ fetch: (req) => r.fetch(req) }) } };
  const bot = autoAnswer(r, ws, override);
  return { r, ws, kv, env, storage, bot };
}
const phone = (env, url, op = '', { method = 'GET', body, cookie } = {}) =>
  handleHandoffRoute(new Request(url + (op ? '/' + op : ''), { method, headers: cookie ? { cookie } : {}, body }), env);

test('fast_handoff returns a link; the first device to poll owns it; it sees only the crop; taps map into it; Done ends it', async () => {
  const { r, env, kv, bot } = await setup();
  const { data } = await mcpCall(r, 'fast_handoff', { browser: 'b', tabId: 7, minutes: 99 });
  assert.match(data.url, /^https:\/\/relay\.test\/h\/[A-Za-z0-9_-]{43}$/);
  assert.equal(data.tabId, 7);
  assert.equal(data.found, true);
  assert.ok(Date.parse(data.expiresAt) - Date.now() <= 30 * 60000 + 1000, 'capped at 30 minutes');
  assert.ok(![...kv.m.keys()].some((k) => k.includes(data.url.split('/h/')[1])), 'the token itself is never stored');

  const pg = await phone(env, data.url);
  assert.equal(pg.status, 200);
  assert.match(pg.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  const s1 = await phone(env, data.url, 'state');
  const cookie = s1.headers.get('set-cookie').split(';')[0];
  const st = await s1.json();
  assert.equal(st.status, 'pending'); assert.equal(st.live, true); assert.equal(st.seq, 1);

  const other = await phone(env, data.url, 'state');
  assert.equal(other.status, 403, 'a second device is refused');
  assert.equal((await other.json()).status, 'elsewhere');

  const fr = await phone(env, data.url, 'frame', { cookie });
  assert.equal(fr.headers.get('content-type'), 'image/jpeg');

  const tap = await phone(env, data.url, 'tap', { method: 'POST', cookie, body: JSON.stringify({ fx: 0.5, fy: 0.5, seq: 1 }) });
  assert.deepEqual(await tap.json(), { ok: true });
  const t = bot.calls.find((c) => c.action === 'handoff_tap');
  assert.deepEqual([t.args.tabId, t.args.x, t.args.y, t.args.expectOrigin], [7, 60, 45, 'https://demo.test']);

  const out = await phone(env, data.url, 'tap', { method: 'POST', cookie, body: JSON.stringify({ fx: 1.4, fy: 0.5, seq: 1 }) });
  assert.equal(out.status, 400, 'a tap outside the crop is refused');

  const w1 = (await mcpCall(r, 'fast_handoff_wait', { handoffId: data.handoffId, waitSec: 0 })).data;
  assert.deepEqual([w1.status, w1.taps], ['pending', 1]);

  const done = await phone(env, data.url, 'done', { method: 'POST', cookie, body: '{}' });
  assert.equal((await done.json()).status, 'done');
  assert.equal((await mcpCall(r, 'fast_handoff_wait', { handoffId: data.handoffId, waitSec: 5 })).data.status, 'done');
  assert.equal((await phone(env, data.url)).status, 404, 'an ended link is gone');
  bot.stop();
});

test('an expired hand-off reports expired and its link stops working', async () => {
  const { r, env, storage, bot } = await setup();
  const { data } = await mcpCall(r, 'fast_handoff', { browser: 'b', tabId: 7, minutes: 1 });
  const k = 'handoff:' + data.handoffId;
  storage.m.set(k, { ...storage.m.get(k), exp: Date.now() - 1 });
  assert.equal((await mcpCall(r, 'fast_handoff_wait', { handoffId: data.handoffId, waitSec: 0 })).data.status, 'expired');
  assert.equal((await phone(env, data.url)).status, 404);
  bot.stop();
});

test('a browser without hand-off support gets a clear update message and no link', async () => {
  const { r, bot } = await setup((c) => (c.action === 'handoff_frame' ? { error: 'Unknown action: handoff_frame' } : null));
  const { data } = await mcpCall(r, 'fast_handoff', { browser: 'b', tabId: 7 });
  assert.match(data.error, /needs 0\.4\.16/);
  assert.equal(data.url, undefined);
  bot.stop();
});

test('a bad or unknown token is a plain 404', async () => {
  const { env, bot } = await setup();
  for (const u of ['https://relay.test/h/short', 'https://relay.test/h/' + 'A'.repeat(43), 'https://relay.test/h/' + 'A'.repeat(43) + '/state']) {
    assert.equal((await phone(env, u)).status, 404, u);
  }
  bot.stop();
});

test('a snapshot that shows a captcha frame tells the agent to hand it off; a plain one does not', async () => {
  const frames = [{ frame: 'https://www.google.com', title: 'reCAPTCHA', box: CROP }];
  const { r, bot } = await setup((c) => (c.action === 'fast_snapshot' ? { result: { url: 'https://demo.test/', frames: c.args.tabId === 7 ? frames : [], items: [] }, tabId: c.args.tabId, origin: 'https://demo.test' } : null));
  assert.match((await mcpCall(r, 'fast_snapshot', { browser: 'b', tabId: 7 })).data.captcha, /fast_handoff/);
  assert.equal((await mcpCall(r, 'fast_snapshot', { browser: 'b', tabId: 8 })).data.captcha, undefined);
  bot.stop();
});
