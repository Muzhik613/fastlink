// node --test — a click that closes a panel must not preview that panel's options when the page's
// MutationObserver is off (storm-tripped); same-named nested panels show in `changed`; a tripped
// observer re-arms after a cool-down. The REAL page.js in jsdom.
// Live Oracle 4cbfe776: "Change image" toggled the image picker shut, the preview (settleMs:0, observer
// deaf: sinceMutMs 81,240) still listed its options, and the model clicked an id from the closed panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const PAGE_JS = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');
function page() {
  const dom = new JSDOM(`<body><div role="dialog" aria-label="Side Panel" id="form"><h2>Create compute instance</h2>
    <label for="img">Image</label><input id="img" readonly value="Oracle Linux 9"><button id="chimg">Change image</button></div></body>`,
  { url: 'https://cloud.example/compute/create', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  let n = 0; const boxes = new WeakMap();
  w.Element.prototype.getBoundingClientRect = function () { if (!this.isConnected) return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; if (!boxes.has(this)) { const y = 10 + 30 * (n++ % 20); boxes.set(this, { x: 10, y, left: 10, top: y, width: 200, height: 24, right: 210, bottom: y + 24 }); } return boxes.get(this); };
  d.getElementById('chimg').addEventListener('click', () => {
    const open = d.getElementById('picker');
    if (open) { setTimeout(() => open.remove(), 110); return; }   // closing animates out
    const p = d.createElement('div');
    p.id = 'picker'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Side Panel');
    p.innerHTML = '<button>Ubuntu</button><button>Rocky Linux</button>';
    d.getElementById('form').appendChild(p);
  });
  w.eval(PAGE_JS);
  return w;
}
const run = async (w, a, x) => JSON.parse(JSON.stringify(await w.__fastlink.run(a, x)));
const deafen = (w) => { const I = w.__fastlinkIndex; if (I.observer) I.observer.disconnect(); I.observer = null; I.suspended = true; I.stormTripped = true; I.stormAt = w.performance.now(); };

test('observer off: the click that closes the picker previews the form, not the closing panel\'s options; changed names the nested panel', async () => {
  const w = page();
  await run(w, 'fast_snapshot', {});
  const opened = await run(w, 'fast_click', { text: 'Change image', noSnapshot: true });
  assert.deepEqual(opened.changed, ['dialog "Side Panel" (nested) opened'], JSON.stringify(opened));
  const shown = await run(w, 'fast_snapshot', {});
  assert.match(JSON.stringify(shown), /Ubuntu/, 'the open picker is read (its options are indexed)');
  deafen(w);
  const closed = await run(w, 'fast_click', { text: 'Change image' });
  const listed = JSON.stringify(closed.snapshot || {});
  assert.doesNotMatch(listed, /Ubuntu|Rocky Linux/, `the preview still lists the closed panel: ${listed.slice(0, 400)}`);
  assert.deepEqual(closed.changed, ['dialog "Side Panel" (nested) closed']);
  assert.ok(closed._debug.phases.settleMs >= 140, `observer off: the settle waited ${closed._debug.phases.settleMs}ms, not the 150ms fallback`);
});

test('observer live and the page quiet: the settle does not wait (normal pages keep settleMs ~0)', async () => {
  const w = page();
  await run(w, 'fast_snapshot', {});
  await new Promise((r) => setTimeout(r, 200));   // quiet
  const r = await run(w, 'fast_click', { text: 'Change image' });
  assert.ok(r._debug.phases.settleMs < 140, `settle waited ${r._debug.phases.settleMs}ms on a live observer`);
});

test('a storm-tripped observer re-arms on the next call after the cool-down', async () => {
  const w = page();
  await run(w, 'fast_snapshot', {});
  deafen(w);
  w.__fastlinkIndex.stormAt -= 11000;   // (page.js clocks with performance.now)
  await run(w, 'fast_snapshot', {});
  assert.equal(w.__fastlinkIndex.stormTripped, false);
  assert.ok(w.__fastlinkIndex.observer, 'listening again');
});
