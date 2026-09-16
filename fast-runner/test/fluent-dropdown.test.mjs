// node --test — fast_select_option on a Fluent UI / React Dropdown whose listbox renders
// into a portal Layer at the end of <body> (fast-ext/src/actions/page.js, the REAL page.js in
// jsdom). Shape from live Azure run bb75f0a8 (inside the reactblade frame): a div
// role=combobox id=Dropdown72 aria-label="Resource group", list id "Dropdown72-list" in a
// .ms-Layer. There the list opened and was read correctly; the asked value was simply not an
// option yet (the only entry was "(New) fastlink-bench-vm_group"), and the error said only
// "no matching option in the open list" after a 3s poll of a list that had long settled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const PAGE_JS = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');

function page() {
  const dom = new JSDOM(`<body><h2>Project details</h2>
    <div class="row"><label id="rgl">Resource group</label>
      <div role="combobox" id="Dropdown72" tabindex="0" aria-label="Resource group" aria-haspopup="listbox" aria-expanded="false" aria-controls="Dropdown72-list"><span class="ms-Dropdown-title">(New) fastlink-bench-vm_group</span></div></div>
    <div class="row"><label id="rl">Region</label>
      <div role="combobox" id="Dropdown90" tabindex="0" aria-labelledby="rl" aria-haspopup="listbox" aria-expanded="false" aria-controls="Dropdown90-list"><span class="ms-Dropdown-title">(US) East US</span></div></div>
    </body>`, { url: 'https://sandbox-1.blade.example/React/Index', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  let n = 0;
  const boxes = new WeakMap();
  w.Element.prototype.getBoundingClientRect = function () {
    if (!this.isConnected) return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    if (!boxes.has(this)) { const y = 10 + 28 * (n++ % 30); boxes.set(this, { x: 20, y, left: 20, top: y, width: 300, height: 24, right: 320, bottom: y + 24 }); }
    return boxes.get(this);
  };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  w.Element.prototype.scrollIntoView = function () {};
  const OPTIONS = {
    Dropdown72: ['(New) fastlink-bench-vm_group'],
    Dropdown90: ['(US) East US', '(US) West US 2', '(Europe) North Europe', '(Asia Pacific) Japan East', '(Asia Pacific) Korea Central'],
  };
  for (const cb of d.querySelectorAll('[role=combobox]')) {
    const close = () => { const l = d.getElementById(`${cb.id}-list`); if (l) l.closest('.ms-Layer').remove(); cb.setAttribute('aria-expanded', 'false'); };
    cb.addEventListener('click', () => {
      if (cb.getAttribute('aria-expanded') === 'true') return close();
      const layer = d.createElement('div');
      layer.className = 'ms-Layer ms-Layer--fixed';
      const lb = d.createElement('div');
      lb.setAttribute('role', 'listbox'); lb.id = `${cb.id}-list`;
      for (const text of OPTIONS[cb.id]) {
        const o = d.createElement('button');
        o.setAttribute('role', 'option'); o.className = 'ms-Dropdown-item'; o.textContent = text;
        o.addEventListener('click', () => { cb.querySelector('.ms-Dropdown-title').textContent = text; close(); });
        lb.appendChild(o);
      }
      layer.appendChild(lb);
      setTimeout(() => { d.body.appendChild(layer); cb.setAttribute('aria-expanded', 'true'); }, 30);   // the portal mounts a tick later
    });
    cb.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }
  w.eval(PAGE_JS);
  return w;
}
const run = (w, action, args) => w.__fastlink.run(action, args);

test('a portalled Fluent listbox: an existing option is picked and read back', async () => {
  const w = page();
  const r = await run(w, 'fast_select_option', { field: 'Region', option: '(Asia Pacific) Japan East', noSnapshot: true });
  assert.equal(r.verified, true, JSON.stringify(r).slice(0, 600));
  assert.equal(w.document.querySelector('#Dropdown90 .ms-Dropdown-title').textContent, '(Asia Pacific) Japan East');
});

test('a value that is not an option says so, lists the options, closes the list, and does not poll a settled list for 3s', async () => {
  const w = page();
  const t0 = Date.now();
  const r = await run(w, 'fast_select_option', { field: 'Resource group', option: 'fastlink-bench-rg', noSnapshot: true });
  const ms = Date.now() - t0;
  assert.equal(r.error, '"fastlink-bench-rg" is not an option of "Resource group" — the open list offers 1 option(s) (nothing done); options: "(New) fastlink-bench-vm_group"; a value that does not exist yet must be created first (the field\'s own "Create new" control)', JSON.stringify(r));
  assert.ok(ms < 2000, `took ${ms}ms`);
  assert.equal(w.document.getElementById('Dropdown72').getAttribute('aria-expanded'), 'false', 'the list was left open');
});
