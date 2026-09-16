// node --test — fast_batch step semantics against a fake extension (no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBatch, isSelectorProbe, notVerified } from '../../fast-dxt/server/batch.js';
import { readFileSync } from 'node:fs';

const fake = (script) => {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === 'fast_list') return { result: [{ targetTab: true, url: 'https://x/' }] };
    if (name === 'fast_evaluate') return { result: 'complete' };
    const fn = script[name];
    return fn ? fn(args, calls) : { result: { ok: true, snapshot: { items: [] } } };
  };
  return { call, calls };
};

test('every step runs; summary leads; misses keep candidates; only the last step keeps a snapshot', async () => {
  const io = fake({
    fast_fill: (a) => a.match === 'Ocean'
      ? { error: 'No visible fillable element matching "Ocean"', candidates: [{ label: 'Single' }], hint: 'use fast_select_option' }
      : { result: { verified: true, value: a.value, snapshot: { items: [1] }, snapshotFresh: true } },
  });
  const r = await runBatch({ actions: [
    { name: 'fast_fill', args: { match: 'Name', value: 'A' } },
    { name: 'fast_fill', args: { match: 'Ocean', value: 'Forest' } },
    { name: 'fast_fill_form', args: { fields: { City: 'B' } } },
  ] }, io);
  assert.equal(r.summary, '2/3 steps ok; step 1 (fast_fill "Ocean") missed: No visible fillable element matching "Ocean"');
  assert.equal(r.ok, 2); assert.equal(r.missed, 1); assert.equal(r.steps, 3);
  assert.equal(r.results.length, 3, 'did not abort on the miss');
  assert.equal(r.results[1].ok, false); assert.deepEqual(r.results[1].candidates, [{ label: 'Single' }]);
  assert.equal(r.results[2].name, 'fast_fill', 'fill_form step rewritten to fast_fill');
  assert.equal(io.calls.filter(c => c.name === 'fast_fill').length, 3);
  assert.equal(io.calls[0].args.noSnapshot, true, 'intermediate step: no snapshot');
  assert.equal(io.calls.at(-1).args.noSnapshot, undefined, 'last step keeps its snapshot');
  assert.ok(!('snapshot' in r.results[0].result) && 'snapshot' in r.results[2].result);
  assert.equal(r.results[0].result.verified, true, 'verified state survives the strip');
});

test('ifFound branches inside the batch via one fast_wait probe; selector vs text auto-detected', async () => {
  let seen = [];
  const io = fake({
    fast_wait: (a) => { seen.push(a); return a.text === 'Cookie banner' ? { result: { found: { text: 'Cookie banner' } } } : { error: 'Timed out' }; },
    fast_click: (a) => ({ result: { clicked: a.text } }),
  });
  const r = await runBatch({ actions: [
    { ifFound: 'Cookie banner', then: [{ name: 'fast_click', args: { text: 'Accept' } }], else: [{ name: 'fast_click', args: { text: 'never' } }] },
    { ifFound: '#missing', waitMs: 5, then: [{ name: 'fast_click', args: { text: 'never' } }], else: [{ name: 'fast_click', args: { text: 'Fallback' } }] },
    { name: 'fast_click', args: { text: 'Submit' } },
  ] }, io);
  assert.deepEqual(seen.map(a => [a.text, a.selector, a.timeoutMs, a.noSnapshot]), [['Cookie banner', undefined, 1000, true], [undefined, '#missing', 5, true]]);
  assert.equal(r.results[0].branch, 'then'); assert.equal(r.results[0].found, true);
  assert.equal(r.results[1].branch, 'else'); assert.equal(r.results[1].found, false);
  assert.deepEqual(io.calls.filter(c => c.name === 'fast_click').map(c => c.args.text), ['Accept', 'Fallback', 'Submit']);
  assert.equal(r.summary, '3/3 steps ok');
  assert.ok(isSelectorProbe('#id') && isSelectorProbe('.cls') && isSelectorProbe('[role=dialog]') && isSelectorProbe('div > a'));
  assert.ok(!isSelectorProbe('Accept all') && !isSelectorProbe('Workers & Pages'));
});

test('an emptyContainer probe counts as not found; gate refusals are misses; nav settle still runs after a navigating step', async () => {
  const io = fake({
    fast_wait: () => ({ result: { found: { text: 'x' }, emptyContainer: true } }),
    fast_click: () => ({ result: { clicked: 1, willNavigate: true } }),
  });
  const gate = (s) => (s.name === 'fast_status' ? { error: 'diagnostic-only' } : null);
  const r = await runBatch({ actions: [
    { ifFound: 'x', then: [{ name: 'fast_status' }], else: [{ name: 'fast_status' }] },
    { name: 'fast_click', args: { text: 'Go' } },
    { name: 'fast_snapshot' },
  ] }, { ...io, gate });
  assert.equal(r.results[0].branch, 'else');
  assert.equal(r.results[0].results[0].error, 'diagnostic-only');
  assert.equal(r.ok, 2); assert.equal(r.missed, 1);
  assert.ok(io.calls.some(c => c.name === 'fast_list'), 'URL captured around the navigating click');
});

test('a step is ok only when its own result is clean: verified:false / missed / failed inside it make it ok:false, named in the summary', async () => {
  const io = fake({
    fast_fill: (a) => a.fields
      ? { result: { verified: false, filled: 0, missed: 2, total: 2, summary: '0/2 filled; missed: First Name, Last Name', fields: { 'First Name': { error: 'section "Children" not found' }, 'Last Name': { error: 'section "Children" not found' } } } }
      : { result: { verified: false, value: '2015-12-10 __:__ __', reason: 'the field now reads "2015-12-10 __:__ __"' } },
    fast_select_option: () => ({ result: { verified: false, picked: 0, failed: 1, total: 1, results: { Gender: { error: '3 visible dropdown(s) match "Gender"' } } } }),
    fast_click: () => ({ result: { clicked: { text: 'Add Another' } } }),
  });
  const r = await runBatch({ actions: [
    { name: 'fast_click', args: { text: 'Add Another' } },
    { name: 'fast_fill', args: { fields: { 'First Name': 'Ada', 'Last Name': 'Lovelace' }, section: 'Children' } },
    { name: 'fast_select_option', args: { selections: { Gender: 'Female' } } },
    { name: 'fast_fill', args: { match: 'Birthdate', value: '2015-12-10' } },
  ] }, io);
  assert.equal(r.ok, 1); assert.equal(r.missed, 3); assert.equal(r.steps, 4);
  assert.match(r.summary, /^1\/4 steps ok; step 1 \(fast_fill "First Name,Last Name"\) not verified: 0\/2 filled; missed: First Name, Last Name \| step 2 \(fast_select_option "Gender"\) not verified: 1 of 1 not done \| step 3 \(fast_fill "Birthdate"\) not verified: the field now reads/);
  assert.deepEqual(r.results.map(x => x.ok), [true, false, false, false]);
  assert.equal(r.results[1].result.fields['First Name'].error, 'section "Children" not found', 'the unverified step keeps its result');
  assert.equal(notVerified({ verified: true, filled: 2, missed: 0 }), null);
  assert.equal(notVerified({ clicked: 1 }), null, 'a result with no verified field is clean');
  assert.match(notVerified({ verified: false, checked: false, reason: 'the radio is still not selected' }), /radio is still not selected/);
});

test('relay mirror of batch.js is byte-identical', () => {
  assert.equal(readFileSync(new URL('../../fast-dxt/server/batch.js', import.meta.url), 'utf8'), readFileSync(new URL('../../fastlink-relay/src/batch.js', import.meta.url), 'utf8'));
});
