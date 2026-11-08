// Secure browsers: sealed calls only, only from machine helpers, metadata-only audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1, fakeSocket, makeRelay, mcpCall, reply, tick } from './helpers.mjs';
import { getDeviceLock } from '../src/db.js';

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

// The 11-08 incident: the secure build was removed and a normal build loaded with the same
// extension id kept chrome.storage, so it came back with the secure browser's pairing,
// unlocked. The relay's own record of the lock must decide, never the client's report.
test('server-side lock: a locked device stays sealed-only even when a client reports otherwise', async () => {
  const { r, ws, db } = await secureRelay();
  const row = () => db.raw.prepare(`SELECT locked_key_id FROM devices WHERE device_token = 'tokS'`).get();
  assert.equal(row().locked_key_id, FRAME.keyId, 'first locked hello recorded');

  // A reconnect: the relay stamps its recorded lock on the new socket when it connects
  // (#acceptExtension does exactly this read), before the client says anything.
  const reconnect = async (connectedAt) => {
    const w = fakeSocket('tokS', connectedAt);
    w.serializeAttachment({ ...w.deserializeAttachment(), serverLock: await getDeviceLock(db, 'tokS') });
    const { r: rr } = await makeRelay({ sockets: [w], db, userId: 'u1' });
    return { w, rr };
  };
  // Same pairing, now a normal build (no secure flag in its hello).
  const { w: plain, rr: r2 } = await reconnect(Date.now() + 1);
  await r2.webSocketMessage(plain, JSON.stringify({ type: 'hello', version: '0.4.6' }));
  assert.equal((await mcpCall(r2, 'fast_list', { browser: 'aliya' }, AGENT)).data.lockMismatch, true);
  assert.ok((await mcpCall(r2, 'fast_evaluate', { browser: 'aliya', fn: '() => 1' }, AGENT)).data.error, 'refused (an earlier gate may answer first)');
  const sealed = await mcpCall(r2, 'fast_sealed', { ...FRAME, browser: 'aliya' }, AGENT);
  assert.equal(sealed.data.lockMismatch, true);
  assert.equal(plain.sent.filter((m) => m.type === 'call').length, 0, 'nothing reached the unlocked client');
  const st = await mcpCall(r2, 'fast_status', {}, AGENT);
  const b = st.data.browsers.find((x) => x.name === 'aliya');
  assert.deepEqual([b.secure, b.locked, b.lockMismatch], [true, true, true]);

  // A secure client that reports a DIFFERENT key, or "unlocked", is refused too; the record never changes.
  for (const hello of [{ secure: true, locked: true, keyId: 'ffff0000ffff0000' }, { secure: true, locked: false }]) {
    const { w, rr: r3 } = await reconnect(Date.now() + 2);
    await r3.webSocketMessage(w, JSON.stringify({ type: 'hello', version: '0.4.10', ...hello }));
    const { data } = await mcpCall(r3, 'fast_sealed', { ...FRAME, browser: 'aliya' }, AGENT);
    assert.equal(data.lockMismatch, true);
  }
  assert.equal(row().locked_key_id, FRAME.keyId, 'the first lock sticks');
  // A client that never says hello at all is still held to the recorded lock.
  const { w: silent, rr: r4 } = await reconnect(Date.now() + 3);
  assert.equal((await mcpCall(r4, 'fast_list', { browser: 'aliya' }, AGENT)).data.lockMismatch, true);
  assert.equal(silent.sent.filter((m) => m.type === 'call').length, 0);
});

test('review fixes: recording a lock marks every live socket of that pairing; a locked name is never taken over', async () => {
  const db = fakeD1();
  const a = fakeSocket('tokS'); const b = fakeSocket('tokS', Date.now() + 5);
  const { r } = await makeRelay({ devices: [{ name: 'aliya', token: 'tokS' }, { name: 'new', token: 'tokN' }], sockets: [a, b], db });
  await r.webSocketMessage(a, JSON.stringify({ type: 'hello', version: '0.4.10', secure: true, locked: true, keyId: FRAME.keyId }));
  assert.equal(b.deserializeAttachment().serverLock, FRAME.keyId, 'the other socket of the same pairing is locked too');
  await r.webSocketMessage(b, JSON.stringify({ type: 'hello', version: '0.4.6' }));
  assert.equal((await mcpCall(r, 'fast_list', { browser: 'aliya' }, AGENT)).data.lockMismatch, true);

  const { renameDevice } = await import('../src/db.js');
  const res = await renameDevice(db, 'u1', 'tokN', 'aliya', { replace: true, liveTokens: new Set() });
  assert.deepEqual(res, { ok: false, error: 'name_locked' });
});
