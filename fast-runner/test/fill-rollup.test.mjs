// node --test — fast_fill's honesty contract (page.js commitGate / rollUpFill),
// sliced from the source so there is one source of truth.
// Live bug: fast_fill {fields:{"Promotion name":"Spring Rail Sale","Zones":"Zone No.2"}}
// returned {"verified":true,"filled":2,"missed":0,…,"uncommitted":["Zones"]} while
// the page's Zones value was "": text typed into a combobox, no option picked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');
const slice = (name) => { const i = src.indexOf(`const ${name} =`); assert.ok(i >= 0, name); const j = src.indexOf('\n};\n', i); return src.slice(i, j + 3); };
const { commitGate, rollUpFill } = new Function(`${slice('commitGate')}\n${slice('rollUpFill')}\nreturn { commitGate, rollUpFill };`)();

const SELECT_HINT = 'this is a select control (field "Zones"); use fast_select_option {field:"Zones", option:"<choice>"} instead of clicking/typing its value';
const AC = { committed: false, suggestions: ['Zone No.1', 'Zone No.2'], hint: 'autocomplete is open; pick a suggestion' };

// the per-field merge page.js does: read-back, then the suggestions report, then the write
const field = (readBack, ac, r) => commitGate({ ...readBack, ...(ac || {}), ...r }, ac);

test('the live shape: a held text field + a combobox with typed text and no pick → verified:false everywhere', () => {
  const fields = {
    'Promotion name': field({ verified: true, value: 'Spring Rail Sale' }, null, { filled: { tag: 'input', label: 'Promotion name' }, valueSet: 'Spring Rail Sale' }),
    Zones: field({ verified: true, value: 'Zone No.2' }, AC, { filled: { tag: 'input', label: 'Zones' }, valueSet: 'Zone No.2', hint: SELECT_HINT }),
  };
  const head = rollUpFill(fields, 2);
  assert.equal(head.verified, false, 'top-level verified must be false when any field is uncommitted');
  assert.equal(head.filled, 2);
  assert.equal(head.missed, 0);
  assert.deepEqual(head.uncommitted, ['Zones']);
  assert.equal(head.reverted, undefined, 'uncommitted is its own failure, not double-counted as reverted');
  assert.match(head.summary, /^1\/2 verified; typed but no option picked \(NOT set\): Zones$/);
  assert.match(head.hint, /fast_select_option/);
  // the field itself reads as a failure
  assert.equal(fields.Zones.verified, false);
  assert.equal(fields.Zones.committed, false);
  assert.match(fields.Zones.reason, /no option was picked/);
  assert.equal(fields.Zones.hint, SELECT_HINT);
  assert.equal(Object.keys(fields.Zones)[0], 'verified', 'verified stays the first key the model reads');
  assert.equal(fields['Promotion name'].verified, true);
});

test('single-field form: an uncommitted autocomplete write is verified:false', () => {
  const head = field({ verified: true, value: 'Chicago' }, AC, {});
  assert.equal(head.verified, false);
  assert.match(head.reason, /"Chicago"/);
});

test('a committed pick / non-autocomplete write keeps its read-back verdict', () => {
  assert.equal(commitGate({ verified: true, value: 'x' }, null).verified, true);
  assert.equal(commitGate({ verified: true, value: 'x' }, { committed: true }).verified, true);
  assert.equal(commitGate({ verified: false, value: 'y', reason: 'r' }, null).reason, 'r');
});

test('missed, reverted and clean fields roll up; all clean → verified:true with no summary', () => {
  const ok = { verified: true, value: 'a' };
  assert.deepEqual(rollUpFill({ A: ok, B: { ...ok } }, 2), { verified: true, filled: 2, missed: 0, total: 2 });
  const head = rollUpFill({ A: ok, B: { error: 'No visible fillable element matching "B"' }, C: { verified: false, value: 'z', reason: 'reformatted' } }, 3);
  assert.equal(head.verified, false);
  assert.equal(head.filled, 2);
  assert.equal(head.missed, 1);
  assert.deepEqual(head.reverted, ['C']);
  assert.equal(head.summary, '1/3 verified; missed: B; did not hold: C');
  // a field that read back nothing at all (no verified key) is not a success either
  assert.equal(rollUpFill({ A: { value: '' } }, 1).verified, false);
});

test('page.js wires both forms through commitGate and the {fields} head through rollUpFill', () => {
  assert.match(src, /const head = commitGate\(\{ \.\.\.verifyOne\(sp, el, r\), \.\.\.\(ac \|\| \{\}\) \}, ac\);/);
  assert.match(src, /fields\[sp\.match\] = commitGate\(\{ \.\.\.verifyOne\(sp, el, r\), \.\.\.\(ac \|\| \{\}\), \.\.\.r \}, ac\);/);
  assert.match(src, /const head = rollUpFill\(fields, specs\.length\);/);
});
