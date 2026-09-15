// node --test — the two holdout overclaims (docs/GROK_RUNNER_HOLDOUT_2026-09-15.md),
// replayed through the report_done gate (mode on). Same calls and args as the
// baseline runs (hvm runs.jsonl 245d4c2b h_combobox, ce062850 h_repeat); results in
// two versions: the BASELINE tools' (key fields as recorded — the gate accepted
// both), and the FIXED tools' for the same calls (fixes 3-6 of 2026-09-15: select
// ambiguity refused, explicit role, index/section on fast_select_option, repeated
// rows refused, wrapper verified = AND of children, batch step ok only when clean).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordResult, entryFacts, reportDone } from '../runner.mjs';

function runOf(rows) {
  const run = { gate: 'on', toolLog: [], corpus: [], urlTrail: [], gateRefusals: [], turns: [] };
  rows.forEach(([name, args, result], i) => {
    const text = JSON.stringify(result);
    const ok = recordResult(run, text, false);
    run.toolLog.push({ t: i * 1000, name, args, ok, preview: text.slice(0, 100), ...entryFacts(name, args, text, ok) });
  });
  return run;
}

// ── h_combobox (245d4c2b) ──────────────────────────────────────────────────
const S2 = 'https://select2.org/getting-started/basic-usage/';
const S2_SNAP = { url: S2, items: [{ i: 142, tag: 'select', text: 'Alaska Hawaii California Nevada Oregon', value: 'Alaska' }], content: [{ text: 'Single select boxes¶' }] };
const s2Calls = (click, select) => [
  ['fast_tab', { url: 'https://select2.org/getting-started/basic-usage' }, { id: 1, url: S2, targetTab: 1 }],
  ['fast_snapshot', { full: true, limit: 100 }, S2_SNAP],
  ['fast_click', { text: 'Alaska', role: 'combobox', index: 0 }, click],
  ['fast_select_option', { field: 'Single select boxes¶', option: 'Oregon' }, select],
  ['fast_snapshot', { full: true, limit: 20 }, S2_SNAP],
];
const S2_REPORT = { result: 'Selected "Oregon" in the Single select boxes example (native select value="Oregon").', evidence: `value="Oregon" on the select element (item i:142) in ${S2}` };

test('h_combobox baseline: the gate accepted the twin-select overclaim', () => {
  const run = runOf(s2Calls(
    { clicked: { i: 142, tag: 'select', value: 'Alaska' }, url: S2, urlChanged: false, selectField: { tag: 'select', section: 'Single select boxes¶' } },
    { verified: true, picked: 'Oregon', value: 'Oregon', field: { tag: 'select', section: 'Single select boxes¶' }, kind: 'native-select' },
  ));
  assert.ok(reportDone(run, S2_REPORT, 9000).finish, 'baseline passed the gate');
});

test('h_combobox with the fixed tools: the ambiguous select is an error, so the same report is refused', () => {
  const run = runOf(s2Calls(
    // explicit role:"combobox" now reaches the [role=combobox] Select2 widget, not the implicit-combobox twin
    { clicked: { i: 150, tag: 'span', role: 'combobox', text: 'Alaska' }, url: S2, urlChanged: false },
    { error: '2 visible dropdown(s) match "Single select boxes¶" — nothing was selected',
      candidates: [
        { tag: 'select', label: null, section: 'Single select boxes', visible: true, value: 'Alaska', index: 0 },
        { tag: 'span', role: 'combobox', label: 'Alaska', section: 'Single select boxes', visible: true, value: 'Alaska', index: 1, backing: 'hidden <select> behind this widget' },
      ],
      hint: 'pass index:N (0..1, the VISIBLE candidates in document order — each candidate names its row/section) or section:"<heading>" to pick one' },
  ));
  const v = reportDone(run, S2_REPORT, 9000);
  assert.ok(v.refuse, 'refused');
  const p = v.refuse.join(' | ');
  assert.match(p, /your last attempt to fast_select_option "Single select boxes¶" failed and was never retried/);
});

