// Relay ⇄ extension wire: queued/started timers, result on another socket of the
// same device, close grace, per-device origin cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRelay, fakeSocket, reply } from './helpers.mjs';

const target = (r, name, token) => ({ ws: r.ctx.getWebSockets().find((s) => s.deserializeAttachment().deviceToken === token && s.readyState === 1), name, deviceToken: token });

// Settled-or-not probe for a promise.
const state = async (p) => Promise.race([p.then((v) => ({ done: true, v })), new Promise((res) => setImmediate(() => res({ done: false })))]);

test('timers: 30 s with no frames (old extension)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const a = fakeSocket('tokA');
  const { r } = await makeRelay({ devices: [{ name: 'w', token: 'tokA' }], sockets: [a] });
  const p = r.callExtension('fast_text', {}, undefined, target(r, 'w', 'tokA'));
  t.mock.timers.tick(29_999);
  assert.equal((await state(p)).done, false);
  t.mock.timers.tick(1);
  assert.match((await p).error, /Timeout/);
});

test('timers: queued extends to 120 s from send; started resets to 30 s from then', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const a = fakeSocket('tokA');
  const { r } = await makeRelay({ devices: [{ name: 'w', token: 'tokA' }], sockets: [a] });
  const p = r.callExtension('fast_text', {}, undefined, target(r, 'w', 'tokA'));
  const id = a.lastCall().id;
  t.mock.timers.tick(10_000);
  await r.webSocketMessage(a, JSON.stringify({ type: 'queued', id, position: 1 }));
  t.mock.timers.tick(100_000); // 110 s after send: still queued, still alive
  assert.equal((await state(p)).done, false);
  await r.webSocketMessage(a, JSON.stringify({ type: 'started', id }));
  t.mock.timers.tick(29_000); // 139 s after send, 29 s after start
  assert.equal((await state(p)).done, false);
  t.mock.timers.tick(1_000);
  assert.match((await p).error, /Timeout/);
});

test('timers: queued alone times out at 120 s after send', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const a = fakeSocket('tokA');
  const { r } = await makeRelay({ devices: [{ name: 'w', token: 'tokA' }], sockets: [a] });
  const p = r.callExtension('fast_text', {}, undefined, target(r, 'w', 'tokA'));
  await r.webSocketMessage(a, JSON.stringify({ type: 'queued', id: a.lastCall().id, position: 2 }));
  t.mock.timers.tick(119_999);
  assert.equal((await state(p)).done, false);
  t.mock.timers.tick(1);
  assert.match((await p).error, /Timeout/);
});

test('result arriving on a different socket of the same device is accepted', async () => {
  const a1 = fakeSocket('tokA', 1); const a2 = fakeSocket('tokA', 2);
  const { r } = await makeRelay({ devices: [{ name: 'w', token: 'tokA' }], sockets: [a1, a2] });
  const p = r.callExtension('fast_text', {}, undefined, { ws: a1, name: 'w', deviceToken: 'tokA' });
  await reply(r, a2, a1.lastCall().id, { result: 'hello', tabId: 3 });
  assert.deepEqual(await p, { result: 'hello', tabId: 3 });
});

test('a result from another browser cannot settle the call', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const a = fakeSocket('tokA'); const b = fakeSocket('tokB');
  const { r } = await makeRelay({ devices: [{ name: 'w', token: 'tokA' }, { name: 'h', token: 'tokB' }], sockets: [a, b] });
  const p = r.callExtension('fast_text', {}, undefined, target(r, 'w', 'tokA'));
  await reply(r, b, a.lastCall().id, { result: 'spoof' });
  assert.equal((await state(p)).done, false);
  await reply(r, a, a.lastCall().id, { result: 'real' });
  assert.equal((await p).result, 'real');
});

