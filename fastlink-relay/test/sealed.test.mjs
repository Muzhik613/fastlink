// Secure browsers: sealed calls only, only from machine helpers, metadata-only audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1, fakeSocket, makeRelay, mcpCall, reply, tick } from './helpers.mjs';

const AGENT = { 'X-Fastlink-Caller': 'agent' };
const OAUTH = { 'X-Fastlink-Caller': 'oauth' };
// Wait until the relay has sent the browser a call.
async function sentCall(ws) { for (let i = 0; i < 50 && !ws.lastCall(); i++) await tick(); return ws.lastCall(); }

const FRAME = { v: 1, keyId: 'abcd1234abcd1234', nonce: 'n0nce', ct: 'Q2lwaGVydGV4dA' };

async function secureRelay() {
  const db = fakeD1();
  const ws = fakeSocket('tokS');
  const { r } = await makeRelay({ devices: [{ name: 'aliya', token: 'tokS' }], sockets: [ws], db });
  await r.webSocketMessage(ws, JSON.stringify({ type: 'hello', version: '0.4.10', secure: true, locked: true, keyId: FRAME.keyId }));
  return { r, ws, db };
}

test('a sealed call from a machine helper is forwarded as ciphertext and its reply returned as-is', async () => {
  const { r, ws } = await secureRelay();
  const p = mcpCall(r, 'fast_sealed', { ...FRAME, browser: 'aliya', extra: 'dropped' }, AGENT);
  const call = await sentCall(ws);
  assert.equal(call.action, 'fast_sealed');
  assert.deepEqual(call.args, FRAME, 'only the frame fields travel');
  await reply(r, ws, call.id, { sealed: { v: 1, keyId: FRAME.keyId, nonce: 'x', ct: 'y' } });
  const { data } = await p;
  assert.deepEqual(data, { sealed: { v: 1, keyId: FRAME.keyId, nonce: 'x', ct: 'y' } });
});

test('sealed calls from a connector (OAuth) or with no caller header are refused', async () => {
  const { r, ws } = await secureRelay();
  for (const h of [OAUTH, {}]) {
    const { data } = await mcpCall(r, 'fast_sealed', { ...FRAME, browser: 'aliya' }, h);
    assert.match(data.error, /only from a paired FastLink helper/);
  }
  assert.equal(ws.sent.filter((m) => m.type === 'call').length, 0);
});

test('a secure browser refuses every unsealed tool, from anyone', async () => {
  const { r, ws } = await secureRelay();
  for (const name of ['fast_list', 'fast_text', 'fast_evaluate']) {
    const { data } = await mcpCall(r, name, { browser: 'aliya', fn: '() => 1' }, AGENT);
    assert.ok(data.error, name);
  }
  assert.equal(ws.sent.filter((m) => m.type === 'call').length, 0);
});

test('a sealed call to a normal browser is refused', async () => {
  const ws = fakeSocket('tokN');
  const { r } = await makeRelay({ devices: [{ name: 'normal', token: 'tokN' }], sockets: [ws] });
  const { data } = await mcpCall(r, 'fast_sealed', { ...FRAME, browser: 'normal' }, AGENT);
  assert.match(data.error, /not a secure browser/);
});

test('the audit row of a sealed call holds no action, args or origin', async () => {
  const { r, ws, db } = await secureRelay();
  const p = mcpCall(r, 'fast_sealed', { ...FRAME, browser: 'aliya' }, AGENT);
  await reply(r, ws, (await sentCall(ws)).id, { sealed: { v: 1, keyId: FRAME.keyId, nonce: 'x', ct: 'y' } });
  await p;
  await tick(); await tick();
  const rows = db.raw.prepare(`SELECT action, detail FROM grants_audit`).all();
  const row = rows.find((x) => x.action === 'fast_sealed');
  assert.ok(row, 'audited');
  assert.deepEqual(JSON.parse(row.detail), { sealed: true, bytes: FRAME.ct.length, browser: 'aliya', ok: true });
});

test('fast_status shows the browser as secure and locked', async () => {
  const { r } = await secureRelay();
  const { data } = await mcpCall(r, 'fast_status', {}, AGENT);
  const b = data.browsers.find((x) => x.name === 'aliya');
  assert.equal(b.secure, true);
  assert.equal(b.locked, true);
});
