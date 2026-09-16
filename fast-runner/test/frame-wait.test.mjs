// node --test — fast_wait {text} across frames (fast-ext/src/actions/frames.js
// waitTextAnyFrame). Live cost it removes: an Azure run's fast_wait on "Virtual
// machine name" — a label inside the cross-origin reactblade frame — burned its
// full 20.6s timeout because the wait only ever looked at the top document.
// Each fake frame is a jsdom document; the stubbed executeScript runs the REAL
// injected probe against every frame. `topWait` stands in for page.js's wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let frames = [];   // [{ dom, top, answers }]
globalThis.chrome = {
  storage: { session: { get: async () => ({}) } },
  tabs: { query: async () => [{ id: 1, url: 'https://news.example/' }] },
  scripting: {
    executeScript: async ({ func, args }) => frames.filter((f) => f.answers !== false).map((f, frameId) => {
      const w = f.dom.window;
      const win = f.top ? { top: null } : { top: {} };
      if (f.top) win.top = win;
      const bound = new Function('window', 'location', 'document', 'NodeFilter', `return (${func.toString()});`)(
        win, w.location, w.document, w.NodeFilter);
      return { frameId, result: bound(...args) };
    }),
  },
};
const { waitTextAnyFrame } = await import('../../fast-ext/src/actions/frames.js');
const frame = (url, html, extra = {}) => ({ dom: new JSDOM(html, { url }), top: false, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// page.js's top-frame wait: resolves found when `until()` turns true, else times out
const topWait = (until, timeoutMs) => () => new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => {
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
  const r = await waitTextAnyFrame({ text: 'Virtual machine name', timeoutMs: 3000 }, topWait(() => false, 3000), { pollMs: 20 });
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
  const r = await waitTextAnyFrame({ text: 'Election results', timeoutMs: 2000 }, topWait(hasText, 2000), { pollMs: 20 });
  assert.deepEqual(r, { found: { text: 'x' }, snapshot: 'top' }, 'the top wait\'s own result, not a frame hit or a timeout');
});

test('non-Azure: text that appears LATE inside a cross-origin frame is found on a later poll', async () => {
  const stripe = frame('https://js.stripe.com/v3/elements-inner-card.html', '<body><div id="s"></div></body>');
  frames = [frame('https://shop.example/checkout', '<body><iframe src="https://js.stripe.com/v3/elements-inner-card.html"></iframe></body>', { top: true }), stripe];
  setTimeout(() => { stripe.dom.window.document.getElementById('s').textContent = 'Your card number is incomplete.'; }, 120);
  const r = await waitTextAnyFrame({ text: 'card number is incomplete', timeoutMs: 2000 }, topWait(() => false, 2000), { pollMs: 20 });
  assert.equal(r.inFrame, true);
  assert.ok(r.waitedMs >= 100);
});

test('text only in a sub-frame <script> does not count; a timeout names searched and unsearchable frame origins', async () => {
  frames = [
    frame('https://shop.example/checkout', '<body><iframe src="https://js.stripe.com/v3/x.html"></iframe><iframe src="https://blocked.example/widget"></iframe></body>', { top: true }),
    frame('https://js.stripe.com/v3/x.html', '<body><script>var s = "Pay now";</script><p>Card</p></body>'),
    frame('https://blocked.example/widget', '<body>Pay now</body>', { answers: false }),
  ];
  const r = await waitTextAnyFrame({ text: 'Pay now', timeoutMs: 150 }, topWait(() => false, 150), { pollMs: 20 });
  assert.equal(r.error, 'Timed out waiting for "x"');
  assert.deepEqual(r.frames, { searched: ['https://js.stripe.com'], unsearched: ['https://blocked.example'] });
  assert.match(r.framesHint, /blocked\.example could not be searched/);
});

test('a page with no frames times out exactly as the top wait did', async () => {
  frames = [frame('https://plain.example/', '<body>hello</body>', { top: true })];
  const r = await waitTextAnyFrame({ text: 'bye', timeoutMs: 100 }, topWait(() => false, 100), { pollMs: 20 });
  assert.deepEqual(r, { error: 'Timed out waiting for "x"' });
});
