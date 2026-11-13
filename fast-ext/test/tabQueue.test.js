// Per-tab FIFO queue (src/tabQueue.js): same-tab serialization, cross-tab
// parallelism, queued/started frames, unqueued browser-level actions, hard cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabQueue } from '../src/tabQueue.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

// A controllable run(): each call parks until the test releases it by id.
function harness({ targetTab = 1, hardCapMs } = {}) {
  const frames = [];
  const log = [];
  const pending = new Map();   // id -> resolve
  let target = targetTab;
  const run = (action, args) => new Promise((resolve) => {
    log.push(`start:${args.id}`);
    pending.set(args.id, (v) => { log.push(`end:${args.id}`); resolve(v); });
  });
  const q = createTabQueue({
    run, send: (f) => frames.push(f), resolveTabId: async () => target,
    ...(hardCapMs ? { hardCapMs } : {}),
  });
  const submit = (id, action, args = {}) => q.submit({ id, action, args: { ...args, id } });
  return { q, frames, log, pending, submit, setTarget: (t) => { target = t; } };
}

test('calls on the same tab run one at a time, in arrival order', async () => {
  const h = harness();
  const a = h.submit('a', 'fast_click', { tabId: 7 });
  const b = h.submit('b', 'fast_fill', { tabId: 7 });
  const c = h.submit('c', 'fast_snapshot', { tabId: 7 });
  await tick(); await tick();
  assert.deepEqual(h.log, ['start:a']);
  h.pending.get('a')({ result: 'A' });
  assert.deepEqual(await a, { result: 'A' });
  await tick();
  assert.deepEqual(h.log, ['start:a', 'end:a', 'start:b']);
  h.pending.get('b')({ result: 'B' });
  await b; await tick();
  h.pending.get('c')({ result: 'C' });
  assert.deepEqual(await c, { result: 'C' });
  assert.deepEqual(h.log, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  assert.equal(h.q.size(), 0, 'empty lanes are dropped');
});

test('calls on different tabs run in parallel', async () => {
  const h = harness();
  const a = h.submit('a', 'fast_click', { tabId: 1 });
  const b = h.submit('b', 'fast_click', { tabId: 2 });
  await tick(); await tick();
  assert.deepEqual(h.log.sort(), ['start:a', 'start:b']);
  h.pending.get('b')({ result: 'B' });
  h.pending.get('a')({ result: 'A' });
  assert.deepEqual(await Promise.all([a, b]), [{ result: 'A' }, { result: 'B' }]);
});

test('a call without tabId queues on the current target tab', async () => {
  const h = harness({ targetTab: 5 });
  const a = h.submit('a', 'fast_click', { tabId: 5 });
  const b = h.submit('b', 'fast_snapshot');            // resolves to tab 5 → waits behind a
  await tick(); await tick();
  h.setTarget(9);
  const c = h.submit('c', 'fast_snapshot');            // resolves to tab 9 → runs now
  await tick(); await tick(); await tick();
  assert.deepEqual(h.log.sort(), ['start:a', 'start:c']);
  h.pending.get('a')({}); h.pending.get('c')({});
  await a; await c; await tick();
  assert.ok(h.log.includes('start:b'));
  h.pending.get('b')({});
  await b;
});

test('queued and started frames', async () => {
  const h = harness();
  const a = h.submit('a', 'fast_click', { tabId: 3 });
  const b = h.submit('b', 'fast_click', { tabId: 3 });
  const c = h.submit('c', 'fast_click', { tabId: 3 });
  await tick(); await tick();
  assert.deepEqual(h.frames, [
    { type: 'started', id: 'a' },
    { type: 'queued', id: 'b', position: 1 },
    { type: 'queued', id: 'c', position: 2 },
  ]);
  h.pending.get('a')({}); await a; await tick();
  assert.deepEqual(h.frames.at(-1), { type: 'started', id: 'b' });
  h.pending.get('b')({}); await b; await tick();
  assert.deepEqual(h.frames.at(-1), { type: 'started', id: 'c' });
  h.pending.get('c')({}); await c;
});

test('fast_list and fast_tab skip the queue', async () => {
  const h = harness();
  const a = h.submit('a', 'fast_click', { tabId: 4 });
  const l = h.submit('l', 'fast_list', { tabId: 4 });
  const t = h.submit('t', 'fast_tab', { tabId: 4, url: 'https://example.com' });
  await tick(); await tick();
  assert.deepEqual(h.log.sort(), ['start:a', 'start:l', 'start:t']);
  // Unqueued calls never wait: no queued frame, but 'started' (the relay and the call watchdog time them from it).
  assert.deepEqual(h.frames.filter((f) => f.id === 'l' || f.id === 't'), [{ type: 'started', id: 'l' }, { type: 'started', id: 't' }]);
  h.pending.get('l')({ result: [] }); h.pending.get('t')({ result: {} });
  h.pending.get('a')({});
  await Promise.all([a, l, t]);
});

test('a thrown run() becomes an error reply and the queue moves on', async () => {
  const frames = [];
  let n = 0;
  const q = createTabQueue({
    run: async () => { if (n++ === 0) throw new Error('boom'); return { result: 'ok' }; },
    send: (f) => frames.push(f), resolveTabId: async () => 1,
  });
  const a = q.submit({ id: 1, action: 'fast_click', args: { tabId: 1 } });
  const b = q.submit({ id: 2, action: 'fast_click', args: { tabId: 1 } });
  assert.deepEqual(await a, { error: 'boom' });
  assert.deepEqual(await b, { result: 'ok' });
});

test('hard cap: a stuck call answers tab_stuck, and so do the calls behind it', async () => {
  const h = harness({ hardCapMs: 40 });
  const t0 = Date.now();
  const a = h.submit('a', 'fast_evaluate', { tabId: 8 });   // never released
  const b = h.submit('b', 'fast_snapshot', { tabId: 8 });
  const ra = await a;
  assert.equal(ra.code, 'tab_stuck');
  assert.equal(ra.phase, 'fast_evaluate');
  assert.ok(Date.now() - t0 >= 35, 'waited for the cap');
  const rb = await b;                                      // answered at once, not run
  assert.equal(rb.code, 'tab_stuck');
  assert.match(rb.hint, /earlier fast_evaluate/);
  assert.ok(!h.log.includes('start:b'));
  assert.ok(Date.now() - t0 < 75, 'b did not wait out a second cap');
  const t1 = Date.now();
  const c = await h.submit('c', 'fast_click', { tabId: 8 });   // a new call fails fast too
  assert.equal(c.code, 'tab_stuck');
  assert.ok(Date.now() - t1 < 20);
  assert.ok(h.q.isStuck(8));
  const other = h.submit('d', 'fast_click', { tabId: 9 });     // other tabs are untouched
  await tick(); await tick();
  assert.ok(h.log.includes('start:d'));
  h.pending.get('d')({ result: 'D' });
  assert.deepEqual(await other, { result: 'D' });
});

test('a stuck tab clears when the abandoned call settles', async () => {
  const h = harness({ hardCapMs: 30 });
  assert.equal((await h.submit('a', 'fast_evaluate', { tabId: 3 })).code, 'tab_stuck');
  h.pending.get('a')({ result: 'late' });                  // the late result is dropped
  await tick(); await tick();
  assert.equal(h.q.isStuck(3), false);
  const b = h.submit('b', 'fast_snapshot', { tabId: 3 });
  await tick(); await tick();
  h.pending.get('b')({ result: 'B' });
  assert.deepEqual(await b, { result: 'B' });
});

test('a stuck tab clears on resetTab (new page committed / tab closed); fast_nav still runs on it', async () => {
  const h = harness({ hardCapMs: 30 });
  await h.submit('a', 'fast_evaluate', { tabId: 4 });
  const n = h.submit('n', 'fast_nav', { tabId: 4, url: 'https://example.com' });
  await tick(); await tick();
  assert.ok(h.log.includes('start:n'), 'fast_nav is the cure, so it is not refused');
  h.pending.get('n')({ result: 'N' });
  assert.deepEqual(await n, { result: 'N' });
  h.q.resetTab(4);
  assert.equal(h.q.isStuck(4), false);
  const b = h.submit('b', 'fast_snapshot', { tabId: 4 });
  await tick(); await tick();
  h.pending.get('b')({ result: 'B' });
  assert.deepEqual(await b, { result: 'B' });
});

test('fast_switch and fast_close never wait behind a stuck call on their tab (feedback #24)', async () => {
  const h = harness({ hardCapMs: 10_000 });
  h.submit('a', 'fast_evaluate', { tabId: 6 });            // running, not answering
  const s = h.submit('s', 'fast_switch', { tabId: 6, focus: false });
  const c = h.submit('c', 'fast_close', { tabId: 6 });
  await tick(); await tick();
  assert.ok(h.log.includes('start:s') && h.log.includes('start:c'));
  h.pending.get('s')({ result: 'S' }); h.pending.get('c')({ result: 'C' });
  assert.deepEqual(await Promise.all([s, c]), [{ result: 'S' }, { result: 'C' }]);
  h.pending.get('a')({});
});
