// node --test — a click that opens something reports it even when the page reacts a tick later,
// and a wizard step change is a `changed` line (fast-ext/src/actions/page.js, the REAL page.js in jsdom).
// Live Oracle caff4e8f: the first "Change image" click came back changed "none" in 18ms (settleMs 0,
// the picker mounted just after), the model clicked again and closed it; three wizard Next clicks said
// "none" while the wizard moved Security → Networking → Storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const PAGE_JS = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');
function page(html, wire) {
  const dom = new JSDOM(`<body>${html}</body>`, { url: 'https://cloud.example/compute/create', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let n = 0; const boxes = new WeakMap();
  w.Element.prototype.getBoundingClientRect = function () { if (!this.isConnected || this.closest('[hidden]')) return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; if (this.hasAttribute('data-full')) return { x: 0, y: 0, left: 0, top: 0, width: w.innerWidth, height: w.innerHeight, right: w.innerWidth, bottom: w.innerHeight }; if (!boxes.has(this)) { const y = 10 + 30 * (n++ % 20); boxes.set(this, { x: 10, y, left: 10, top: y, width: 200, height: 24, right: 210, bottom: y + 24 }); } return boxes.get(this); };
  wire(w.document);
  w.eval(PAGE_JS);
  return w;
}
const run = async (w, a, x) => JSON.parse(JSON.stringify(await w.__fastlink.run(a, { noSnapshot: true, ...x })));
const quiet = () => new Promise((r) => setTimeout(r, 250));
const mountPanelLater = (d, btnId, ms) => d.getElementById(btnId).addEventListener('click', () => setTimeout(() => {
  const p = d.createElement('div'); p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Side Panel'); p.innerHTML = '<button>Ubuntu</button>';
  d.body.appendChild(p);   // a portal: a sibling of the form's panel, not inside it
}, ms));

test('a popup opener whose panel mounts 60ms after the click: changed names the panel (not "none"); a second same-named panel says how many are open', async () => {
  const w = page('<div role="dialog" aria-label="Side Panel"><h2>Create compute instance</h2><button id="chimg" aria-haspopup="dialog">Change image</button></div>', (d) => mountPanelLater(d, 'chimg', 60));
  await run(w, 'fast_snapshot', {});
  await quiet();
  const r = await run(w, 'fast_click', { text: 'Change image' });
  assert.deepEqual(r.changed, ['dialog "Side Panel" opened (2 open)'], JSON.stringify(r));
  assert.ok(r._debug.phases.reactWaitMs >= 50 && r._debug.phases.reactWaitMs < 800, JSON.stringify(r._debug));
});

test('a plain button (no aria popup attributes) whose panel mounts 100ms later is caught by the short wait', async () => {
  const w = page('<button id="open">Change shape</button>', (d) => mountPanelLater(d, 'open', 100));
  await run(w, 'fast_snapshot', {});
  await quiet();
  const r = await run(w, 'fast_click', { text: 'Change shape' });
  assert.deepEqual(r.changed, ['dialog "Side Panel" opened'], JSON.stringify(r));
});

test('a no-op button pays at most the short wait', async () => {
  const w = page('<button id="noop">Help</button>', () => {});
  await run(w, 'fast_snapshot', {});
  await quiet();
  const t0 = Date.now();
  const r = await run(w, 'fast_click', { text: 'Help' });
  assert.equal(r.changed, 'none');
  assert.ok(Date.now() - t0 < 700, `took ${Date.now() - t0}ms`);
});

test('a wizard Next that moves the current step reports it', async () => {
  const w = page(`<ol><li id="s1" aria-current="step">Security</li><li id="s2">Networking</li><li id="s3">Storage</li></ol>
    <section id="v1"><h3>Security</h3></section><section id="v2" hidden><h3>Networking</h3></section><button id="next">Next</button>`, (d) => {
    d.getElementById('next').addEventListener('click', () => {
      d.getElementById('s1').removeAttribute('aria-current'); d.getElementById('s2').setAttribute('aria-current', 'step');
      d.getElementById('v1').hidden = true; d.getElementById('v2').hidden = false;
    });
  });
  await run(w, 'fast_snapshot', {});
  const r = await run(w, 'fast_click', { text: 'Next' });
  assert.deepEqual(r.changed, ['step: "Security" → "Networking"'], JSON.stringify(r));
});

test('with no step marker, a heading that appears is the view line', async () => {
  const w = page('<section id="v1"><h3>Security</h3></section><section id="v2" hidden><h3>Networking</h3></section><button id="next">Next</button>', (d) => {
    d.getElementById('next').addEventListener('click', () => { d.getElementById('v1').hidden = true; d.getElementById('v2').hidden = false; });
  });
  await run(w, 'fast_snapshot', {});
  const r = await run(w, 'fast_click', { text: 'Next' });
  assert.deepEqual(r.changed, ['now showing "Networking"'], JSON.stringify(r));
});

// Live Oracle 8c427c0f (de812b7): the page dimmed first, the picker showed ~1s later; the click stopped
// at the first mutation (reactWaitMs 25) and said "none", the model clicked again and closed it.
const backdropThenDialog = (d, btnId, { backdropMs = 20, dialogMs = 250, name = 'Side Panel', role = 'dialog' } = {}) => d.getElementById(btnId).addEventListener('click', () => {
  setTimeout(() => { const b = d.createElement('div'); b.setAttribute('data-full', ''); b.style.cssText = 'position:fixed;inset:0;background-color:rgba(0, 0, 0, 0.4)'; d.body.appendChild(b); }, backdropMs);
  if (dialogMs != null) setTimeout(() => { const p = d.createElement('div'); if (role) p.setAttribute('role', role); if (name) p.setAttribute('aria-label', name); p.innerHTML = '<button>Ubuntu</button>'; d.body.appendChild(p); }, dialogMs);
});

test('a backdrop that mounts at +20ms and its named dialog at +250ms: the click waits for the dialog and names it', async () => {
  const w = page('<div role="dialog" aria-label="Side Panel"><h2>Create compute instance</h2><button id="chimg" aria-haspopup="dialog">Change image</button></div>', (d) => backdropThenDialog(d, 'chimg'));
  await run(w, 'fast_snapshot', {});
  await quiet();
  const r = await run(w, 'fast_click', { text: 'Change image' });
  assert.deepEqual(r.changed, ['dialog "Side Panel" opened (2 open)'], JSON.stringify(r));
  assert.ok(r._debug.phases.reactWaitMs >= 230 && r._debug.phases.reactWaitMs < 800, JSON.stringify(r._debug));
});

test('a plain button: backdrop at +20ms, dialog at +250ms (past the 300ms-cap quiet window) is still named', async () => {
  const w = page('<button id="open">Change shape</button>', (d) => backdropThenDialog(d, 'open', { name: 'Browse shapes' }));
  await run(w, 'fast_snapshot', {});
  await quiet();
  const r = await run(w, 'fast_click', { text: 'Change shape' });
  assert.deepEqual(r.changed, ['dialog "Browse shapes" opened'], JSON.stringify(r));
});

test('a backdrop whose dialog never gets a role is reported as a modal opening, within REACT_MODAL_MS', async () => {
  const w = page('<button id="open" aria-haspopup="true">Settings</button>', (d) => backdropThenDialog(d, 'open', { dialogMs: null }));
  await run(w, 'fast_snapshot', {});
  await quiet();
  const t0 = Date.now();
  const r = await run(w, 'fast_click', { text: 'Settings' });
  assert.deepEqual(r.changed, ['a modal opened (its dialog not named yet)'], JSON.stringify(r));
  assert.ok(Date.now() - t0 < 2200, `took ${Date.now() - t0}ms`);
});

test('an aria-modal container with no name yet is a dialog opening', async () => {
  const w = page('<button id="open">Filters</button>', (d) => d.getElementById('open').addEventListener('click', () => setTimeout(() => {
    const p = d.createElement('div'); p.setAttribute('aria-modal', 'true'); p.innerHTML = '<button>Apply</button>'; d.body.appendChild(p);
  }, 40)));
  await run(w, 'fast_snapshot', {});
  await quiet();
  const r = await run(w, 'fast_click', { text: 'Filters' });
  assert.deepEqual(r.changed, ['dialog (no name yet) opened'], JSON.stringify(r));
});
