// node --test — every write reports what changed on the form (fast-ext/src/actions/page.js
// formState / diffFormState, the REAL page.js in jsdom; batch summary via fast-dxt/server/batch.js).
// Live misses: a picked image discarded when its picker panel closed (Oracle), a resource group
// typed but never applied (Azure) — every result said ok.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { runBatch } from '../../fast-dxt/server/batch.js';

const PAGE_JS = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');
function page(extraRows = '') {
  const html = `<h2>Create compute instance</h2>
    <label for="nm">Name</label><input id="nm">
    <label for="img">Image</label><input id="img" readonly value="Oracle Linux 9"><button id="chimg">Change image</button>
    <label for="shape">Shape</label><input id="shape" readonly value="VM.Standard.E4.Flex"><button id="chshape">Change shape</button>
    <label for="rg">Resource group</label><input id="rg" readonly value="(New) default_group"><button id="create">Create new</button>
    <button id="noop">Help</button>${extraRows}`;
  const dom = new JSDOM(`<body>${html}</body>`, { url: 'https://cloud.example/compute/create', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  let n = 0; const boxes = new WeakMap();
  w.Element.prototype.getBoundingClientRect = function () { if (!boxes.has(this)) { const y = 10 + 30 * (n++ % 30); boxes.set(this, { x: 10, y, left: 10, top: y, width: 200, height: 24, right: 210, bottom: y + 24 }); } return boxes.get(this); };
  const closePanel = () => { const p = d.getElementById('panel'); if (p) p.remove(); };
  d.getElementById('chimg').addEventListener('click', () => {
    closePanel();
    const p = d.createElement('div');
    p.id = 'panel'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Select an image');
    p.innerHTML = '<label><input type="radio" name="os" value="ol" checked> Oracle Linux 9</label><label><input type="radio" name="os" value="ub"> Ubuntu</label><button id="selimg">Select image</button>';
    d.body.appendChild(p);
    d.getElementById('selimg').addEventListener('click', () => { const ub = p.querySelector('input[value=ub]'); d.getElementById('img').value = ub.checked ? 'Ubuntu' : 'Oracle Linux 9'; closePanel(); });
  });
  d.getElementById('chshape').addEventListener('click', closePanel);   // opening another picker discards the unconfirmed pick
  d.getElementById('create').addEventListener('click', () => {
    const dl = d.createElement('div');
    dl.id = 'dlg'; dl.setAttribute('role', 'dialog'); dl.setAttribute('aria-label', 'Create resource group');
    dl.innerHTML = '<label for="rgname">Resource group name</label><input id="rgname"><button id="ok">OK</button>';
    d.body.appendChild(dl);
    d.getElementById('ok').addEventListener('click', () => { d.getElementById('rg').value = `(New) ${d.getElementById('rgname').value}`; dl.remove(); });
  });
  w.eval(PAGE_JS);
  return w;
}
const run = async (w, a, x) => JSON.parse(JSON.stringify(await w.__fastlink.run(a, { noSnapshot: true, ...x })));   // out of the jsdom realm

test('a text fill reports the field it changed', async () => {
  const w = page();
  await run(w, 'fast_snapshot', {});
  const r = await run(w, 'fast_fill', { match: 'Name', value: 'vm1' });
  assert.deepEqual(r.changed, ['Name: "" → "vm1"'], JSON.stringify(r));
  assert.equal(Object.keys(r)[1], 'changed', 'near the head of the result');
});

test('a no-op click says changed: none', async () => {
  const w = page();
  await run(w, 'fast_snapshot', {});
  const r = await run(w, 'fast_click', { text: 'Help' });
  assert.equal(r.changed, 'none', JSON.stringify(r));
});

test('picker panel: a pick left unconfirmed and discarded shows the panel closed and Image unchanged; pick + confirm shows Image changed', async () => {
  const w = page();
  await run(w, 'fast_snapshot', {});
  const open = await run(w, 'fast_click', { text: 'Change image' });
  assert.deepEqual(open.changed, ['dialog "Select an image" opened']);
  const pick = await run(w, 'fast_click', { text: 'Ubuntu' });
  assert.ok(pick.changed.some((c) => /Ubuntu: "unchecked" → "checked"/.test(c)), JSON.stringify(pick.changed));
  const away = await run(w, 'fast_click', { text: 'Change shape' });
  assert.deepEqual(away.changed, ['dialog "Select an image" closed'], 'no Image change: the pick was discarded');
  await run(w, 'fast_click', { text: 'Change image' });
  await run(w, 'fast_click', { text: 'Ubuntu' });
  const confirm = await run(w, 'fast_click', { text: 'Select image' });
  assert.deepEqual(confirm.changed, ['Image: "Oracle Linux 9" → "Ubuntu"', 'dialog "Select an image" closed'], JSON.stringify(confirm.changed));
});

test('a dialog whose OK applies a value: the field change and the close are both reported', async () => {
  const w = page();
  await run(w, 'fast_snapshot', {});
  await run(w, 'fast_click', { text: 'Create new' });
  await run(w, 'fast_fill', { match: 'Resource group name', value: 'bench-rg' });
  const ok = await run(w, 'fast_click', { text: 'OK' });
  assert.deepEqual(ok.changed, ['Resource group: "(New) default_group" → "(New) bench-rg"', 'dialog "Create resource group" closed'], JSON.stringify(ok.changed));
});

test('batch: each step carries changed, and the summary names steps that changed nothing', async () => {
  const w = page();
  await run(w, 'fast_snapshot', {});
  const call = async (name, args) => ({ result: JSON.parse(JSON.stringify(await w.__fastlink.run(name, args))) });
  const b = await runBatch({ actions: [
    { name: 'fast_fill', args: { match: 'Name', value: 'vm1' } },
    { name: 'fast_click', args: { text: 'Help' } },
  ] }, { call });
  assert.deepEqual(b.results[0].result.changed, ['Name: "" → "vm1"']);
  assert.equal(b.results[1].result.changed, 'none');
  assert.equal(b.summary, '2/2 steps ok; step 1 (fast_click "Help") changed nothing on the form');
});

test('cost: before/after form read on a 300-field form stays in the low ms', async () => {
  const rows = Array.from({ length: 300 }, (_, k) => `<label for="f${k}">Field ${k}</label><input id="f${k}" value="v${k}">`).join('');
  const w = page(rows);
  await run(w, 'fast_snapshot', {});
  await run(w, 'fast_fill', { match: 'Field 150', value: 'x' });
  const ms = w.__fastlink.lastChangedMs;
  assert.ok(typeof ms === 'number' && ms < 150, `form diff took ${ms}ms (jsdom)`);
  console.log(`# form-state read+diff on 300 fields: ${ms}ms (jsdom)`);
});
