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
  for (let i = 0; i < 200 && !sockets.some((s) => s.lastCall()); i++) await tick();
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
  const { r } = await makeRelay({ devices, sockets });
  const { out } = await drive(r, sockets, 'fast_tab', { url: 'https://x.test', browser: 'work' });
  assert.equal(out.data.tabId, 7);
});

test('no browser arg, ONE browser online → that browser (even with others paired)', async () => {
  const a = fakeSocket('tokA');
  const devices = [{ name: 'work', token: 'tokA' }, { name: 'home', token: 'tokB' }];
  const { r } = await makeRelay({ devices, sockets: [a] });
  const { ws, out } = await drive(r, [a], 'fast_text', {});
  assert.equal(ws, a);
  assert.equal(out.body.result._meta['fastlink/browser'], 'work');
});

test('no browser arg, several online → the lastBrowser hint if it is online', async () => {
  const { b, devices, sockets } = twoBrowsers();
  const { r } = await makeRelay({ devices, sockets });
  const { ws, call, out } = await drive(r, sockets, 'fast_text', { lastBrowser: 'home' });
  assert.equal(ws, b);
  assert.equal('lastBrowser' in call.args, false);
  assert.equal(out.body.result._meta['fastlink/browser'], 'home');
});

test('no browser arg, several online, no usable hint → error listing the online browsers, nothing sent', async () => {
  for (const hint of [undefined, 'gone']) {
    const { a, b, devices, sockets } = twoBrowsers();
    const { r } = await makeRelay({ devices, sockets });
    const { data } = await mcpCall(r, 'fast_click', { text: 'Go', ...(hint ? { lastBrowser: hint } : {}) });
    assert.equal(data.browserNotChosen, true);
    assert.match(data.error, /work, home/);
    assert.equal(a.sent.length + b.sent.length, 0);
  }
});

test('nothing online → no-browser error', async () => {
  const devices = [{ name: 'work', token: 'tokA' }];
  const { r } = await makeRelay({ devices, sockets: [] });
  const { data } = await mcpCall(r, 'fast_text', {});
  assert.equal(data.noDeviceConnected, true);
});

test('named browser offline → error, never a redirect (even if it is the only one paired that is offline)', async () => {
  const a = fakeSocket('tokA');
  const devices = [{ name: 'work', token: 'tokA' }, { name: 'home', token: 'tokB' }];
  const { r } = await makeRelay({ devices, sockets: [a] });
  const { data } = await mcpCall(r, 'fast_click', { browser: 'home', text: 'Go' });
  assert.equal(data.deviceNotConnected, true);
  assert.match(data.error, /Online now: work/);
  assert.equal(a.sent.length, 0);
});

test('unknown browser name → error listing paired browsers', async () => {
  const { devices, sockets } = twoBrowsers();
  const { r } = await makeRelay({ devices, sockets });
  const { data } = await mcpCall(r, 'fast_list', { browser: 'nope' });
  assert.equal(data.wrongBrowser, true);
  assert.match(data.error, /Paired browsers: work, home/);
});

test('fast_status reports browsers and routedBrowser; there is no default', async () => {
  const a = fakeSocket('tokA');
  const devices = [{ name: 'work', token: 'tokA' }, { name: 'home', token: 'tokB' }];
  const { r } = await makeRelay({ devices, sockets: [a] });
  let { data } = await mcpCall(r, 'fast_status', {});
  assert.deepEqual(data.browsers.map((x) => [x.name, x.connected]), [['work', true], ['home', false]]);
  assert.equal('defaultBrowser' in data, false);
  assert.equal(data.routedBrowser, 'work');
  ({ data } = await mcpCall(r, 'fast_status', { browser: 'home' }));
  assert.equal(data.routedBrowser, null);
  assert.match(data.targetError, /"home" is not connected/);
});

test('no pin state is written anywhere by routing or status calls', async () => {
  const { devices, sockets } = twoBrowsers();
  const { r, storage } = await makeRelay({ devices, sockets });
  const before = new Set(storage.m.keys());
  await drive(r, sockets, 'fast_snapshot', { browser: 'home' });
  await drive(r, sockets, 'fast_snapshot', { lastBrowser: 'work' });
  await mcpCall(r, 'fast_status', { browser: 'home' });
  const added = [...storage.m.keys()].filter((k) => !before.has(k));
  assert.deepEqual(added.filter((k) => k.startsWith('dev:')), []);
  for (const gone of ['clientKey', 'sessionKey', 'getSelection', 'setSelection', 'getDefaultDevice', 'setDefaultDevice']) assert.equal(r[gone], undefined);
});

test('fast_batch: steps go to the routed browser, batch tabId reaches page steps only', async () => {
  const { a, b, devices, sockets } = twoBrowsers();
  const { r } = await makeRelay({ devices, sockets });
  const p = mcpCall(r, 'fast_batch', { browser: 'home', tabId: 9, actions: [{ name: 'fast_text', args: { browser: 'work' } }] });
  for (let i = 0; i < 200 && !b.lastCall(); i++) await tick();
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

test('fast_batch: a step with tabId:null is gated AND run on the batch tab (one source of args)', async () => {
  const { b, devices, sockets } = twoBrowsers();
  const { r } = await makeRelay({ devices, sockets, env: { CONSENT_DEFAULT: 'readonly' } });
  // tab 9 is known to be on a read-only site; the browser's target tab is unknown
  let p = r.callExtension('fast_text', { tabId: 9 }, undefined, { ws: b, name: 'home', deviceToken: 'tokB' });
  await reply(r, b, b.lastCall().id, { result: 1, origin: 'https://ro.test', tabId: 9 });
  await p;
  const out = await mcpCall(r, 'fast_batch', { browser: 'home', tabId: 9, actions: [{ name: 'fast_click', args: { tabId: null, text: 'Buy' } }] });
  assert.match(JSON.stringify(out.data), /read-only|readonly/i);
  assert.notEqual(b.lastCall().action, 'fast_click');
});

test('a non-number tabId is refused, top level and in batch steps', async () => {
  const { a, devices, sockets } = twoBrowsers();
  const { r } = await makeRelay({ devices, sockets });
  const top = await mcpCall(r, 'fast_click', { browser: 'work', tabId: '9', text: 'x' });
  assert.match(JSON.stringify(top.data), /tabId must be a number/);
  const batch = await mcpCall(r, 'fast_batch', { browser: 'work', actions: [{ name: 'fast_click', args: { tabId: 'x' } }] });
  assert.match(JSON.stringify(batch.data), /tabId must be a number/);
  assert.equal(a.sent.filter((m) => m.action === 'fast_click').length, 0);
});
