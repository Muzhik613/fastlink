// Result delivery (src/replySender.js): current socket first, arrival socket only
// when there is no current one, held ≤ HOLD_MS and flushed on reconnect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplySender, FRAME_MAX_BYTES } from '../src/replySender.js';

const sock = (readyState = 1) => ({ readyState, sent: [], send(s) { this.sent.push(JSON.parse(s)); } });

test('a result goes out on the CURRENT socket, not the one it arrived on', () => {
  const arrival = sock(3);      // closed after a redial
  const current = sock(1);
  const r = createReplySender({ getCurrent: () => current });
  assert.equal(r.sendResult({ type: 'result', id: 1 }, arrival), true);
  assert.deepEqual(current.sent, [{ type: 'result', id: 1 }]);
  assert.deepEqual(arrival.sent, []);
});

test('also when the arrival socket is still open', () => {
  const arrival = sock(1);
  const current = sock(1);
  const r = createReplySender({ getCurrent: () => current });
  r.sendResult({ type: 'result', id: 2 }, arrival);
  assert.equal(current.sent.length, 1);
  assert.equal(arrival.sent.length, 0);
});

test('falls back to the arrival socket only when there is no current one', () => {
  const arrival = sock(1);
  const r = createReplySender({ getCurrent: () => null });
  assert.equal(r.sendResult({ type: 'result', id: 3 }, arrival), true);
  assert.deepEqual(arrival.sent, [{ type: 'result', id: 3 }]);
});

test('with no open socket the result is held and flushed on reconnect', () => {
  let current = sock(0);        // CONNECTING
  const r = createReplySender({ getCurrent: () => current });
  assert.equal(r.sendResult({ type: 'result', id: 4 }, sock(3)), false);
  assert.equal(r.heldCount(), 1);
  current = sock(1);
  r.flush();
  assert.deepEqual(current.sent, [{ type: 'result', id: 4 }]);
  assert.equal(r.heldCount(), 0);
});

test('held results older than the window are dropped, not sent', () => {
  let now = 1000;
  let current = null;
  const r = createReplySender({ getCurrent: () => current, holdMs: 10_000, now: () => now });
  r.sendResult({ type: 'result', id: 'old' }, null);
  now += 6_000;
  r.sendResult({ type: 'result', id: 'new' }, null);
  now += 5_000;                 // old is 11 s, new is 5 s
  current = sock(1);
  r.flush();
  assert.deepEqual(current.sent.map((f) => f.id), ['new']);
});

test('progress frames are live-only: never held, never sent on the arrival socket', () => {
  const r = createReplySender({ getCurrent: () => null });
  assert.equal(r.sendProgress({ type: 'started', id: 5 }), false);
  assert.equal(r.heldCount(), 0);
});

test('a result frame too big for the socket goes out as an error, never the frame', () => {
  const sent = [];
  const ws = { readyState: 1, send: (s) => sent.push(s) };
  const r = createReplySender({ getCurrent: () => ws });
  r.sendResult({ type: 'result', id: 7, tabId: 3, result: { text: 'x'.repeat(FRAME_MAX_BYTES) } }, ws);
  const f = JSON.parse(sent[0]);
  assert.equal(f.id, 7);
  assert.equal(f.tabId, 3);
  assert.match(f.error, /result too large to send \(16\.0 MB; the limit is 16\.0 MB\).*offset/);
  assert.equal(f.result, undefined);
});
