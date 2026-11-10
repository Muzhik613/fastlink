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
