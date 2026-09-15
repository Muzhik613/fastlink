// node --test — the passive URL trail: extension ring (trail.js under a stubbed
// chrome.*) and the bench's reconstruction from fast_list (monitor.js mergeTrail).
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
const { mergeTrail } = await import('../../bench/monitor.js');

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

test('mergeTrail: a 2s stop between two 3s polls is reconstructed from timestamps; baseline entries stay unseen; a trail-less tab contributes its URL', () => {
  const seen = new Set(); const events = [];
  const baseline = [{ id: 1, url: 'https://x/', trail: [{ t: 10, url: 'https://x/' }] }];
  mergeTrail(baseline, [], seen);                    // baseline poll: seen, not recorded
  const poll1 = [{ id: 1, url: 'https://x/', trail: [{ t: 10, url: 'https://x/' }] },
                 { id: 2, url: 'https://books/catalogue/p1', trail: [
                   { t: 100, url: 'https://books/' },
                   { t: 2100, url: 'https://books/category/books/travel' },   // the 2s stop no poll observed live
                   { t: 4100, url: 'https://books/catalogue/p1' } ] }];
  assert.equal(mergeTrail(poll1, events, seen), 3);
  assert.deepEqual(events.map(e => e.url), ['https://books/', 'https://books/category/books/travel', 'https://books/catalogue/p1']);
  assert.equal(mergeTrail(poll1, events, seen), 0);   // same list again: nothing new
  assert.equal(mergeTrail([{ id: 3, url: 'https://old-ext/' }], events, seen), 1);
  assert.equal(events[0].url, 'https://old-ext/');    // t:0 sorts first; still evidence
});
