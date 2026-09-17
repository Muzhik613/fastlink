// node --test — hedged model turns: one duplicate request when a turn stalls far past the run's normal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hedged, hedgeDelay, HEDGE_FLOOR_MS } from '../runner.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a fake model call: answers after `ms` unless its signal aborts first
const fake = (log) => (plan) => (signal) => new Promise((resolve, reject) => {
  const i = log.length; const p = plan[i] ?? plan.at(-1);
  log.push({ started: true, aborted: false });
  const t = p.ms === Infinity ? null : setTimeout(() => (p.error ? reject(new Error(p.error)) : resolve({ id: i, content: [] })), p.ms);
  signal.addEventListener('abort', () => { log[i].aborted = true; if (t) clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

test('a normal turn: no duplicate, no hedge record', async () => {
  const log = []; const send = fake(log)([{ ms: 5 }]);
  const { resp, hedge } = await hedged(send, { delayMs: 50 });
  assert.equal(resp.id, 0); assert.equal(hedge, null); assert.equal(log.length, 1);
});

test('a stalled turn: the duplicate answers, wins, and the stalled request is aborted', async () => {
  const log = []; const send = fake(log)([{ ms: Infinity }, { ms: 10 }]);
  const t0 = Date.now();
  const { resp, hedge } = await hedged(send, { delayMs: 30 });
  assert.equal(resp.id, 1);
  assert.equal(hedge.winner, 'duplicate'); assert.equal(hedge.afterMs, 30); assert.ok(hedge.ms >= 30 && Date.now() - t0 < 500);
  assert.equal(log[0].aborted, true, 'the stalled original was cancelled');
});

test('the original answers after the duplicate was fired: original wins, duplicate aborted', async () => {
  const log = []; const send = fake(log)([{ ms: 60 }, { ms: 500 }]);
  const { resp, hedge } = await hedged(send, { delayMs: 20 });
  assert.equal(resp.id, 0); assert.equal(hedge.winner, 'original'); assert.equal(log[1].aborted, true);
});

test('errors: an original that fails before the hedge rejects at once; one failure after the hedge waits for the other', async () => {
  let log = []; await assert.rejects(hedged(fake(log)([{ ms: 5, error: 'xai 400' }]), { delayMs: 100 }), /xai 400/);
  await sleep(120); assert.equal(log.length, 1, 'no duplicate after a real error');
  log = [];
  const { resp } = await hedged(fake(log)([{ ms: 60, error: 'reset' }, { ms: 80 }]), { delayMs: 20 });
  assert.equal(resp.id, 1);
});

test('no delay (a big new result) means no duplicate; a cancelled run aborts everything', async () => {
  const log = []; const { hedge } = await hedged(fake(log)([{ ms: 40 }]), { delayMs: null });
  assert.equal(hedge, null); assert.equal(log.length, 1);
  const ac = new AbortController(); const log2 = [];
  const p = hedged(fake(log2)([{ ms: Infinity }]), { signal: ac.signal, delayMs: 1000 });
  ac.abort(); await assert.rejects(p, /aborted/); assert.equal(log2[0].aborted, true);
});

test('hedgeDelay: floor, 2.5 × median, skipped for a big new result; 871dd136 turn 12 would have hedged at 8 s', () => {
  assert.equal(hedgeDelay([], 100), HEDGE_FLOOR_MS);
  assert.equal(hedgeDelay([{ latencyMs: 6000 }, { latencyMs: 4000 }, { latencyMs: 5000 }], 100), 12500);
  assert.equal(hedgeDelay([{ latencyMs: 2000 }], 80000), null);
  // the logged turns before the stall (latencies 1.3-3.4 s), and turn 12's small input
  const turns = [2062, 1064, 3351, 1844, 2200, 1900, 2400, 1700, 2600, 3351, 1844].map((latencyMs) => ({ latencyMs }));
  assert.equal(hedgeDelay(turns, 3676), HEDGE_FLOOR_MS);
});

test('xAI timing headers are read into the turn timing (ttft, e2e, inter-token, request id); absent headers add nothing', async () => {
  const { upstreamTiming } = await import('../xai.mjs');
  const h = new Headers({ 'x-metrics-ttft-ms': '295.3', 'x-metrics-e2e-ms': '2570.6', 'x-metrics-mean-itl-ms': '12.7', 'x-request-id': 'cd6edcc5' });
  assert.deepEqual(upstreamTiming(h), { xaiTtftMs: 295, xaiE2eMs: 2571, xaiItlMs: 13, xaiRequestId: 'cd6edcc5' });
  assert.deepEqual(upstreamTiming(new Headers({})), {});
});
