// callWatchdog + tabQueue cancel + connLog (fb#35: aliya secure 0.4.10, a call that
// answered nothing before the queue; the relay timed it out silently at 30 s).
import test from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = {
  storage: { local: {
    get: async (k) => ({ [k]: store[k] }),
    set: async (o) => { Object.assign(store, o); },
  } },
};

const { createCallWatch } = await import('../src/callWatchdog.js');
const { createTabQueue } = await import('../src/tabQueue.js');
const { connLog, CONN_LOG_KEY, MAX } = await import('../src/connLog.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LIM = { notStarted: 40, queued: 120, running: 60 };

test('a call that never starts answers call_timeout (not run) and is never run later', async () => {
  const logged = [];
  const w = createCallWatch({ log: (e) => logged.push(e), limits: LIM });
  let release;
  const preStep = new Promise((r) => { release = r; });   // e.g. a sealed pre-queue step that hangs
  let ran = false;
  const frames = [];
  const q = createTabQueue({ run: async () => { ran = true; return { result: 1 }; }, resolveTabId: async () => 1, send: (f) => { frames.push(f); w.progress(f); } });
  const t0 = Date.now();
  const reply = await w.run('c1', 'fast_sealed', async (ctl) => {
    await preStep;
    return q.submit({ id: 'c1', action: 'fast_switch', args: { tabId: 5 }, cancelled: ctl.timedOut });
  });
  assert.equal(reply.code, 'call_timeout');
  assert.equal(reply.phase, 'not_started');
  assert.match(reply.hint, /will not run later/);
  assert.ok(Date.now() - t0 < LIM.notStarted + 30);
  assert.deepEqual(logged.map((e) => [e.ev, e.action, e.phase]), [['call_timeout', 'fast_sealed', 'not_started']]);
  release();                               // the stuck step finally returns
  await wait(10);
  assert.equal(ran, false, 'the late call must not run');
  assert.ok(!frames.some((f) => f.type === 'started'));
  assert.equal(w.size(), 0);
});

test('a queued call gets the longer queued deadline; a cancelled queued job is dropped', async () => {
  const LIM = { notStarted: 40, queued: 200, running: 120 };
  const w = createCallWatch({ limits: LIM });
  const started = [];
  let releaseA;
  const q = createTabQueue({
    run: (action, args) => { started.push(args.n); return args.n === 'a' ? new Promise((r) => { releaseA = r; }) : Promise.resolve({ result: args.n }); },
    resolveTabId: async () => 1,
    send: (f) => w.progress(f),
    hardCapMs: 10_000,
  });
  const a = w.run('a', 'fast_click', (ctl) => q.submit({ id: 'a', action: 'fast_click', args: { tabId: 3, n: 'a' }, cancelled: ctl.timedOut }));
  const b = w.run('b', 'fast_click', (ctl) => q.submit({ id: 'b', action: 'fast_click', args: { tabId: 3, n: 'b' }, cancelled: ctl.timedOut }));
  await wait(LIM.notStarted + 20);         // past not-started: b is queued, so it is still waiting
  assert.equal(w.size(), 1 + 1);
  const ra = await a;                       // a started: running deadline (60) fires
  assert.equal(ra.phase, 'running');
  assert.match(ra.error, /did not finish/);
  const rb = await b;                       // b times out while queued
  assert.equal(rb.phase, 'queued');
  releaseA({ result: 'a' });
  await wait(10);
  assert.deepEqual(started, ['a'], 'b was answered by the watchdog, so it never runs');
});

test('a normal call passes its reply through and clears its timer', async () => {
  const w = createCallWatch({ limits: LIM });
  const q = createTabQueue({ run: async (_a, args) => ({ result: args.v }), resolveTabId: async () => 1, send: (f) => w.progress(f) });
  const r = await w.run('x', 'fast_tab', (ctl) => q.submit({ id: 'x', action: 'fast_tab', args: { v: 7 }, cancelled: ctl.timedOut }));
  assert.deepEqual(r, { result: 7 });
  assert.equal(w.size(), 0);
});

test('a started call is timed from started, not from arrival', async () => {
  const w = createCallWatch({ limits: { notStarted: 30, queued: 120, running: 80 } });
  const p = w.run('s', 'fast_click', async () => {
    await wait(20);
    w.progress({ type: 'started', id: 's' });
    await wait(40);                         // 60 ms after arrival: past notStarted, within running
    return { result: 'ok' };
  });
  assert.deepEqual(await p, { result: 'ok' });
});

test('connLog keeps the last MAX entries, scalars only, token-shaped text redacted', async () => {
  delete store[CONN_LOG_KEY];
  connLog('close', { code: 1006, wasClean: false, reason: 'x?token=SECRET123&a=1', obj: { no: 1 }, url: undefined });
  await wait(1100);
  let list = store[CONN_LOG_KEY];
  assert.equal(list.length, 1);
  const { t, ...e } = list[0];
  assert.ok(Number.isFinite(t));
  assert.deepEqual(e, { ev: 'close', code: 1006, wasClean: false, reason: 'x?token=***&a=1' });
  for (let i = 0; i < MAX + 5; i++) connLog({ ev: 'redial', inMs: i });
  await wait(1100);
  list = store[CONN_LOG_KEY];
  assert.equal(list.length, MAX);
  assert.equal(list.at(-1).inMs, MAX + 4);
});
