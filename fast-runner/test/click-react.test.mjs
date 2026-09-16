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
  w.Element.prototype.getBoundingClientRect = function () { if (!this.isConnected || this.closest('[hidden]')) return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; if (!boxes.has(this)) { const y = 10 + 30 * (n++ % 20); boxes.set(this, { x: 10, y, left: 10, top: y, width: 200, height: 24, right: 210, bottom: y + 24 }); } return boxes.get(this); };
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
