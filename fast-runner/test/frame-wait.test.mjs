// node --test — fast_wait {text} across frames (fast-ext/src/actions/frames.js
// waitTextAnyFrame). Live cost it removes: an Azure run's fast_wait on "Virtual
// machine name" — a label inside the cross-origin reactblade frame — burned its
// full 20.6s timeout because the wait only ever looked at the top document.
// Each fake frame is a jsdom document; the stubbed executeScript runs the REAL
// injected probe against every frame. `topWait` stands in for page.js's wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let frames = [];   // [{ dom, top, answers, parent, hidden }] — frameId = index
const calls = [];  // every executeScript target
const RECT = { x: 0, y: 0, width: 300, height: 120, top: 0, left: 0, bottom: 120, right: 300 };
const ZERO = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
globalThis.chrome = {
  storage: { session: { get: async () => ({}) } },
  tabs: { query: async () => [{ id: 1, url: 'https://news.example/' }] },
  webNavigation: {
    getAllFrames: async () => frames.map((f, frameId) => ({ frameId, parentFrameId: frameId === 0 ? -1 : (f.parent ?? 0), url: f.dom.window.location.href })),
  },
  scripting: {
    executeScript: async ({ target, func, args }) => {
      calls.push(target);
      assert.ok(Array.isArray(target.frameIds) && !target.allFrames, 'the wait names its frames; it never broadcasts');
      return target.frameIds.map((frameId) => {
        const f = frames[frameId];
        if (!f || f.answers === false) throw new Error(`Cannot access contents of frame ${frameId}`);
        const w = f.dom.window;
        // jsdom has no layout: an iframe is rendered unless it carries data-hidden
        w.HTMLIFrameElement.prototype.getBoundingClientRect = function () { return this.hasAttribute('data-hidden') ? ZERO : RECT; };
        const bound = new Function('window', 'location', 'document', 'NodeFilter', 'getComputedStyle', `return (${func.toString()});`)(
          w, w.location, w.document, w.NodeFilter, w.getComputedStyle.bind(w));
        return { frameId, result: bound(...args) };
      });
    },
  },
};
const { waitTextAnyFrame, FRAME_WALK, matchChildFrames } = await import('../../fast-ext/src/actions/frames.js');
const FAST = { ...FRAME_WALK, firstMs: 20, gapMs: 5, maxMs: 40 };
const frame = (url, html, extra = {}) => ({ dom: new JSDOM(html, { url }), top: false, ...extra });
// page.js's top-frame wait: resolves found when `until()` turns true, else times out
const topWait = (until, timeoutMs, onCancel) => () => new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => {
    if (onCancel && onCancel.cancelled) return resolve({ cancelled: true });
    if (until()) return resolve({ found: { text: 'x' }, snapshot: 'top' });
    if (Date.now() - t0 > timeoutMs) return resolve({ error: 'Timed out waiting for "x"' });
    setTimeout(tick, 10);
  };
  tick();
});

test('Azure: text inside the cross-origin blade resolves at once, not at the timeout', async () => {
  frames = [
    frame('https://portal.azure.com/#create', '<body><iframe src="https://sandbox-1.reactblade.portal.azure.net/blade"></iframe></body>', { top: true }),
    frame('https://sandbox-1.reactblade.portal.azure.net/blade', '<body><label>Virtual machine  name</label><input></body>'),
  ];
  const t0 = Date.now();
  const flag = { cancelled: false };
  const r = await waitTextAnyFrame({ text: 'Virtual machine name', timeoutMs: 3000 }, topWait(() => false, 3000, flag), { walk: FAST, cancelTop: async () => { flag.cancelled = true; } });
  assert.equal(flag.cancelled, true, 'the still-running page.js wait is cancelled on a frame hit');
  assert.ok(Date.now() - t0 < 1000, `resolved in ${Date.now() - t0}ms`);
  assert.equal(r.inFrame, true);
  assert.equal(r.found.frame, 'https://sandbox-1.reactblade.portal.azure.net/blade');
  assert.match(r.note, /fast_click_xy/);
});

test('non-Azure, ordinary slow content: text that appears LATE in the top document resolves through the top wait, untouched', async () => {
  const top = frame('https://news.example/', '<body><div id="feed">Loading…</div><iframe src="https://www.youtube.com/embed/abc"></iframe></body>', { top: true });
  frames = [top, frame('https://www.youtube.com/embed/abc', '<body>Watch later</body>')];
  setTimeout(() => { top.dom.window.document.getElementById('feed').textContent = 'Election results are in'; }, 150);
  const hasText = () => top.dom.window.document.body.textContent.includes('Election results');
  const r = await waitTextAnyFrame({ text: 'Election results', timeoutMs: 2000 }, topWait(hasText, 2000), { walk: FAST });
  assert.deepEqual(r, { found: { text: 'x' }, snapshot: 'top' }, 'the top wait\'s own result, not a frame hit or a timeout');
});

