// Stateless routing: `browser` arg → account default → hard error. No pin state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRelay, fakeSocket, mcpCall, reply, tick } from './helpers.mjs';
import { TOOLS } from '../tools.js';

const twoBrowsers = () => {
  const a = fakeSocket('tokA'); const b = fakeSocket('tokB');
  return { a, b, devices: [{ name: 'work', token: 'tokA' }, { name: 'home', token: 'tokB' }], sockets: [a, b] };
};

// Run a browser tool and answer it from whichever socket received the call.
async function drive(r, sockets, name, args) {
  const p = mcpCall(r, name, args);
  await tick(); await tick();
  const ws = sockets.find((s) => s.lastCall());
  assert.ok(ws, 'no call was sent');
  await reply(r, ws, ws.lastCall().id, { result: { ok: true }, origin: 'https://x.test', tabId: 7 });
  return { ws, call: ws.lastCall(), out: await p };
}

test('browser arg routes to that browser; browser is stripped, tabId passes through', async () => {
  const { a, b, devices, sockets } = twoBrowsers();
  const { r } = await makeRelay({ devices, sockets });
  const { ws, call } = await drive(r, sockets, 'fast_snapshot', { browser: 'home', tabId: 42 });
  assert.equal(ws, b);
  assert.equal(a.sent.length, 0);
  assert.deepEqual(call.args, { tabId: 42 });
});

test('the result envelope tabId reaches the MCP result', async () => {
  const { devices, sockets } = twoBrowsers();
  const { r, storage } = await makeRelay({ devices, sockets });
  await storage.put('dev:default', 'work');
  const { out } = await drive(r, sockets, 'fast_tab', { url: 'https://x.test' });
  assert.equal(out.data.tabId, 7);
});

test('no browser arg → account default', async () => {
  const { a, devices, sockets } = twoBrowsers();
  const { r, storage } = await makeRelay({ devices, sockets });
  await storage.put('dev:default', 'work');
  const { ws } = await drive(r, sockets, 'fast_text', {});
  assert.equal(ws, a);
});

test('no browser arg and no default → error naming connected browsers, nothing sent', async () => {
  const { a, b, devices, sockets } = twoBrowsers();
  const { r } = await makeRelay({ devices, sockets });
  const { data } = await mcpCall(r, 'fast_click', { text: 'Go' });
  assert.equal(data.noDefaultBrowser, true);
  assert.match(data.error, /work, home/);
  assert.equal(a.sent.length + b.sent.length, 0);
});

test('named browser offline → error, never a redirect', async () => {
  const a = fakeSocket('tokA');
  const devices = [{ name: 'work', token: 'tokA' }, { name: 'home', token: 'tokB' }];
  const { r, storage } = await makeRelay({ devices, sockets: [a] });
  await storage.put('dev:default', 'work');
  const { data } = await mcpCall(r, 'fast_click', { browser: 'home', text: 'Go' });
  assert.equal(data.deviceNotConnected, true);
  assert.match(data.error, /Connected now: work/);
  assert.equal(a.sent.length, 0);
});

test('unknown browser name → error listing paired browsers', async () => {
  const { devices, sockets } = twoBrowsers();
  const { r } = await makeRelay({ devices, sockets });
  const { data } = await mcpCall(r, 'fast_list', { browser: 'nope' });
  assert.equal(data.wrongBrowser, true);
  assert.match(data.error, /Paired browsers: work, home/);
});

test('fast_status reports browsers, defaultBrowser and routedBrowser for the given name', async () => {
  const a = fakeSocket('tokA');
  const devices = [{ name: 'work', token: 'tokA' }, { name: 'home', token: 'tokB' }];
  const { r, storage } = await makeRelay({ devices, sockets: [a] });
  await storage.put('dev:default', 'work');
  let { data } = await mcpCall(r, 'fast_status', {});
  assert.deepEqual(data.browsers.map((x) => [x.name, x.connected]), [['work', true], ['home', false]]);
  assert.equal(data.defaultBrowser, 'work');
  assert.equal(data.routedBrowser, 'work');
  ({ data } = await mcpCall(r, 'fast_status', { browser: 'home' }));
  assert.equal(data.routedBrowser, null);
  assert.match(data.targetError, /"home" is not connected/);
});

test('no pin state is written anywhere by routing or status calls', async () => {
  const { devices, sockets } = twoBrowsers();
  const { r, storage } = await makeRelay({ devices, sockets });
  await storage.put('dev:default', 'work');
  const before = new Set(storage.m.keys());
  await drive(r, sockets, 'fast_snapshot', { browser: 'home' });
  await mcpCall(r, 'fast_status', { browser: 'home' });
  const added = [...storage.m.keys()].filter((k) => !before.has(k));
  assert.deepEqual(added.filter((k) => k.startsWith('dev:')), []);
  assert.equal(storage.m.get('dev:default'), 'work');
  for (const gone of ['clientKey', 'sessionKey', 'getSelection', 'setSelection']) assert.equal(r[gone], undefined);
});

test('fast_batch: steps go to the routed browser, batch tabId reaches page steps only', async () => {
  const { a, b, devices, sockets } = twoBrowsers();
  const { r } = await makeRelay({ devices, sockets });
  const p = mcpCall(r, 'fast_batch', { browser: 'home', tabId: 9, actions: [{ name: 'fast_text', args: { browser: 'work' } }] });
  for (let i = 0; i < 50 && !b.lastCall(); i++) await tick();
  const call = b.lastCall();
  assert.equal(call.action, 'fast_text');
  assert.equal(call.args.tabId, 9);
  assert.equal('browser' in call.args, false);
  await reply(r, b, call.id, { result: 'hi' });
  await p;
  assert.equal(a.sent.length, 0);
});

test('tools.js: fast_profile gone, fast_feedback present, browser tools take browser+tabId', () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(names.includes('fast_profile'), false);
  assert.ok(names.includes('fast_feedback'));
  const click = TOOLS.find((t) => t.name === 'fast_click').inputSchema.properties;
  assert.ok(click.browser && click.tabId);
  assert.ok(TOOLS.find((t) => t.name === 'fast_status').inputSchema.properties.browser);
  assert.doesNotMatch(JSON.stringify(TOOLS), /fast_profile|pin/i);
});
