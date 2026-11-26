// fast_watch / fast_capture / fast_watch_read / fast_watch_stop on the relay: events are
// stored as the browser pushes them, a late reader gets every one since its cursor, a
// replayed batch is stored once, a long poll wakes on a push, a restarted browser ends its
// watches, and service tokens are scoped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRelay, fakeSocket, mcpCall, reply, tick } from './helpers.mjs';
import { TOOLS } from '../tools.js';

async function started(r, a, name, args, result = {}) {
  const before = a.sent.filter((m) => m.type === 'call').length;
  const p = mcpCall(r, name, args);
  for (let i = 0; i < 200 && a.sent.filter((m) => m.type === 'call').length === before; i++) await tick();
  const call = a.lastCall();
  assert.equal(call.action, name);
  assert.ok(call.args.watchId);
  await reply(r, a, call.id, { result: { tabId: args.tabId, items: [], ...result }, tabId: args.tabId, origin: 'https://messages.google.com' });
  const out = (await p).data;
  assert.equal(out.watchId, call.args.watchId);
  return { out, call };
}
const push = (r, ws, watchId, n, events, extra = {}) => r.webSocketMessage(ws, JSON.stringify({ type: 'watch', watchId, n, events, ...extra }));

test('tools are listed with short descriptions', () => {
  for (const n of ['fast_watch', 'fast_capture', 'fast_watch_read', 'fast_watch_stop']) {
    const t = TOOLS.find((x) => x.name === n);
    assert.ok(t, n);
    assert.ok(t.description.length <= 300, n);
  }
  assert.ok(TOOLS.find((x) => x.name === 'fast_watch').inputSchema.properties.tabId);
  assert.ok(!TOOLS.find((x) => x.name === 'fast_watch_read').inputSchema.properties.tabId);
});

test('events pushed between reads are all kept; a replayed batch is stored once', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.33');
  const { r } = await makeRelay({ devices: [{ name: 'hvm', token: 'tokA' }], sockets: [a] });
  const { out } = await started(r, a, 'fast_watch', { tabId: 5, selector: '.row', fields: { who: '.n', s: '.s' }, key: 'who' });
  const id = out.watchId;
  await push(r, a, id, 1, [{ kind: 'change', key: 'Ann', item: { who: 'Ann', s: 'one' } }]);
  await push(r, a, id, 2, [{ kind: 'change', key: 'Ann', item: { who: 'Ann', s: 'two' } }]);
  await push(r, a, id, 2, [{ kind: 'change', key: 'Ann', item: { who: 'Ann', s: 'two' } }]);   // resend
  assert.deepEqual(a.sent.filter((m) => m.type === 'watch_ack').map((m) => m.n), [1, 2, 2]);
  const rd = (await mcpCall(r, 'fast_watch_read', { watchId: id, after: 0, waitSec: 0 })).data;
  assert.deepEqual(rd.events.map((e) => [e.seq, e.item.s]), [[1, 'one'], [2, 'two']]);
  assert.equal(rd.next, 2);
  assert.equal(rd.state, 'active');
  const rd2 = (await mcpCall(r, 'fast_watch_read', { watchId: id, after: 2, waitSec: 0 })).data;
  assert.deepEqual(rd2.events, []);
  assert.equal(rd2.next, 2);
});

test('a long poll returns as soon as an event arrives', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.33');
  const { r } = await makeRelay({ devices: [{ name: 'hvm', token: 'tokA' }], sockets: [a] });
  const { out } = await started(r, a, 'fast_watch', { tabId: 5, selector: '.row' });
  const t0 = Date.now();
  const p = mcpCall(r, 'fast_watch_read', { watchId: out.watchId, after: 0, waitSec: 10 });
  await tick(); await tick();
  await push(r, a, out.watchId, 1, [{ kind: 'add', key: 'x', item: { text: 'x' } }]);
  const rd = (await p).data;
  assert.equal(rd.events.length, 1);
  assert.ok(Date.now() - t0 < 2000);
});

test('a frame from another browser is ignored; an unknown watch is told gone', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.33');
  const b = fakeSocket('tokB', Date.now(), '0.4.33');
  const { r } = await makeRelay({ devices: [{ name: 'hvm', token: 'tokA' }, { name: 'mac', token: 'tokB' }], sockets: [a, b] });
  const { out } = await started(r, a, 'fast_watch', { tabId: 5, selector: '.row', browser: 'hvm' });
  await push(r, b, out.watchId, 1, [{ kind: 'add', item: {} }]);
  assert.equal((await mcpCall(r, 'fast_watch_read', { watchId: out.watchId, waitSec: 0 })).data.events.length, 0);
  await push(r, a, '00000000-0000-0000-0000-000000000000', 1, [{ kind: 'add' }]);
  assert.ok(a.sent.some((m) => m.type === 'watch_gone' && m.watchId === '00000000-0000-0000-0000-000000000000'));
});

