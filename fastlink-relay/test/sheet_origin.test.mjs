// Sheets (page targets that are not tabs, e.g. the Google Pay sheet) and origin-limited tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRelay, fakeSocket, mcpCall, tick, reply } from './helpers.mjs';

const calls = (ws) => ws.sent.filter((m) => m.type === 'call');
async function answer(r, a, n, body) { for (let i = 0; i < 300 && calls(a).length < n; i++) await tick(); await reply(r, a, calls(a)[n - 1].id, body); }

test('sheets: read/click tools only; service tokens only with Dunkin origins, held to pay.google.com', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.36');
  const { r } = await makeRelay({ devices: [{ name: 'hvm-boss', token: 'tokA' }], sockets: [a] });
  const dunkin = { 'X-Fastlink-Browsers': JSON.stringify(['hvm-boss']), 'X-Fastlink-Fetch-Origins': JSON.stringify([{ origin: 'https://www.dunkindonuts.com', browsers: { 'hvm-boss': ['GET'] } }]) };
  const plain = { 'X-Fastlink-Browsers': JSON.stringify(['hvm-boss']) };
  assert.match(JSON.stringify((await mcpCall(r, 'fast_type', { targetId: 'ABCDEF0123456789', text: 'x' })).data), /does not take a targetId/);
  assert.match(JSON.stringify((await mcpCall(r, 'fast_click', { targetId: 'ABCDEF0123456789', text: 'Pay' }, plain)).data), /may not act on sheets/);
  assert.equal(calls(a).length, 0);
  const p = mcpCall(r, 'fast_click', { targetId: 'ABCDEF0123456789', text: 'Continue', tabId: 3 }, dunkin);
  await answer(r, a, 1, { result: { clicked: 'Continue' } });
  assert.equal((await p).data.clicked, 'Continue');
  const c = calls(a)[0];
  assert.deepEqual(c.args.sheetHosts, ['pay.google.com']);
  assert.equal(c.args.tabId, undefined);
  const l = mcpCall(r, 'fast_list', {}, plain);
  await answer(r, a, 2, { result: [] });
  await l;
  assert.deepEqual(calls(a)[1].args.sheetHosts, ['-'], 'a token without Dunkin origins lists no sheets');
});

test('sheets need extension 0.4.36', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.35');
  const { r } = await makeRelay({ devices: [{ name: 'hvm-boss', token: 'tokA' }], sockets: [a] });
  assert.match(JSON.stringify((await mcpCall(r, 'fast_snapshot', { targetId: 'ABCDEF0123456789' })).data), /needs 0\.4\.36/);
});

test('an origin-limited token acts only on tabs on its origins and loads only URLs there', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.36');
  const { r } = await makeRelay({ devices: [{ name: 'hvm-boss', token: 'tokA' }], sockets: [a] });
  const H = { 'X-Fastlink-Browsers': JSON.stringify(['hvm-boss']), 'X-Fastlink-Origins': JSON.stringify(['https://messages.google.com']) };
  assert.match(JSON.stringify((await mcpCall(r, 'fast_nav', { tabId: 1, url: 'https://evil.test/' }, H)).data), /may load only https:\/\/messages\.google\.com/);
  assert.match(JSON.stringify((await mcpCall(r, 'fast_click', { text: 'Send' }, H)).data), /must pass tabId/);
  const tabs = [{ id: 1, url: 'https://messages.google.com/web/conversations/1' }, { id: 2, url: 'https://mail.google.com/' }];
  const bad = mcpCall(r, 'fast_click', { tabId: 2, text: 'Send' }, H);
  await answer(r, a, 1, { result: tabs });
  assert.match(JSON.stringify((await bad).data), /Tab 2 is on https:\/\/mail\.google\.com/);
  const ok = mcpCall(r, 'fast_click', { tabId: 1, text: 'Send' }, H);
  await answer(r, a, 2, { result: tabs });
  await answer(r, a, 3, { result: { clicked: 'Send' }, tabId: 1, origin: 'https://messages.google.com' });
  assert.equal((await ok).data.clicked, 'Send');
  assert.equal(calls(a)[2].args.expectOrigin, 'https://messages.google.com');
});
