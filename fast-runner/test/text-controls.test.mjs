// node --test — fast_text (fast-ext/src/actions/text.js extractText) on form controls, against a
// synthetic DOM; the page function is sliced from text.js so there is one source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../fast-ext/src/actions/text.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('export function extractText')).replace('export ', '');
const load = (document) => new Function('document', `${body}\nreturn extractText;`)(document);

// minimal element: tagName, attributes, value/text, labels, inner controls
const el = (tag, { attrs = {}, value, text = '', type, checked, labels, inner, options, multiple } = {}) => ({
  tagName: tag.toUpperCase(), id: attrs.id || '', type, checked, value, multiple: !!multiple,
  innerText: text, textContent: text, labels: labels || null,
  getAttribute: (k) => (k in attrs ? attrs[k] : null),
  querySelector: () => inner || null,
  selectedOptions: options ? options.filter(o => o.selected) : undefined,
  outerHTML: `<${tag}>`,
});
const doc = (matches, byId = {}) => ({ querySelectorAll: () => matches, body: el('body', { text: 'page body' }), getElementById: (id) => byId[id] || null });
const read = (matches, sel = '#x', byId) => JSON.parse(load(doc(matches, byId))(sel, null, false));

test('an <input> reads as its live value, with field {tag, label, value} (Maps Destination, run 61581163)', () => {
  const dest = el('input', { attrs: { 'aria-label': 'Destination Times Square, New York', placeholder: 'Choose destination, or click on the map...' }, value: 'Times Square, Manhattan, NY 10036' });
  const r = read([dest], '[aria-label*="Destination"]');
  assert.equal(r.text, 'Times Square, Manhattan, NY 10036');
  assert.equal(r.kind, 'value');
  assert.deepEqual(r.field, { tag: 'input', label: 'Destination Times Square, New York', value: 'Times Square, Manhattan, NY 10036' });
  assert.equal(r.empty, undefined);
  assert.equal(Object.keys(r)[0], 'truncated');
});

test('control detection: textarea, select, contenteditable, role=combobox|textbox|searchbox; a div is not a control', () => {
  assert.equal(read([el('textarea', { value: 'notes here' })]).field.value, 'notes here');
  const sel = el('select', { attrs: { name: 'cabin' }, value: 'J', options: [{ text: 'Economy', value: 'Y' }, { text: ' Business / First ', value: 'J', selected: true }] });
  assert.deepEqual(read([sel]).field, { tag: 'select', label: 'cabin', value: 'Business / First', optionValue: 'J' });
  assert.equal(read([el('div', { attrs: { contenteditable: 'true' }, text: 'draft body' })]).field.value, 'draft body');
  assert.equal(read([el('div', { attrs: { contenteditable: 'false' }, text: 'plain' })]).kind, 'innerText');
  for (const role of ['combobox', 'textbox', 'searchbox']) assert.equal(read([el('div', { attrs: { role }, text: 'Ocean' })]).kind, 'value', role);
  // a role=combobox wrapper reads the control inside it
  assert.equal(read([el('div', { attrs: { role: 'combobox' }, inner: el('input', { value: 'Forest' }) })]).field.value, 'Forest');
  assert.equal(read([el('div', { text: 'Hello' })]).text, 'Hello');
  assert.equal(read([el('div', { attrs: { role: 'button' }, text: 'Go' })]).field, undefined);
});

test('labels: aria-label, aria-labelledby, <label>, then placeholder / name / id; checkbox carries checked; passwords masked', () => {
  const byId = { h: el('span', { text: 'Leaving from' }) };
  assert.equal(read([el('input', { attrs: { 'aria-labelledby': 'h' }, value: 'JFK' })], '#x', byId).field.label, 'Leaving from');
  assert.equal(read([el('input', { labels: [el('label', { text: 'Text input' })], value: 'a' })]).field.label, 'Text input');
  assert.equal(read([el('input', { attrs: { placeholder: 'mm/dd/yyyy' }, value: '10/15/2026' })]).field.label, 'mm/dd/yyyy');
  // a <label> wrapping its <select> (selenium web-form): the label's own text, not the options
  const wrapped = el('select', { value: '2', text: 'Open this select menu\nOne\nTwo', options: [{ text: 'Two', value: '2', selected: true }] });
  const wrap = { innerText: 'Dropdown (select)\nOpen this select menu\nOne\nTwo', contains: (n) => n === wrapped, childNodes: [{ textContent: '\n  Dropdown (select)\n  ' }, wrapped] };
  wrapped.labels = [wrap];
  assert.deepEqual(read([wrapped]).field, { tag: 'select', label: 'Dropdown (select)', value: 'Two', optionValue: '2' });
  assert.deepEqual(read([el('input', { type: 'checkbox', attrs: { id: 'c1' }, value: 'on', checked: true })]).field, { tag: 'input', label: 'c1', value: 'on', checked: true });
  assert.equal(read([el('input', { type: 'password', value: 'hunter2' })]).text, '•••••••');
});

test('several matches: every control listed with its value; text is one "label: value" line each', () => {
  const r = read([el('input', { attrs: { name: 'orig' }, value: 'JFK' }), el('input', { attrs: { name: 'dest' }, value: 'LAX' }),
    el('select', { attrs: { name: 'count' }, value: '2', options: [{ text: '2', value: '2', selected: true }] })], 'input[name="orig"], input[name="dest"], select[name="count"]');
  assert.equal(r.text, 'orig: JFK\ndest: LAX\ncount: 2');
  assert.equal(r.matches, 3);
  assert.deepEqual(r.fields.map(f => f.value), ['JFK', 'LAX', '2']);
});

test('an empty read says empty:true with the not-confirmation hint — control or not', () => {
  const HINT = 'the element has no text; if it is a form field its value is in value (shown here) — an empty read is not confirmation';
  const blank = read([el('input', { attrs: { 'aria-label': 'Destination' }, value: '' })]);
  assert.equal(blank.empty, true);
  assert.equal(blank.hint, HINT);
  assert.deepEqual(blank.field, { tag: 'input', label: 'Destination', value: '' });
  const div = read([el('div', { text: '   ' })]);
  assert.equal(div.empty, true);
  assert.equal(div.hint, HINT);
  assert.equal(read([el('div', { text: 'x' })]).empty, undefined);
});

test('unchanged: body default, html:true, not-found error, truncation first', () => {
  const run = load(doc([el('input', { value: 'v' })]));
  assert.equal(JSON.parse(run(null, null, false)).text, 'page body');
  assert.equal(JSON.parse(run('#x', null, true)).kind, 'outerHTML');
  assert.match(JSON.parse(load(doc([]))('#nope', null, false)).error, /not found/);
  const t = JSON.parse(load(doc([el('div', { text: 'abcdef' })]))('#x', 3, false));
  assert.deepEqual([t.truncated, t.text, t.dropped.chars], [true, 'abc', 3]);
});
