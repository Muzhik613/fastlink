// node --test — misses leave as ONE actionable line (fast-ext/src/actions/page.js shortResult,
// the REAL page.js in jsdom). Owner direction: let the model fail and recover fast — say what
// went wrong and what exists instead, not a page of candidates, diagnostics and timings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const PAGE_JS = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');
function page() {
  const html = `<h2>Project details</h2><label for=a>Subscription</label><div role=combobox id=a aria-label="Subscription" tabindex=0>Azure subscription 1</div>
    <label for=b>Resource group</label><div role=combobox id=b aria-label="Resource group" tabindex=0>(New) vm_group</div><button>Create new</button>
    <h2>Instance details</h2><label for=c>Virtual machine name</label><input id=c><label for=d>Region</label><div role=combobox id=d aria-label="Region" tabindex=0>(US) East US</div>
    <button>Review + create</button><button>Next : Disks</button>`;
  const dom = new JSDOM(`<body>${html}</body>`, { url: 'https://portal.example/create', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; let n = 0; const boxes = new WeakMap();
  w.Element.prototype.getBoundingClientRect = function () { if (!boxes.has(this)) { const y = 10 + 30 * (n++ % 20); boxes.set(this, { x: 10, y, left: 10, top: y, width: 120, height: 24, right: 130, bottom: y + 24 }); } return boxes.get(this); };
  w.eval(PAGE_JS);
  return w;
}
const run = (w, a, x) => w.__fastlink.run(a, { noSnapshot: true, ...x });

test('click miss: one line with the closest names, nothing else', async () => {
  const r = await run(page(), 'fast_click', { text: 'Create VM' });
  assert.deepEqual(Object.keys(r).filter((k) => k !== '_debug'), ['error'], 'only _debug (stripped by the runner) rides along');
  assert.equal(r.error, 'No element matching "Create VM" (nothing done); closest: "Create new", "(New) vm_group", "Review + create"');
});

test('fill miss on a dropdown names fast_select_option; a fill that landed on a different label says matched', async () => {
  const r = await run(page(), 'fast_fill', { fields: { 'Resource group': 'rg', Name: 'vm1' } });
  assert.equal(r.fields['Resource group'].error, 'No visible fillable element matching "Resource group" (nothing done); it is a dropdown: fast_select_option {field:"Resource group"}');
  assert.deepEqual(Object.keys(r.fields['Resource group']), ['error']);
  assert.equal(r.fields.Name.matched, 'Virtual machine name');
  assert.match(r.summary, /^1\/2 verified — "Resource group": No visible fillable element/);
  assert.equal(r.hint, undefined);
});

test('select miss lists the dropdowns that exist', async () => {
  const r = await run(page(), 'fast_select_option', { field: 'Location', option: 'Japan East' });
  assert.equal(r.error, 'field "Location" not found (nothing done); dropdowns here: "Subscription", "Resource group", "Region"');
});