// ── h_repeat (ce062850) ────────────────────────────────────────────────────
const FIO = 'https://formio.github.io/formio.js/app/examples/datagrid.html';
const FIO_SNAP = { url: FIO, items: [{ tag: 'input', label: 'First Name', value: 'Ada' }, { tag: 'input', label: 'Last Name', value: 'Lovelace' }, { tag: 'input', label: 'Birthdate', value: '2015-12-10 __:__ __' }], content: [{ text: 'Children' }] };
const BATCH = { actions: [
  { name: 'fast_fill', args: { fields: { 'First Name': 'Ada', 'Last Name': 'Lovelace' }, index: 2, section: 'Children' } },
  { name: 'fast_select_option', args: { field: 'Gender', option: 'Female', index: 2 } },
  { name: 'fast_fill', args: { match: 'Dependant', value: 'true', index: 2 } },
] };
const SEC_MISS = { error: 'section "Children" not found — no heading/legend/[role=heading] on this page matches it, so the field was NOT filled', sections: ['Data Grid Input', 'Result'] };
const FILL_MISS = { verified: false, filled: 0, missed: 2, total: 2, summary: '0/2 filled; missed: First Name, Last Name', fields: { 'First Name': SEC_MISS, 'Last Name': SEC_MISS } };
const repeatCalls = (v) => [
  ['fast_tab', { url: FIO }, { id: 2, url: FIO, targetTab: 2 }],
  ['fast_snapshot', { full: true }, FIO_SNAP],
  ['fast_click', { text: 'Add Another', index: 0 }, { clicked: { tag: 'button', text: 'Add Another' }, url: FIO, urlChanged: false }],
  ['fast_batch', BATCH, v.batch],
  ['fast_fill', { fields: { 'First Name': 'Ada', 'Last Name': 'Lovelace' }, index: 2 },
    { verified: true, filled: 2, missed: 0, total: 2, fields: { 'First Name': { verified: true, value: 'Ada' }, 'Last Name': { verified: true, value: 'Lovelace' } } }],
  ['fast_select_option', { field: 'Gender', option: 'Female', selections: { Gender: 'Female' }, noSnapshot: false }, v.gender1],
  ['fast_select_option', { field: 'Gender', option: 'Female', selections: { Gender: 'Female' } }, v.gender2],
  ['fast_fill', { match: 'Birthdate', value: '2015-12-10', index: 2 }, { error: 'Only 1 fillable match(es) for "Birthdate" (1 visible, 0 offscreen), index 2 out of range' }],
  ['fast_fill', { match: 'Birthdate', value: '2015-12-10', index: 2 }, { error: 'Only 1 fillable match(es) for "Birthdate" (1 visible, 0 offscreen), index 2 out of range' }],
  ['fast_snapshot', { full: true, limit: 100 }, FIO_SNAP],
  ['fast_scroll', { to: 'bottom' }, { scrolled: true }],
  ['fast_click', { text: 'Female', index: 2 }, { clicked: { tag: 'div', role: 'combobox' }, url: FIO, urlChanged: false }],
  ['fast_fill', { match: 'Birthdate', value: '2015-12-10' }, v.birthdate],
  ['fast_snapshot', { full: true, limit: 30 }, FIO_SNAP],
];
const REPEAT_REPORT = {
  result: 'Third row values: First Name=Ada, Last Name=Lovelace, Gender=Female, Dependant=true (ticked), Birthdate=2015-12-10 __:__ __ (first two rows unchanged).',
  evidence: `Ada (value for data[children][2][firstName]) Lovelace (data[children][2][lastName]) 2015-12-10 __:__ __ (Birthdate) at ${FIO}`,
};