test('non-Azure: text that appears LATE inside a cross-origin frame is found on a later poll', async () => {
  const stripe = frame('https://js.stripe.com/v3/elements-inner-card.html', '<body><div id="s"></div></body>');
  frames = [frame('https://shop.example/checkout', '<body><iframe src="https://js.stripe.com/v3/elements-inner-card.html"></iframe></body>', { top: true }), stripe];
  setTimeout(() => { stripe.dom.window.document.getElementById('s').textContent = 'Your card number is incomplete.'; }, 120);
  const r = await waitTextAnyFrame({ text: 'card number is incomplete', timeoutMs: 2000 }, topWait(() => false, 2000), { walk: FAST });
  assert.equal(r.inFrame, true);
  assert.ok(r.waitedMs >= 100);
});

test('text only in a sub-frame <script> does not count; a timeout names searched and unsearchable frame origins', async () => {
  frames = [
    frame('https://shop.example/checkout', '<body><iframe src="https://js.stripe.com/v3/x.html"></iframe><iframe src="https://blocked.example/widget"></iframe></body>', { top: true }),
    frame('https://js.stripe.com/v3/x.html', '<body><script>var s = "Pay now";</script><p>Card</p></body>'),
    frame('https://blocked.example/widget', '<body>Pay now</body>', { answers: false }),
  ];
  const r = await waitTextAnyFrame({ text: 'Pay now', timeoutMs: 150 }, topWait(() => false, 150), { walk: FAST });
  assert.equal(r.error, 'Timed out waiting for "x"');
  assert.deepEqual(r.frames, { searched: ['https://js.stripe.com'], unsearched: ['https://blocked.example'] });
  assert.match(r.framesHint, /blocked\.example could not be searched/);
});

test('a page with no frames times out exactly as the top wait did', async () => {
  frames = [frame('https://plain.example/', '<body>hello</body>', { top: true })];
  const r = await waitTextAnyFrame({ text: 'bye', timeoutMs: 100 }, topWait(() => false, 100), { walk: FAST });
  assert.deepEqual(r, { error: 'Timed out waiting for "x"' });
});

test('text already in the top document: no frame is ever injected', async () => {
  frames = [frame('https://shop.example/', '<body>Ready<iframe src="https://js.stripe.com/v3/x.html"></iframe></body>', { top: true }), frame('https://js.stripe.com/v3/x.html', '<body>Ready</body>')];
  calls.length = 0;
  const r = await waitTextAnyFrame({ text: 'Ready', timeoutMs: 1000 }, topWait(() => true, 1000), { walk: { ...FAST, firstMs: 200 } });
  assert.equal(r.snapshot, 'top');
  assert.deepEqual(calls, []);
});

test('zero-size / hidden frames are never searched; a tick names at most perTick frames', async () => {
  const many = Array.from({ length: 30 }, (_, i) => i);
  frames = [
    frame('https://console.example/', `<body>${many.map((i) => `<iframe ${i < 20 ? 'data-hidden' : ''} src="https://console.example/w/${i}"></iframe>`).join('')}</body>`, { top: true }),
    ...many.map((i) => frame(`https://console.example/w/${i}`, `<body>${i === 3 ? 'Only in a hidden frame' : 'widget'}</body>`)),
  ];
  calls.length = 0;
  const r = await waitTextAnyFrame({ text: 'Only in a hidden frame', timeoutMs: 300 }, topWait(() => false, 300), { walk: { ...FAST, perTick: 4 } });
  assert.equal(r.error, 'Timed out waiting for "x"');
  const searchedIds = new Set(calls.flatMap((t) => t.frameIds).filter((id) => id !== 0));
  assert.ok([...searchedIds].every((id) => id > 20), `only the 10 rendered frames (ids 21-30), got ${[...searchedIds]}`);
  assert.ok(calls.every((t) => t.frameIds.length <= 4));
});

test('matchChildFrames: exact URL, then same origin; an unclaimed child is not returned', () => {
  const kids = [{ id: 1, url: 'https://a.example/x' }, { id: 2, url: 'https://b.example/y?z' }, { id: 3, url: 'https://c.example/hidden' }];
  assert.deepEqual(matchChildFrames(kids, ['https://b.example/y', 'https://a.example/x']).map((k) => k.id), [2, 1]);
  assert.deepEqual(matchChildFrames(kids, ['https://a.example/x', 'https://a.example/x']).map((k) => k.id), [1]);
});

test('a top wait that overruns its own deadline (a heavy page) is answered at timeoutMs + grace, and cancelled', async () => {
  frames = [frame('https://heavy.example/', '<body>busy</body>', { top: true })];
  const flag = { cancelled: false };
  const neverOnTime = () => new Promise((resolve) => setTimeout(() => resolve({ error: 'Timed out waiting for "x"', late: true }), 2500));
  const t0 = Date.now();
  const r = await waitTextAnyFrame({ text: 'Not here', timeoutMs: 1000 }, neverOnTime, { walk: FAST, cancelTop: async () => { flag.cancelled = true; } });
  const ms = Date.now() - t0;
  assert.ok(ms >= 1000 && ms < 1600, `answered in ${ms}ms`);
  assert.equal(r.error, 'Timed out waiting for "Not here"');
  assert.equal(r.pageBusy, true);
  assert.equal(r.late, undefined);
  assert.equal(flag.cancelled, true);
});