test('socket close: 10 s grace lets the redialed socket deliver, then fails', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const a1 = fakeSocket('tokA', 1);
  const sockets = [a1];
  const { r } = await makeRelay({ devices: [{ name: 'w', token: 'tokA' }], sockets });
  const tgt = { ws: a1, name: 'w', deviceToken: 'tokA' };

  // (1) delivered within grace on the new socket
  const p1 = r.callExtension('fast_text', {}, undefined, tgt);
  const id1 = a1.lastCall().id;
  a1.close(); await r.webSocketClose(a1);
  t.mock.timers.tick(9_000);
  assert.equal((await state(p1)).done, false);
  const a2 = fakeSocket('tokA', 2); sockets.push(a2);
  await reply(r, a2, id1, { result: 'late but fine' });
  assert.equal((await p1).result, 'late but fine');

  // (2) nothing arrives → fails after the grace
  const b1 = fakeSocket('tokA', 3); sockets.push(b1);
  const p2 = r.callExtension('fast_text', {}, undefined, { ...tgt, ws: b1 });
  b1.close(); await r.webSocketClose(b1);
  t.mock.timers.tick(9_999);
  assert.equal((await state(p2)).done, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await p2, { error: 'Extension disconnected before response' });
  assert.equal(r.pending.size, 0);
});

test('origin is cached per device: the target browser\'s origin drives consent/eval/audit', async () => {
  const a = fakeSocket('tokA'); const b = fakeSocket('tokB');
  const { r } = await makeRelay({ devices: [{ name: 'w', token: 'tokA' }, { name: 'h', token: 'tokB' }], sockets: [a, b] });
  const ta = target(r, 'w', 'tokA'); const tb = target(r, 'h', 'tokB');
  let p = r.callExtension('fast_text', {}, undefined, ta);
  await reply(r, a, a.lastCall().id, { result: 1, origin: 'https://a.test' });
  await p;
  p = r.callExtension('fast_text', {}, undefined, tb);
  await reply(r, b, b.lastCall().id, { result: 1, origin: 'https://b.test' });
  await p;
  assert.equal(r.cachedOrigin(ta), 'https://a.test');
  assert.equal(r.cachedOrigin(tb), 'https://b.test');
  assert.equal(await r.currentOrigin(ta), 'https://a.test');
  assert.equal(r.lastOrigin, undefined);

  // eval allowlist reads the TARGET browser's origin
  r.evalPolicy = async () => ({ allowEvaluate: true, allowAll: false, isOperator: false, origins: ['https://a.test'] });
  assert.equal((await r.checkEvalAllowed(ta)).ok, true);
  const vb = await r.checkEvalAllowed(tb);
  assert.equal(vb.ok, false);
  assert.match(vb.error, /b\.test/);
});

test('origin is cached per TAB: a call naming another tab is gated on that tab, not the last one seen', async () => {
  const a = fakeSocket('tokA');
  const { r } = await makeRelay({ devices: [{ name: 'w', token: 'tokA' }], sockets: [a] });
  const ta = target(r, 'w', 'tokA');
  let p = r.callExtension('fast_text', { tabId: 7 }, undefined, ta);
  await reply(r, a, a.lastCall().id, { result: 1, origin: 'https://allowed.test', tabId: 7 });
  await p;
  p = r.callExtension('fast_text', { tabId: 9 }, undefined, ta);
  await reply(r, a, a.lastCall().id, { result: 1, origin: 'https://other.test', tabId: 9 });
  await p;
  assert.equal(r.cachedOrigin(ta, 7), 'https://allowed.test');
  assert.equal(r.cachedOrigin(ta, 9), 'https://other.test');
  r.evalPolicy = async () => ({ allowEvaluate: true, allowAll: false, isOperator: false, origins: ['https://allowed.test'] });
  assert.equal((await r.checkEvalAllowed(ta, 7)).ok, true);
  const v9 = await r.checkEvalAllowed(ta, 9);
  assert.equal(v9.ok, false);
  assert.match(v9.error, /other\.test/);
});

test('eval on a tab whose site is unknown is denied (fail closed)', async () => {
  const a = fakeSocket('tokA');
  const { r } = await makeRelay({ devices: [{ name: 'w', token: 'tokA' }], sockets: [a] });
  const ta = target(r, 'w', 'tokA');
  r.evalPolicy = async () => ({ allowEvaluate: true, allowAll: false, isOperator: false, origins: ['https://allowed.test'] });
  const p = r.checkEvalAllowed(ta, 55);
  await new Promise((res) => setImmediate(res));
  // the probe (fast_list) does not list tab 55
  await reply(r, a, a.lastCall().id, { result: [{ id: 7, url: 'https://allowed.test/x', active: true }] });
  assert.equal((await p).ok, false);
});