test('h_repeat baseline: the gate accepted it (batch "3/3 steps ok", wrapper verified:true over a verified:false pick, an unverified write to Joe\'s row)', () => {
  const run = runOf(repeatCalls({
    batch: { summary: '3/3 steps ok', ok: 3, missed: 0, steps: 3, results: [
      { step: 0, name: 'fast_fill', ok: true, result: FILL_MISS },
      // steps 1-2: their values are past the stored 1200-char preview; the summary counted them ok
      { step: 1, name: 'fast_select_option', ok: true, result: {} },
      { step: 2, name: 'fast_fill', ok: true, result: {} },
    ] },
    gender1: { verified: true, picked: 1, failed: 0, total: 1, results: { Gender: { verified: false, picked: 'FemaleRemove item', reason: 'the pick did not take' } } },
    gender2: { verified: true, picked: 1, failed: 0, total: 1, results: { Gender: { verified: true, picked: 'Female' } } },
    birthdate: { verified: false, value: '2015-12-10 __:__ __', reason: 'the field now reads "2015-12-10 __:__ __" instead of the value written', filled: { tag: 'input', label: 'Birthdate' } },
  }));
  assert.ok(reportDone(run, REPEAT_REPORT, 40000).finish, 'baseline passed the gate');
});

test('h_repeat with the fixed tools: honest wrappers + refused row-ambiguous writes → the same report is refused', () => {
  const GENDER_AMBIG = { error: '3 visible dropdown(s) match "Gender" — nothing was selected', candidates: [
    { tag: 'div', role: 'combobox', label: 'Gender', visible: true, value: 'Male', index: 0, row: 0, rows: 3, rowFirst: 'Joe' },
    { tag: 'div', role: 'combobox', label: 'Gender', visible: true, value: 'Female', index: 1, row: 1, rows: 3, rowFirst: 'Mary' },
    { tag: 'div', role: 'combobox', label: 'Gender', visible: true, value: '', index: 2, row: 2, rows: 3, rowFirst: 'Ada' },
  ] };
  const run = runOf(repeatCalls({
    batch: { summary: '2/3 steps ok; step 0 (fast_fill "First Name,Last Name") not verified: 0/2 filled; missed: First Name, Last Name', ok: 2, missed: 1, steps: 3, results: [
      { step: 0, name: 'fast_fill', ok: false, result: FILL_MISS },
      { step: 1, name: 'fast_select_option', ok: true, result: { verified: true, picked: 'Female', value: 'Female', row: { row: 2, rows: 3, rowFirst: 'Ada' } } },
      { step: 2, name: 'fast_fill', ok: true, result: { verified: true, value: 'checked', checked: true, filled: { tag: 'input', type: 'checkbox', label: 'Dependant', row: { row: 2, rows: 3, rowFirst: 'Ada' } } } },
    ] },
    gender1: { verified: false, picked: 0, failed: 1, total: 1, summary: '0/1 selected; not done: Gender', results: { Gender: GENDER_AMBIG } },
    gender2: { verified: false, picked: 0, failed: 1, total: 1, summary: '0/1 selected; not done: Gender', results: { Gender: GENDER_AMBIG } },
    birthdate: { error: '2 visible field(s) match "Birthdate" — nothing was filled', candidates: [
      { label: 'Birthdate', value: '1982-05-18 12:00 AM', index: 0, visible: true, row: 0, rows: 3, rowFirst: 'Joe' },
      { label: 'Birthdate', value: '', index: 1, visible: true, row: 2, rows: 3, rowFirst: 'Ada' },
    ] },
  }));
  const gender = run.toolLog[5];
  assert.deepEqual(gender.partial, [{ name: 'fast_select_option', target: 'Gender' }], 'the wrapper\'s child failure is a partial');
  const v = reportDone(run, REPEAT_REPORT, 40000);
  assert.ok(v.refuse, 'refused');
  const p = v.refuse.join(' | ');
  assert.match(p, /fast_select_option "Gender" failed and was never retried/);
  assert.match(p, /fast_fill "Birthdate" failed and was never retried/);
});
