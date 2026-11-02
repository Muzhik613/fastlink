// npm test   (node --import ./test/register.mjs --test "test/*.test.mjs")
// Parallel Claude Code sessions share one OAuth client; a session's own fast_profile pin must not move another's.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.WebSocketRequestResponsePair ??= class { constructor(a, b) { this.a = a; this.b = b; } };
const { UserRelay } = await import('../src/userRelay.js');

function fakeStorage() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.get(k); },
    async put(k, v) { m.set(k, v); },
    async delete(k) { for (const x of [].concat(k)) m.delete(x); },
    async list({ prefix }) { return new Map([...m].filter(([k]) => k.startsWith(prefix))); },
  };
}

function relay() {
  const storage = fakeStorage();
  const ctx = { storage, getWebSockets: () => [], setWebSocketAutoResponse() {}, acceptWebSocket() {} };
  const r = new UserRelay(ctx, {});  // a real instance: the private #pinKey helpers need it
  return { r, storage };
}

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const req = (sid) => ({ headers: new Headers(sid ? { 'mcp-session-id': sid } : {}) });

test('sessionKey reads a well-formed Mcp-Session-Id only', () => {
  const { r } = relay();
  assert.equal(r.sessionKey(req(A)), A);
  assert.equal(r.sessionKey(req('not-a-session')), null);
  assert.equal(r.sessionKey(req(null)), null);
});

test("another session's pin does not move a pinned session", async () => {
  const { r } = relay();
  await r.setSelection('cX', 'mac2', A);   // WhatsApp send pins mac2
  await r.setSelection('cX', 'mac1', B);   // parallel Gmail session pins mac1 (same OAuth client)
  assert.deepEqual(await r.getSelection('cX', A), { mode: 'pinned', name: 'mac2', source: 'pin' });
  assert.deepEqual(await r.getSelection('cX', B), { mode: 'pinned', name: 'mac1', source: 'pin' });
});

test('a session that never pinned, or sends no session id, keeps the chat-product pin', async () => {
  const { r } = relay();
  await r.setSelection('cX', 'mac1', A);
  assert.equal((await r.getSelection('cX', B)).name, 'mac1');
  assert.equal((await r.getSelection('cX', null)).name, 'mac1');
  await r.setSelection('cX', 'mac2', null);  // Grok-style: no session id
  assert.equal((await r.getSelection('cX', null)).name, 'mac2');
  assert.equal((await r.getSelection('cX', A)).name, 'mac1');
});

test('auto on a session releases only that session', async () => {
  const { r } = relay();
  await r.setSelection('cX', 'mac2', A);
  await r.setSelection('cX', 'mac1', B);
  await r.setSelection('cX', null, A);
  assert.equal((await r.getSelection('cX', A)).mode, 'auto');
  assert.equal((await r.getSelection('cX', B)).name, 'mac1');
});

test('session pins expire after a day and are pruned', async () => {
  const { r, storage } = relay();
  storage.m.set(`dev:spin:${A}`, { name: 'mac2', at: Date.now() - 25 * 3600e3 });
  await storage.put('dev:pin:cX', 'mac1');
  assert.equal((await r.getSelection('cX', A)).name, 'mac1');
  await r.setSelection('cX', 'mac3', B);
  assert.equal(storage.m.has(`dev:spin:${A}`), false);
  assert.equal(storage.m.has(`dev:spin:${B}`), true);
});
