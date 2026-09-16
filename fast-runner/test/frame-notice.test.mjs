// node --test — page reads name the cross-origin frames DOM tools cannot see
// (fast-ext/src/actions/page.js opaqueFrames / frameNotice), and fast_wait
// answers at its own timeoutMs. The REAL page.js runs inside jsdom.
// Live (Azure, build ba72fd8): the portal body is a cross-origin blade; the
// snapshot came back header-only, fast_wait "Virtual machine name" ran 19.8s on
// timeoutMs 10000 (page.js never answered: resolveEmpty threw) and the model
// reported "page never rendered" for a form plainly on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const src = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');

// jsdom has no layout and loads no frames: each iframe gets a box from
// data-box="x,y,w,h" and a closed document (cross-origin) unless data-open.
function page(html, url = 'https://shop.example/checkout') {
  const dom = new JSDOM(`<body>${html}</body>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  for (const f of w.document.querySelectorAll('iframe')) {
    const [x, y, wd, h] = (f.getAttribute('data-box') || '0,0,0,0').split(',').map(Number);
    f.getBoundingClientRect = () => ({ x, y, left: x, top: y, width: wd, height: h, right: x + wd, bottom: y + h });
    if (!f.hasAttribute('data-open')) Object.defineProperty(f, 'contentDocument', { get: () => null });
  }
  w.eval(src);
  return w;
}
const run = (w, action, args) => w.__fastlink.run(action, args);

test('an embedded cross-origin form: fast_snapshot LEADS with the notice, origin and on-screen box', async () => {
  const w = page(`<h1>Checkout</h1><label>Email <input></label>
    <iframe src="https://js.stripe.com/v3/elements-inner-card.html" data-box="40,300,400,220"></iframe>`);
  const r = await run(w, 'fast_snapshot', {});
  assert.equal(Object.keys(r)[0], 'frameNotice', 'first thing the model reads');
  assert.equal(r.frameNotice, '1 visible cross-origin frame(s) DOM tools could not read: https://js.stripe.com at x:40, y:300, 400x220. Their content is visible in fast_screenshot, but DOM tools cannot target it.');
  assert.deepEqual(JSON.parse(JSON.stringify(r.opaqueFrames)), [{ origin: 'https://js.stripe.com', x: 40, y: 300, w: 400, h: 220 }]);
});

test('a page full of ad iframes: trackers, hidden, below-the-fold and same-origin frames are not reported; the list is capped', async () => {
  const ads = [
    ...Array.from({ length: 20 }, (_, i) => `<iframe src="https://px.ads.example/t${i}" data-box="0,0,1,1"></iframe>`),
    '<iframe src="https://hidden.ads.example/" data-box="0,0,300,250" style="visibility:hidden"></iframe>',
    '<iframe src="https://below.ads.example/" data-box="0,5000,300,250"></iframe>',
    '<iframe src="https://news.example/embed" data-box="0,0,600,400" data-open></iframe>',
    ...Array.from({ length: 6 }, (_, i) => `<iframe src="https://ad${i}.example/banner" data-box="${i * 10},100,${300 - i},250"></iframe>`),
  ];
  const w = page(`<h1>News</h1><p>story</p>${ads.join('')}`, 'https://news.example/');
  const r = await run(w, 'fast_snapshot', {});
  assert.match(r.frameNotice, /^6 visible cross-origin frame\(s\) DOM tools could not read: https:\/\/ad0\.example at x:0, y:100, 300x250; .* and 2 more\. Their content/);
  assert.equal(r.opaqueFrames.length, 4);
  assert.ok(!/px\.ads|hidden\.ads|below\.ads|news\.example/.test(r.frameNotice));
});

test('a page with no such frame carries no notice', async () => {
  const w = page('<h1>Plain</h1><iframe src="https://px.example/" data-box="0,0,1,1"></iframe>');
  const r = await run(w, 'fast_snapshot', {});
  assert.equal(r.frameNotice, undefined);
});

test('fast_wait timeoutMs 3000 on text that never appears returns within 3.5s (the frames it searched are frames.js\'s to report)', async () => {
  const w = page('<h1>Create a virtual machine</h1><iframe src="https://sandbox-1.reactblade.portal.azure.net/blade" data-box="0,120,1200,700"></iframe>', 'https://portal.azure.com/');
  const t0 = Date.now();
  const r = await run(w, 'fast_wait', { text: 'Virtual machine name', timeoutMs: 3000, noSnapshot: true });
  const ms = Date.now() - t0;
  assert.ok(ms >= 2900 && ms <= 3500, `returned in ${ms}ms`);
  assert.equal(r.error, 'Timed out waiting for "Virtual machine name"');
});

test('a selector wait (this document only) that times out names the visible frames and the frame arg', async () => {
  const w = page('<h1>Create a virtual machine</h1><iframe src="https://sandbox-1.reactblade.portal.azure.net/blade" data-box="0,120,1200,700"></iframe>', 'https://portal.azure.com/');
  const r = await run(w, 'fast_wait', { selector: '#vmName', timeoutMs: 500, noSnapshot: true });
  assert.match(r.error, /^Timed out waiting for selector "#vmName" in this document — it may be inside a visible cross-origin frame \(https:\/\/sandbox-1\.reactblade\.portal\.azure\.net at x:0, y:120, 1200x700\); pass frame:/);
});

test('REGRESSION ba72fd8: a wait whose text matches only a hidden element answers at its deadline (it used to throw and hang to the 20s bridge)', async () => {
  const w = page('<h1>Create a virtual machine</h1><div hidden>Virtual machine name</div>', 'https://portal.azure.com/');
  const t0 = Date.now();
  const r = await Promise.race([
    run(w, 'fast_wait', { text: 'Virtual machine name', timeoutMs: 1000, noSnapshot: true }),
    new Promise((res) => setTimeout(() => res({ hung: true }), 3000)),
  ]);
  assert.equal(r.hung, undefined, 'the wait never answered');
  assert.ok(Date.now() - t0 <= 1500);
  assert.equal(r.emptyContainer, true);
});

test('a frame document read by the background (noFrameNotice) carries no notice of its own', async () => {
  const w = page('<h1>Blade</h1><iframe src="https://nested.example/" data-box="0,0,400,300"></iframe>', 'https://sandbox-1.reactblade.portal.azure.net/blade');
  assert.equal((await run(w, 'fast_snapshot', { noFrameNotice: true })).frameNotice, undefined);
  assert.match((await run(w, 'fast_snapshot', {})).frameNotice, /could not read/);
});

test('the scan is bounded on a page with tens of thousands of iframes', () => {
  const slice = (name) => { const i = src.indexOf(`const ${name} =`); const j = src.indexOf('\n};\n', i); return src.slice(i, j + 3); };
  const consts = ['FRAME_NOTICE_MIN', 'FRAME_NOTICE_LIST'].map((n) => { const i = src.indexOf(`const ${n} =`); return src.slice(i, src.indexOf('\n', i) + 1); }).join('')
    + (() => { const i = src.indexOf('const FRAME_SCAN_MAX'); return src.slice(i, src.indexOf('\n', i) + 1); })();
  const { opaqueFrames } = new Function(`${consts}${slice('opaqueFrames')}\nreturn { opaqueFrames };`)();
  let rectReads = 0;
  const zero = { getBoundingClientRect: () => { rectReads++; return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }; } };
  const els = Array.from({ length: 38116 }, () => zero);
  const doc = { baseURI: 'https://console.cloud.google.com/', getElementsByTagName: (t) => (t === 'iframe' ? els : []) };
  const t0 = Date.now();
  const r = opaqueFrames(doc, { innerWidth: 1400, innerHeight: 900, getComputedStyle: () => ({}) });
  assert.ok(Date.now() - t0 < 100);
  assert.ok(rectReads <= 3000, `read ${rectReads} boxes`);
  assert.equal(r.partial, true);
  assert.deepEqual(r.frames, []);
});
