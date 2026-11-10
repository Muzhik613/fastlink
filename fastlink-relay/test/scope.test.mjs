// Service tokens limited to some browsers (agents.browsers → X-Fastlink-Browsers, set by the worker).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSocket, makeRelay, mcpCall, reply, tick } from './helpers.mjs';

const SCOPE = { 'X-Fastlink-Caller': 'agent', 'X-Fastlink-Browsers': JSON.stringify(['winytx', 'office']) };
async function three() {
  const s = { winytx: fakeSocket('t1', Date.now(), '0.4.20'), office: fakeSocket('t2', Date.now(), '0.4.20'), win1: fakeSocket('t3', Date.now(), '0.4.20') };
  const { r } = await makeRelay({ devices: [{ name: 'winytx', token: 't1' }, { name: 'office', token: 't2' }, { name: 'win1', token: 't3' }], sockets: Object.values(s) });
  return { r, s };
}
async function answer(r, ws, body) { for (let i = 0; i < 200 && !ws.lastCall(); i++) await tick(); await reply(r, ws, ws.lastCall().id, body); }

test('a scoped token drives a browser in its list', async () => {
  const { r, s } = await three();
  const p = mcpCall(r, 'fast_list', { browser: 'office' }, SCOPE);
  await answer(r, s.office, { result: [] });
  assert.deepEqual((await p).data, []);
  assert.equal(s.win1.sent.length, 0);
});

test('a scoped token is refused for any other browser, and without a browser name when it has several', async () => {
  const { r, s } = await three();
  for (const args of [{ browser: 'win1' }, {}]) {
    const { data } = await mcpCall(r, 'fast_list', args, SCOPE);
    assert.match(data.error, /may drive only: winytx, office/);
  }
  assert.equal(s.win1.sent.length + s.winytx.sent.length + s.office.sent.length, 0);
});

test('a scoped token sees only its browsers in fast_status and cannot send sealed calls', async () => {
  const { r } = await three();
  const st = (await mcpCall(r, 'fast_status', {}, SCOPE)).data;
  assert.deepEqual(st.browsers.map((b) => b.name).sort(), ['office', 'winytx']);
  assert.match((await mcpCall(r, 'fast_sealed', { browser: 'office', v: 1, keyId: 'k', nonce: 'n', ct: 'c' }, SCOPE)).data.error, /cannot send sealed/);
});

test('an unscoped machine token still reaches every browser', async () => {
  const { r, s } = await three();
  const p = mcpCall(r, 'fast_list', { browser: 'win1' }, { 'X-Fastlink-Caller': 'agent' });
  await answer(r, s.win1, { result: [] });
  assert.deepEqual((await p).data, []);
});

const FETCH = { ...SCOPE, 'X-Fastlink-Fetch-Origins': JSON.stringify(['https://www.jewelosco.com']) };
async function toolsList(r, headers) {
  const { handleMcpRequest } = await import('../src/mcp.js');
  const res = await handleMcpRequest(new Request('https://relay.test/__mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), r);
  return (await res.json()).result.tools.map((t) => t.name);
}

test('fast_fetch is listed and allowed only for tokens with fetch origins', async () => {
  const { r, s } = await three();
  assert.equal((await toolsList(r, {})).includes('fast_fetch'), false);
  assert.equal((await toolsList(r, SCOPE)).includes('fast_fetch'), false);
  assert.equal((await toolsList(r, FETCH)).includes('fast_fetch'), true);
  const { data } = await mcpCall(r, 'fast_fetch', { browser: 'office', tabId: 5, url: 'https://www.jewelosco.com/x' }, SCOPE);
  assert.match(data.error, /only for service tokens/);
  assert.equal(s.office.sent.length, 0);
});

test('fast_fetch: other origins, non-https, no tabId, bad method and GET with a body are refused before the browser', async () => {
  const { r, s } = await three();
  const bad = [
    { tabId: 5, url: 'https://evil.example/x' },
    { tabId: 5, url: 'http://www.jewelosco.com/x' },
    { url: 'https://www.jewelosco.com/x' },
    { tabId: 5, url: 'https://www.jewelosco.com/x', method: 'DELETE' },
    { tabId: 5, url: 'https://www.jewelosco.com/x', body: 'q=1' },
  ];
  for (const a of bad) assert.ok((await mcpCall(r, 'fast_fetch', { browser: 'office', ...a }, FETCH)).data.error, JSON.stringify(a));
  assert.equal(s.office.sent.length, 0);
});

test('fast_fetch sends exactly the checked request, pinned to the origin, and returns the body', async () => {
  const { r, s } = await three();
  const p = mcpCall(r, 'fast_fetch', { browser: 'office', tabId: 5, url: 'https://www.jewelosco.com/api/search?q=milk', method: 'post', headers: { 'content-type': 'application/json', Cookie: 'x=1' }, body: '{"q":"milk"}' }, FETCH);
  for (let i = 0; i < 200 && !s.office.lastCall(); i++) await tick();
  const c = s.office.lastCall();
  assert.equal(c.action, 'fast_fetch');
  assert.deepEqual(c.args, { tabId: 5, url: 'https://www.jewelosco.com/api/search?q=milk', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"q":"milk"}', expectOrigin: 'https://www.jewelosco.com' });
  await reply(r, s.office, c.id, { result: { status: 200, body: '{"items":[]}' } });
  assert.deepEqual((await p).data, { status: 200, body: '{"items":[]}' });
});

test('fast_fetch per-browser methods: POST on office, GET only on winytx', async () => {
  const { r, s } = await three();
  const H = { ...SCOPE, 'X-Fastlink-Fetch-Origins': JSON.stringify([{ origin: 'https://www.jewelosco.com', browsers: { office: ['GET', 'POST', 'HEAD'], winytx: ['GET', 'HEAD'] } }]) };
  const no = (await mcpCall(r, 'fast_fetch', { browser: 'winytx', tabId: 5, url: 'https://www.jewelosco.com/a', method: 'POST', body: 'x' }, H)).data;
  assert.match(no.error, /POST .* not allowed on browser "winytx"/);
  assert.equal(s.winytx.sent.length, 0);
  const p = mcpCall(r, 'fast_fetch', { browser: 'office', tabId: 5, url: 'https://www.jewelosco.com/a', method: 'POST', body: 'x' }, H);
  for (let i = 0; i < 200 && !s.office.lastCall(); i++) await tick();
  assert.equal(s.office.lastCall().args.method, 'POST');
  await reply(r, s.office, s.office.lastCall().id, { result: { status: 200 } });
  await p;
  const g = mcpCall(r, 'fast_fetch', { browser: 'winytx', tabId: 6, url: 'https://www.jewelosco.com/a' }, H);
  for (let i = 0; i < 200 && !s.winytx.lastCall(); i++) await tick();
  assert.equal(s.winytx.lastCall().args.method, 'GET');
  await reply(r, s.winytx, s.winytx.lastCall().id, { result: { status: 200 } });
  await g;
});
