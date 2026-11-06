// relayClient end to end against a minimal chrome + WebSocket stub: a call that
// finishes after the socket was redialed is answered on the NEW socket, with the
// queue's started frame and the result's tabId/origin passed through.
import test from 'node:test';
import assert from 'node:assert/strict';

const noop = () => {};
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: 'test' }) },
  alarms: { create: noop, clear: noop },
  windows: { getAll: (_q, cb) => cb([{ id: 1 }]) },
  storage: {
    session: { get: async () => ({}) },
    local: { set: noop, remove: noop },
    onChanged: { addListener: noop },
  },
  action: { setIcon: noop, setTitle: noop },
};

const sockets = [];
class FakeWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(s) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(JSON.parse(s)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code: 1000 }); }
  open() { this.readyState = 1; this.onopen?.(); }
  deliver(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}
globalThis.WebSocket = FakeWS;

const { startRelayConnection, stopRelay } = await import('../src/relayClient.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(5); } };

test('a result that finishes after a redial is sent on the new socket', async () => {
  let release;
  const handle = (action, args) => new Promise((r) => { release = () => r({ result: { ok: true }, tabId: args.tabId, origin: 'https://example.com' }); });
  startRelayConnection(handle, { wssUrl: 'wss://relay.test/ext', deviceToken: 'tok', onState: noop, resolveTabId: async () => 42 });
  await until(() => sockets.length === 1);
  const first = sockets[0];
  first.open();
  first.deliver({ type: 'call', id: 'c1', action: 'fast_click', args: { tabId: 7 } });
  await until(() => first.sent.some((f) => f.type === 'started'));
  assert.deepEqual(first.sent.find((f) => f.type === 'started'), { type: 'started', id: 'c1' });

  first.drop();                                  // socket dies mid-call; backoff redials in ~1 s
  await until(() => sockets.length === 2, 3000);
  const second = sockets[1];
  second.open();
  release();
  await until(() => second.sent.some((f) => f.type === 'result'));
  assert.deepEqual(second.sent.find((f) => f.type === 'result'),
    { type: 'result', id: 'c1', result: { ok: true }, tabId: 7, origin: 'https://example.com' });
  assert.ok(!first.sent.some((f) => f.type === 'result'));
  stopRelay();
});

test('a result ready while no socket is open is flushed when one opens', async () => {
  sockets.length = 0;
  let release;
  const handle = () => new Promise((r) => { release = () => r({ result: 'late' }); });
  startRelayConnection(handle, { wssUrl: 'wss://relay.test/ext', deviceToken: 'tok', onState: noop, resolveTabId: async () => 1 });
  await until(() => sockets.length === 1);
  const first = sockets[0];
  first.open();
  first.deliver({ type: 'call', id: 'c2', action: 'fast_snapshot', args: {} });
  await until(() => first.sent.some((f) => f.type === 'started'));
  first.drop();
  release();                                     // finishes with no open socket → held
  await until(() => sockets.length === 2, 3000);
  const second = sockets[1];
  assert.equal(second.sent.length, 0);
  second.open();                                 // hello, then the held result
  assert.deepEqual(second.sent.map((f) => f.type), ['hello', 'result']);
  assert.equal(second.sent[1].id, 'c2');
  stopRelay();
});
