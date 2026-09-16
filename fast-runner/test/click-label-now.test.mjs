// node --test — fast_click reports a label that changed with the click, and a later miss
// on the old label says so (fast-ext/src/actions/page.js, the REAL page.js in jsdom).
// h_table: DataTables renames a header on click ("Salary: Activate to sort" →
// "Salary: Activate to invert sorting"); the model reused clicked.text, its second
// click missed with a bare "No element matching", and it reported a wrong sort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const PAGE_JS = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');
function page(html) {
  const dom = new JSDOM(`<body>${html}</body>`, { url: 'https://tables.example/grid', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let n = 0;
  const boxes = new WeakMap();
  w.Element.prototype.getBoundingClientRect = function () {
    if (!boxes.has(this)) { const y = 10 + 30 * (n++ % 20); boxes.set(this, { x: 10, y, left: 10, top: y, width: 160, height: 24, right: 170, bottom: y + 24 }); }
    return boxes.get(this);
  };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  for (const th of w.document.querySelectorAll('th[data-sort]')) {
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-sort');
      th.setAttribute('aria-label', th.getAttribute('aria-label').endsWith('invert sorting') ? `${col}: Activate to sort` : `${col}: Activate to invert sorting`);
    });
  }
  w.eval(PAGE_JS);
  return w;
}
const run = (w, action, args) => w.__fastlink.run(action, args);
// a generic sortable header: its accessible name states the NEXT sort action
const HEADER = `<table><thead><tr>
  <th data-sort="Salary" role="button" tabindex="0" aria-label="Salary: Activate to sort"></th>
  <th role="button" tabindex="0" aria-label="Name: Activate to sort"></th>
</tr></thead></table>`;

test('a click that renames its element reports labelNow; one that does not, does not', async () => {
  const w = page(HEADER);
  const r = await run(w, 'fast_click', { text: 'Salary: Activate to sort', noSnapshot: true });
  assert.equal(r.labelNow, 'Salary: Activate to invert sorting', JSON.stringify(r).slice(0, 400));
  const r2 = await run(w, 'fast_click', { text: 'Name: Activate to sort', noSnapshot: true });
  assert.equal(r2.labelNow, undefined);
});

test('a miss on the label the previous click just replaced names the new label', async () => {
  const w = page(HEADER);
  await run(w, 'fast_click', { text: 'Salary: Activate to sort', noSnapshot: true });
  const miss = await run(w, 'fast_click', { text: 'Salary: Activate to sort', noSnapshot: true });
  assert.match(miss.error, /^No element matching "Salary: Activate to sort"/);
  assert.match(miss.error, /; that was the label of the element you just clicked; it now reads "Salary: Activate to invert sorting"/);
  assert.equal(miss.labelNow, 'Salary: Activate to invert sorting');
});

test('an unrelated miss carries no such hint', async () => {
  const w = page(HEADER);
  await run(w, 'fast_click', { text: 'Salary: Activate to sort', noSnapshot: true });
  const miss = await run(w, 'fast_click', { text: 'Export to CSV', noSnapshot: true });
  assert.ok(miss.error);
  assert.doesNotMatch(String(miss.error || ''), /you just clicked/);
});

test('top document: index with no text is refused (not an item id); an id from a snapshot clicks; no text/id names both forms', async () => {
  const w = page(HEADER);
  const snap = await run(w, 'fast_snapshot', {});
  const name = snap.items.find((it) => /Name/.test(it.text || ''));
  const byIndex = await run(w, 'fast_click', { index: name.i, noSnapshot: true });
  assert.equal(byIndex.code, 'no_target', JSON.stringify(byIndex).slice(0, 300));
  const byId = await run(w, 'fast_click', { id: String(name.i), noSnapshot: true });
  assert.equal(byId.clicked.text, 'Name: Activate to sort', JSON.stringify(byId).slice(0, 300));   // page.js result; the exit (index.js) turns it into the string
  const none = await run(w, 'fast_click', { noSnapshot: true });
  assert.equal(none.error, 'fast_click needs a target — pass id:"<i>" (an item\'s i from fast_snapshot) or text:"<label>"; nothing was clicked');
});
