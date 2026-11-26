// fast_watch / fast_capture, extension side: the diff, the spec checks, and the outbox that
// never loses a batch across a dropped socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatchOutbox, MAX_PENDING_EVENTS } from '../src/watchOutbox.js';
import { stateOf, diffItems, checkDomSpec } from '../src/actions/watch.js';
import { checkCaptureSpec, requestMatches } from '../src/actions/capture.js';

function memStore() { const m = new Map(); return { m, get: async (k) => m.get(k), set: async (k, v) => { m.set(k, structuredClone(v)); } }; }

test('diff: add / change / remove by key, in list order', () => {
  const a = stateOf([{ id: '1', s: 'hi' }, { id: '2', s: 'yo' }], 'id');
  const b = stateOf([{ id: '3', s: 'new' }, { id: '1', s: 'hi again' }], 'id');
  assert.deepEqual(diffItems(a, b), [
    { kind: 'add', key: '3', index: 0, item: { id: '3', s: 'new' } },
    { kind: 'change', key: '1', index: 1, item: { id: '1', s: 'hi again' }, prev: { id: '1', s: 'hi' } },
    { kind: 'remove', key: '2', item: { id: '2', s: 'yo' } },
  ]);
  assert.deepEqual(diffItems(b, b), []);
});

test('diff without a key: identical rows are told apart, a changed row is remove + add', () => {
  const a = stateOf([{ text: 'x' }, { text: 'x' }]);
  assert.notEqual(a[0][0], a[1][0]);
  const b = stateOf([{ text: 'x' }, { text: 'x' }, { text: 'x' }]);
  assert.deepEqual(diffItems(a, b).map((e) => e.kind), ['add']);
  assert.deepEqual(diffItems(stateOf([{ text: 'a' }]), stateOf([{ text: 'b' }])).map((e) => e.kind), ['add', 'remove']);
});

test('dom spec checks', () => {
  assert.match(checkDomSpec({}).error, /needs `selector`/);
  assert.match(checkDomSpec({ selector: 'li', key: 'id' }).error, /not one of the fields/);
  assert.match(checkDomSpec({ selector: 'li', limit: 999 }).error, /limit/);
  assert.match(checkDomSpec({ selector: 'li', fields: { a: 1 } }).error, /strings/);
  assert.deepEqual(checkDomSpec({ selector: 'li', fields: { id: '@data-id', s: '.snip' }, key: 'id' }).spec,
    { selector: 'li', fields: { id: '@data-id', s: '.snip' }, key: 'id', limit: 50 });
});

test('capture spec and matching', () => {
  assert.match(checkCaptureSpec({}).error, /needs `url`/);
  const { spec } = checkCaptureSpec({ url: '/cart', method: 'post', origins: ['https://www.jewelosco.com'] });
  assert.equal(requestMatches(spec, 'https://www.jewelosco.com/abs/cart/x', 'POST'), true);
  assert.equal(requestMatches(spec, 'https://www.jewelosco.com/abs/cart/x', 'GET'), false);
  assert.equal(requestMatches(spec, 'https://evil.test/cart', 'POST'), false);
  assert.equal(requestMatches(spec, 'https://www.jewelosco.com/other', 'POST'), false);
  assert.match(checkCaptureSpec({ url: 'x', maxBody: 10 * 1024 * 1024 }).error, /maxBody/);
});

test('outbox: numbered batches, resent until acked, in order', async () => {
  const sent = [];
  let online = false;
  const st = memStore();
  const ob = createWatchOutbox({ storage: st, send: (f) => { if (online) sent.push(f); return online; } });
  await ob.push('w1', [{ kind: 'add' }]);
  await ob.push('w1', [{ kind: 'change' }]);
  assert.equal(sent.length, 0);
  online = true;
  await ob.flush();
  assert.deepEqual(sent.map((f) => f.n), [1, 2]);
  await ob.ack('w1', 1);
  sent.length = 0;
  await ob.flush();
  assert.deepEqual(sent.map((f) => [f.watchId, f.n, f.events[0].kind]), [['w1', 2, 'change']]);
  // a restarted worker reads the same unacked batches back
  const ob2 = createWatchOutbox({ storage: st, send: (f) => { sent.push(f); return true; } });
  sent.length = 0;
  await ob2.flush();
  assert.deepEqual(sent.map((f) => f.n), [2]);
  await ob2.push('w1', [{ kind: 'remove' }]);
  assert.equal(sent.at(-1).n, 3);
});

test('outbox: past the cap the oldest go and the first kept batch says how many', async () => {
  let online = false;
  const frames = [];
  const ob = createWatchOutbox({ storage: memStore(), send: (f) => { if (online) frames.push(f); return online; } });
  for (let i = 0; i < MAX_PENDING_EVENTS + 5; i++) await ob.push('w', [{ i }]);
  online = true;
  await ob.flush();
  assert.equal(frames.length, MAX_PENDING_EVENTS);
  assert.equal(frames[0].n, 6);
  assert.equal(frames[0].dropped, 5);
  assert.equal(frames[1].dropped, undefined);
});

test('outbox: watch_gone forgets the watch and tells its owner', async () => {
  const gone = [];
  const st = memStore();
  const ob = createWatchOutbox({ storage: st, send: () => true, onGone: (id) => gone.push(id) });
  await ob.push('w9', [{ kind: 'add' }]);
  await ob.gone('w9');
  assert.deepEqual(gone, ['w9']);
  assert.deepEqual(st.m.get('fastlink.watchOutbox'), {});
});
