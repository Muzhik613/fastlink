// node --test — the passive URL trail: extension ring (trail.js under a stubbed chrome.*).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const listeners = { updated: [], removed: [] };
let session = {};
globalThis.chrome = {
  tabs: {
    onUpdated: { addListener: (f) => listeners.updated.push(f) },
    onRemoved: { addListener: (f) => listeners.removed.push(f) },
  },
  storage: { session: { get: async (k) => ({ [k]: session[k] }), set: async (o) => { Object.assign(session, o); } } },
};
const { installTrail, trailOf, recordUrl } = await import('../../fast-ext/src/actions/trail.js');

test('onUpdated URL changes are stamped per tab, deduped when unchanged, ring-capped at 50, dropped on tab close', async () => {
  installTrail();
  assert.equal(listeners.updated.length, 1);
  const fire = (id, url) => listeners.updated[0](id, { url }, {});
  fire(7, 'https://a/');
  fire(7, 'https://a/');            // same URL twice → one entry
  fire(7, 'https://a/travel');
  fire(8, 'https://b/');
  const t7 = await trailOf(7);
  assert.deepEqual(t7.map(e => e.url), ['https://a/', 'https://a/travel']);
  assert.ok(t7.every(e => typeof e.t === 'number' && e.t > 0));
  for (let i = 0; i < 60; i++) recordUrl(9, `https://c/${i}`, 1000 + i);
  const t9 = await trailOf(9);
  assert.equal(t9.length, 50);
  assert.equal(t9[0].url, 'https://c/10');
  listeners.removed[0](7);
  assert.deepEqual(await trailOf(7), []);
  assert.deepEqual((await trailOf(8)).map(e => e.url), ['https://b/']);
});