test('writes carry expectOrigin = the origin the gates approved for that tab', async () => {
  const a = fakeSocket('tokA');
  const { r } = await makeRelay({ devices: [{ name: 'w', token: 'tokA' }], sockets: [a] });
  const { mcpCall } = await import('./helpers.mjs');
  const ta = target(r, 'w', 'tokA');
  let p = r.callExtension('fast_text', { tabId: 7 }, undefined, ta);
  await reply(r, a, a.lastCall().id, { result: 1, origin: 'https://site.test', tabId: 7 });
  await p;
  p = mcpCall(r, 'fast_click', { tabId: 7, text: 'Go' });
  for (let i = 0; i < 200 && a.lastCall().action !== 'fast_click'; i++) await new Promise((res) => setImmediate(res));
  assert.equal(a.lastCall().action, 'fast_click');
  assert.equal(a.lastCall().args.expectOrigin, 'https://site.test');
  await reply(r, a, a.lastCall().id, { result: { ok: true }, origin: 'https://site.test', tabId: 7 });
  await p;
});

test('a call naming a tab is refused for extensions older than 0.4.8 (they would act on the current tab)', async () => {
  const { supportsTabId } = await import('../src/userRelay.js');
  for (const [v, ok] of [['0.4.8', true], ['0.4.10', true], ['0.5.0', true], ['1.0', true], ['0.4.7', false], ['0.4.6', false], ['', false], ['dev', false]]) {
    assert.equal(supportsTabId(v), ok, v);
  }
  for (const version of ['0.4.6', null]) {
    const a = fakeSocket('tokA', Date.now(), version);
    const { r } = await makeRelay({ devices: [{ name: 'w', token: 'tokA' }], sockets: [a] });
    const ta = target(r, 'w', 'tokA');
    const refused = await r.callExtension('fast_evaluate', { tabId: 7, fn: '() => 1' }, undefined, ta);
    assert.equal(refused.extensionTooOld, true);
    assert.match(refused.error, /needs 0\.4\.8/);
    assert.equal(a.sent.length, 0, 'nothing reached the old extension');
    // no tabId → runs as before; fast_switch/fast_close keep their own tabId
    for (const [action, args] of [['fast_text', {}], ['fast_switch', { tabId: 7 }], ['fast_close', { tabId: 7 }]]) {
      const p = r.callExtension(action, args, undefined, ta);
      await reply(r, a, a.lastCall().id, { result: 'ok' });
      assert.equal((await p).result, 'ok', action);
    }
  }
});

test('a socket with no keepalive for 60 s is dropped: not routed to, closed, its calls fail fast', async () => {
  const { STALE_SOCKET_MS } = await import('../src/userRelay.js');
  const now = Date.now();
  // zombie: connected long ago, last ping long ago (force-killed Chrome); fresh: pinging
  const zombie = fakeSocket('tokA', now - 3600e3, '0.4.6'); zombie.lastPing = now - 3600e3;
  const fresh = fakeSocket('tokB', now - 3600e3, '0.4.8'); fresh.lastPing = now - 5000;
  const { r } = await makeRelay({ devices: [{ name: 'w', token: 'tokA' }, { name: 'h', token: 'tokB' }], sockets: [zombie, fresh] });
  const list = await r.deviceList();
  assert.deepEqual(list.map((d) => [d.name, d.connected]), [['w', false], ['h', true]]);
  assert.equal(zombie.readyState, 3, 'zombie closed');
  assert.equal((await r.resolveTarget('w')).deviceNotConnected, true);
  assert.equal((await r.resolveTarget(null)).name, 'h', 'only live browser is the one online');
  // a just-connected socket counts as live until its first ping is due
  const newSock = fakeSocket('tokA', now - 1000, '0.4.8');
  const { r: r2 } = await makeRelay({ devices: [{ name: 'w', token: 'tokA' }], sockets: [newSock] });
  assert.equal((await r2.deviceList())[0].connected, true);
  assert.equal(STALE_SOCKET_MS, 60000);
});

test('the same browser reconnecting: the live new socket wins over its dead old one', async () => {
  const now = Date.now();
  const old = fakeSocket('tokA', now - 7200e3, '0.4.6'); old.lastPing = now - 3500e3;
  const neu = fakeSocket('tokA', now - 60e3, '0.4.8'); neu.lastPing = now - 2000;
  const { r } = await makeRelay({ devices: [{ name: 'w', token: 'tokA' }], sockets: [old, neu] });
  const t = await r.resolveTarget('w');
  assert.equal(t.ws, neu);
  assert.equal((await r.deviceList())[0].version, '0.4.8');
});
