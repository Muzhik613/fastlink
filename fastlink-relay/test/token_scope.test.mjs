// Service-token scopes added 11-26: a per-token tool allowlist (agents.tools) and DELETE in fast_fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRelay, fakeSocket, mcpCall, tick, reply } from './helpers.mjs';

const rcs = { 'X-Fastlink-Browsers': JSON.stringify(['hvm-boss']), 'X-Fastlink-Tools': JSON.stringify(['fast_list', 'fast_watch', 'fast_watch_read', 'fast_watch_stop', 'fast_text']) };

test('a tool allowlist: only those tools are listed and callable', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.34');
  const { r } = await makeRelay({ devices: [{ name: 'hvm-boss', token: 'tokA' }], sockets: [a] });
  const { handleMcpRequest } = await import('../src/mcp.js');
  const res = await handleMcpRequest(new Request('https://relay.test/__mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...rcs }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), r);
  const names = (await res.json()).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['fast_list', 'fast_text', 'fast_watch', 'fast_watch_read', 'fast_watch_stop']);
  for (const n of ['fast_click', 'fast_capture', 'fast_fetch', 'fast_batch', 'fast_status', 'fast_evaluate']) {
    const out = await mcpCall(r, n, { tabId: 1 }, rcs);
    assert.match(JSON.stringify(out.data), /may call only/, n);
  }
  assert.equal(a.sent.filter((m) => m.type === 'call').length, 0);
  const p = mcpCall(r, 'fast_list', {}, rcs);
  for (let i = 0; i < 200 && !a.lastCall(); i++) await tick();
  await reply(r, a, a.lastCall().id, { result: [] });
  assert.deepEqual((await p).data, []);
});

test('fast_fetch DELETE with a body, only where the token allows it', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.34');
  const { r } = await makeRelay({ devices: [{ name: 'hvm-ytx', token: 'tokA' }, { name: 'hvm-boss', token: 'tokB' }], sockets: [a] });
  const svc = { 'X-Fastlink-Browsers': JSON.stringify(['hvm-ytx', 'hvm-boss']), 'X-Fastlink-Fetch-Origins': JSON.stringify([{ origin: 'https://www.jewelosco.com', browsers: { 'hvm-ytx': ['GET', 'HEAD', 'POST', 'DELETE'], 'hvm-boss': ['GET', 'HEAD'] } }]) };
  const p = mcpCall(r, 'fast_fetch', { browser: 'hvm-ytx', tabId: 4, url: 'https://www.jewelosco.com/abs/cart/1', method: 'DELETE', body: '{"x":1}' }, svc);
  for (let i = 0; i < 200 && !a.lastCall(); i++) await tick();
  const call = a.lastCall();
  assert.equal(call.args.method, 'DELETE');
  assert.equal(call.args.body, '{"x":1}');
  await reply(r, a, call.id, { result: { status: 200 } });
  assert.equal((await p).data.status, 200);
  const no = await mcpCall(r, 'fast_fetch', { browser: 'hvm-boss', tabId: 4, url: 'https://www.jewelosco.com/abs/cart/1', method: 'DELETE' }, svc);
  assert.match(JSON.stringify(no.data), /DELETE .* not allowed on browser "hvm-boss"|not connected/);
});