test('a hello without the watch ends it; stop deletes it and stops it in the browser', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.33');
  const { r } = await makeRelay({ devices: [{ name: 'hvm', token: 'tokA' }], sockets: [a] });
  const w1 = (await started(r, a, 'fast_watch', { tabId: 5, selector: '.a' })).out.watchId;
  const w2 = (await started(r, a, 'fast_watch', { tabId: 5, selector: '.b' })).out.watchId;
  await r.webSocketMessage(a, JSON.stringify({ type: 'hello', version: '0.4.33', watches: [w2] }));
  const rd = (await mcpCall(r, 'fast_watch_read', { watchId: w1, waitSec: 5 })).data;
  assert.equal(rd.state, 'ended');
  assert.match(rd.reason, /restarted/);
  assert.equal(rd.events.at(-1).kind, 'ended');
  assert.equal((await mcpCall(r, 'fast_watch_read', { watchId: w2, waitSec: 0 })).data.state, 'active');

  const p = mcpCall(r, 'fast_watch_stop', { watchId: w2 });
  for (let i = 0; i < 200 && a.lastCall().action !== 'fast_watch_stop'; i++) await tick();
  const call = a.lastCall();
  assert.equal(call.action, 'fast_watch_stop');
  await reply(r, a, call.id, { result: { watchId: w2, stopped: true } });
  assert.equal((await p).data.browserStopped, true);
  assert.match((await mcpCall(r, 'fast_watch_read', { watchId: w2, waitSec: 0 })).data.error, /No watch/);
});

test('a failed start leaves no watch behind', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.33');
  const { r, storage } = await makeRelay({ devices: [{ name: 'hvm', token: 'tokA' }], sockets: [a] });
  const p = mcpCall(r, 'fast_watch', { tabId: 5, selector: '.row' });
  for (let i = 0; i < 200 && !a.lastCall(); i++) await tick();
  await reply(r, a, a.lastCall().id, { error: 'bad selector' });
  assert.match(JSON.stringify((await p).data), /bad selector/);
  assert.equal([...storage.m.keys()].filter((k) => k.startsWith('watch:')).length, 0);
});

test('an extension older than 0.4.33 gets "update FastLink"', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.32');
  const { r, storage } = await makeRelay({ devices: [{ name: 'hvm', token: 'tokA' }], sockets: [a] });
  const out = await mcpCall(r, 'fast_capture', { tabId: 5, url: '/cart' });
  assert.match(JSON.stringify(out.data), /needs 0\.4\.33/);
  assert.equal([...storage.m.keys()].filter((k) => k.startsWith('watch:')).length, 0);
});

test('service tokens: capture only on an allowed origin, with the origins passed on; reads scoped', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.33');
  const { r } = await makeRelay({ devices: [{ name: 'mpc1', token: 'tokA' }, { name: 'winytx', token: 'tokB' }], sockets: [a] });
  const svc = { 'X-Fastlink-Browsers': JSON.stringify(['mpc1']), 'X-Fastlink-Fetch-Origins': JSON.stringify(['https://www.jewelosco.com']) };
  r.origins.set('tokA#5', 'https://evil.test');
  const bad = await mcpCall(r, 'fast_capture', { browser: 'mpc1', tabId: 5, url: '/cart' }, svc);
  assert.match(JSON.stringify(bad.data), /not an allowed origin/);
  r.origins.set('tokA#6', 'https://www.jewelosco.com');
  const p = mcpCall(r, 'fast_capture', { browser: 'mpc1', tabId: 6, url: '/cart' }, svc);
  for (let i = 0; i < 200 && !a.lastCall(); i++) await tick();
  const call = a.lastCall();
  assert.deepEqual(call.args.origins, ['https://www.jewelosco.com']);
  await reply(r, a, call.id, { result: { tabId: 6, url: '/cart' }, tabId: 6 });
  const id = (await p).data.watchId;
  await push(r, a, id, 1, [{ kind: 'request', url: 'https://www.jewelosco.com/cart', status: 200, body: '{}' }]);
  const rd = (await mcpCall(r, 'fast_watch_read', { watchId: id, waitSec: 0 }, svc)).data;
  assert.equal(rd.events[0].status, 200);
  const other = { 'X-Fastlink-Browsers': JSON.stringify(['winytx']) };
  assert.match((await mcpCall(r, 'fast_watch_read', { watchId: id, waitSec: 0 }, other)).data.error, /No watch/);
});

test('past the per-watch cap the oldest go and a late read says gap', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.33');
  const { r } = await makeRelay({ devices: [{ name: 'hvm', token: 'tokA' }], sockets: [a] });
  const { out } = await started(r, a, 'fast_capture', { tabId: 5, url: '/x' });
  for (let n = 1; n <= 105; n++) await push(r, a, out.watchId, n, [{ kind: 'request', i: n }]);
  const rd = (await mcpCall(r, 'fast_watch_read', { watchId: out.watchId, after: 0, waitSec: 0 })).data;
  assert.equal(rd.gap, 5);
  assert.equal(rd.events.length, 100);
  assert.equal(rd.events[0].seq, 6);
});
