// node --test — fast_fill miss hints: which button a "section with no input yet"
// hint names (rankCreateButtons) and which hint heads a miss result (missHead),
// sliced from page.js so there is one source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');
const block = (name) => { const i = src.indexOf(`const ${name} =`); const j = src.indexOf('\n};\n', i); return src.slice(i, j + 3); };
const line = (name) => { const i = src.indexOf(`const ${name} =`); return src.slice(i, src.indexOf('\n', i)); };
const { rankCreateButtons, missHead, explainedMiss } = new Function(
  `${line('CREATE_WORD')}\n${line('NOT_CREATE_WORD')}\n${block('rankCreateButtons')}\n${line('explainedMiss')}\n${block('missHead')}\nreturn { rankCreateButtons, missHead, explainedMiss };`)();
const names = (btns) => rankCreateButtons(btns).map(b => b.name);

test('section buttons: an add/new/create/+ button outranks a help icon listed first', () => {
  // gcpform recording #4: ["Help with Javascript origins", "Add URI"] named the help icon
  const r = rankCreateButtons([
    { name: 'Help with Javascript origins', text: 'help_outline', iconOnly: true, tooltip: true },
    { name: 'Add URI', text: 'Add URI', iconOnly: false, tooltip: false },
  ]);
  assert.deepEqual(r.map(b => b.name), ['Add URI', 'Help with Javascript origins']);
  assert.equal(r[0].demoted, false);
  assert.equal(r[1].demoted, true);
  // local page: a "?" help button before "Add email"
  assert.deepEqual(names([{ name: '?', text: '?', iconOnly: false, tooltip: true }, { name: 'Add email', text: 'Add email' }]).slice(0, 1), ['Add email']);
  // a bare "+" glyph, "New item", "Create", "Insert row" all rank as creators
  for (const n of ['+', '＋ Row', 'New item', 'Create', 'Insert row', 'Append']) assert.equal(rankCreateButtons([{ name: 'Details', text: 'Details' }, { name: n, text: n }])[0].name, n, n);
  // word boundaries: "Address book" / "Renew" are not "add" / "new"
  assert.deepEqual(names([{ name: 'Address book', text: 'Address book' }, { name: 'Renew', text: 'Renew' }]), ['Address book', 'Renew']);
  assert.equal(rankCreateButtons([{ name: 'Address book', text: 'Address book' }])[0].tier, 1);
});

test('section buttons: text beats icon-only; help/info/close/remove/delete sink and are flagged demoted', () => {
  assert.deepEqual(names([{ name: 'Settings', text: '', iconOnly: true }, { name: 'Upload file', text: 'Upload file' }]), ['Upload file', 'Settings']);
  for (const n of ['Learn more', 'More info', 'Close', 'Remove item', 'Delete', 'Clear', 'Cancel', 'Show tooltip']) {
    const r = rankCreateButtons([{ name: n, text: n }, { name: 'Upload file', text: 'Upload file' }]);
    assert.equal(r[0].name, 'Upload file', n);
    assert.equal(r[1].demoted, true, n);
  }
  // an icon-only button with a tooltip / aria-describedby is a help affordance
  assert.equal(rankCreateButtons([{ name: 'Origins', text: '', iconOnly: true, tooltip: true }])[0].demoted, true);
  // ties keep document order
  assert.deepEqual(names([{ name: 'Add phone', text: 'Add phone' }, { name: 'Add email', text: 'Add email' }]), ['Add phone', 'Add email']);
});

test('miss head: a section / select / duplicate miss is final — no settling, no "not rendered yet"', () => {
  const SETTLE = 'the field may not be rendered yet';
  const section = { error: 'No visible fillable element matching "Emails".', section: 'Emails', buttons: ['Add email'], hint: 'section hint' };
  const select = { error: 'x', selectField: { tag: 'select' }, hint: 'select hint' };
  const dup = { error: '2 visible fields match "URIs 1"', candidates: [{ index: 0 }, { index: 1 }], hint: 'dup hint' };
  const plain = { error: 'No visible fillable element matching "Zip".', candidates: [{ tag: 'input' }] };
  const hidden = { error: 'No visible fillable element matching "q".', candidates: [], hint: 'hidden hint' };
  // recording #4: 1 fill + 2 section misses on a settling page → the section hint, no settle
  assert.deepEqual(missHead([section, { ...section, section: 'Phones', hint: 'second section hint' }], true, SETTLE), { hint: 'section hint' });
  assert.deepEqual(missHead([select], true, SETTLE), { hint: 'select hint' });
  assert.deepEqual(missHead([dup], true, SETTLE), { hint: 'dup hint' });
  // a section miss without buttons is still final
  assert.deepEqual(missHead([{ error: 'x', section: 'Origins', hint: 'no-button hint' }], true, SETTLE), { hint: 'no-button hint' });
  // an unexplained miss on a settling page keeps the settle hint, AFTER the specific one
  assert.deepEqual(missHead([plain, section], true, SETTLE), { settling: true, hint: `section hint | ${SETTLE}` });
  assert.deepEqual(missHead([hidden], true, SETTLE), { settling: true, hint: `${SETTLE}; hidden hint` });
  // a quiet page: no settle at all; an unexplained miss adds nothing
  assert.deepEqual(missHead([plain], false, SETTLE), {});
  assert.deepEqual(missHead([plain, select], false, SETTLE), { hint: 'select hint' });
  assert.equal(explainedMiss({ skipped: true }), true);
  assert.equal(explainedMiss(plain), false);
});
