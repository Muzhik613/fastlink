// node --test — fast_select_option's ARIA panel resolution (page.js ariaPanelIds) against a
// synthetic aria-controls DOM; the helper is sliced from page.js so there is one source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');
const slice = (name) => { const i = src.indexOf(`const ${name} =`); const j = src.indexOf('\n};\n', i); return src.slice(i, j + 3); };
const line = (name) => { const i = src.indexOf(`const ${name} =`); return src.slice(i, src.indexOf('\n', i) + 1); };
const ariaPanelIds = new Function(`${line('ARIA_PANEL_HOSTS')}\n${slice('ariaPanelIds')}\nreturn ariaPanelIds;`)();

const el = (attrs = {}, kids = []) => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null), querySelectorAll: () => kids });

test('cfc/mat-select: aria-controls / aria-owns on the field, its inner combobox, or a haspopup child; deduped, in order', () => {
  assert.deepEqual(ariaPanelIds(el({ 'aria-controls': 'panel-1' })), ['panel-1']);
  assert.deepEqual(ariaPanelIds(el({ role: 'combobox' }, [el({ 'aria-owns': 'a b' }), el({ 'aria-controls': 'b c' })])), ['a', 'b', 'c']);
  assert.deepEqual(ariaPanelIds(el({}, [el({ 'aria-haspopup': 'listbox', 'aria-controls': '  mat-select-0-panel ' })])), ['mat-select-0-panel']);
  assert.deepEqual(ariaPanelIds(el({})), []);
  assert.deepEqual(ariaPanelIds(null), []);
  assert.deepEqual(ariaPanelIds({ getAttribute: () => { throw new Error('x'); }, querySelectorAll: () => { throw new Error('y'); } }), []);
});

test('page.js keeps the ARIA branch wall-clock capped and panel-first', () => {
  assert.match(src, /for \(const id of ariaPanelIds\(field\)\)/, 'options resolve from the aria-controls panel first');
  assert.match(src, /if \(nowMs\(\) - tStart >= budgetMs\) break;/, 'budget is wall clock, checked after every wake');
  assert.match(src, /starved = true/, 'a starved timer is reported');
});
