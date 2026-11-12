// node --test — page.js's own reads (the REAL page.js inside jsdom): fast_wait
// answers at its own timeoutMs, and page.js names NO frames itself — the frame
// notice is the background's, from the one frame enumeration in frames.js
// (frameNoticeFor here; through dispatchAction in frame-reach.test.mjs).
// Live (Azure, build ba72fd8): the portal body is a cross-origin blade; the
// snapshot came back header-only, fast_wait "Virtual machine name" ran 19.8s on
// timeoutMs 10000 (page.js never answered: resolveEmpty threw) and the model
// reported "page never rendered" for a form plainly on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const src = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');
const { frameNoticeFor } = await import('../../fast-ext/src/actions/frames.js');

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

test('page.js names no frames itself: a snapshot beside a visible cross-origin frame carries no notice (the background adds it)', async () => {
  const w = page(`<h1>Checkout</h1><label>Email <input></label>
    <iframe src="https://js.stripe.com/v3/elements-inner-card.html" data-box="40,300,400,220"></iframe>`);
  const r = await run(w, 'fast_snapshot', {});
  assert.equal(r.frameNotice, undefined);
  assert.equal(r.opaqueFrames, undefined);
});

test('frameNoticeFor: on screen, at least 100x50, not read — largest first, capped at 4 boxes', () => {
  const k = (origin, x, y, w, h, inView = true) => ({ src: `${origin}/f`, origin, x, y, w, h, inView });
  const kids = [
    k('https://px.ads.example', 0, 0, 2, 2),
    k('https://below.ads.example', 0, 5000, 300, 250, false),
    k('https://strip.example', 0, 0, 480, 4),
    ...Array.from({ length: 6 }, (_, i) => k(`https://ad${i}.example`, i * 10, 100, 300 - i, 250)),
  ];
  const r = frameNoticeFor(kids);
  assert.match(r.frameNotice, /^6 frame\(s\) DOM tools cannot read: https:\/\/ad0\.example at 0,100 300x250; .* and 2 more \(visible in fast_screenshot only\)$/);
  assert.equal(r.opaqueFrames.length, 4);
  assert.ok(!/px\.ads|below\.ads|strip/.test(r.frameNotice));
  assert.deepEqual(frameNoticeFor(kids, new Set(kids.map((x) => x.src))), {}, 'read frames are not named');
  assert.deepEqual(frameNoticeFor([]), {});
});

test('fast_wait timeoutMs 3000 on text that never appears returns within 3.5s (the frames it searched are frames.js\'s to report)', async () => {
  const w = page('<h1>Create a virtual machine</h1><iframe src="https://sandbox-1.reactblade.portal.azure.net/blade" data-box="0,120,1200,700"></iframe>', 'https://portal.azure.com/');
  const t0 = Date.now();
  const r = await run(w, 'fast_wait', { text: 'Virtual machine name', timeoutMs: 3000, noSnapshot: true });
  const ms = Date.now() - t0;
  assert.ok(ms >= 2900 && ms <= 3500, `returned in ${ms}ms`);
  assert.equal(r.error, 'Timed out waiting for "Virtual machine name"');
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
