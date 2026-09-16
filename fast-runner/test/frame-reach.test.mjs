// node --test — DOM tools inside cross-origin frames (fast-ext/src/actions/frames.js
// snapshotWithFrames / actWithFrames, wired through index.js dispatchAction). The REAL
// page.js runs in a jsdom top document and a jsdom cross-origin frame document; the
// stubbed chrome routes executeScript by frameIds, injects page.js files on demand,
// and answers webNavigation.getAllFrames. Live motivation (Azure): the whole work area
// is one cross-origin blade frame, and every fast_click by text died in the top document.
// Fixture here is non-Azure: a shop checkout whose card form is a payment-provider frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const PAGE_JS = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');

// jsdom has no layout: every element gets a box from data-box="x,y,w,h", else a
// 120x24 box stacked by document order (visible, on screen).
function doc(html, url) {
  const dom = new JSDOM(`<body>${html}</body>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let n = 0;
  const boxes = new WeakMap();
  w.Element.prototype.getBoundingClientRect = function () {
    if (!boxes.has(this)) {
      const b = this.getAttribute('data-box');
      const [x, y, wd, h] = b ? b.split(',').map(Number) : [10, 10 + 30 * (n++ % 20), 120, 24];
      boxes.set(this, { x, y, left: x, top: y, width: wd, height: h, right: x + wd, bottom: y + h });
    }
    return boxes.get(this);
  };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  for (const f of w.document.querySelectorAll('iframe')) Object.defineProperty(f, 'contentDocument', { get: () => null });
  return w;
}

let frames = new Map();   // frameId → { win, parent, url, injected }
const calls = [];
globalThis.chrome = {
  runtime: { lastError: null, getURL: (p) => p },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}) }, onChanged: { addListener() {} } },
  tabs: {
    query: async () => [{ id: 1, url: frames.get(0).url, active: true, windowId: 1 }],
    get: async () => ({ id: 1, url: frames.get(0).url }),
    sendMessage: () => {}, onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
  },
  windows: { getAll: async () => [] },
  debugger: { onDetach: { addListener() {} } },
  webRequest: { onBeforeRequest: { addListener() {} }, onCompleted: { addListener() {} }, onErrorOccurred: { addListener() {} } },
  webNavigation: {
    getAllFrames: async () => [...frames].map(([frameId, f]) => ({ frameId, parentFrameId: f.parent, url: f.url })),
  },
  scripting: {
    executeScript: async ({ target, func, args, files, world }) => {
      const ids = target.frameIds || [0];
      calls.push({ ids, world, files: !!files });
      return ids.map((frameId) => {
        const f = frames.get(frameId);
        if (!f) throw new Error(`No frame with id ${frameId}`);
        if (files) { if (!f.win.__fastlink) f.win.eval(PAGE_JS); f.injected = true; return { frameId, result: null }; }
        const bound = new Function('window', `return (${func.toString()});`)(f.win);
        return { frameId, result: bound(...(args || [])) };
      }).map(async (r) => ({ frameId: r.frameId, result: await r.result }));
    },
  },
};
// executeScript returns an array of promises above; resolve them
const exec = globalThis.chrome.scripting.executeScript;
globalThis.chrome.scripting.executeScript = async (o) => Promise.all(await exec(o));

const { dispatchAction } = await import('../../fast-ext/src/actions/index.js');
const call = async (action, args) => { const r = await dispatchAction(action, args); return r.result || r; };

const SHOP = 'https://shop.example/checkout';
const PAY = 'https://pay.provider.example/card-form';
function setup({ topHtml, payHtml, payBox = '200,300,400,200', second } = {}) {
  const top = doc(topHtml ?? `<h1>Checkout</h1><label for="em">Email</label><input id="em"><iframe src="${PAY}" data-box="${payBox}"></iframe>${second ? `<iframe src="${second.url}" data-box="${second.box}"></iframe>` : ''}`, SHOP);
  top.eval(PAGE_JS);   // the manifest's content script in the top document
  frames = new Map([[0, { win: top, parent: -1, url: SHOP }]]);
  frames.set(7, { win: doc(payHtml ?? '<label for="cn">Card number</label><input id="cn" data-box="20,40,200,30"><button data-box="20,100,120,30">Pay now</button>', PAY), parent: 0, url: PAY });
  if (second) frames.set(9, { win: doc(second.html, second.url), parent: 0, url: second.url });
  calls.length = 0;
  return { top, pay: frames.get(7).win };
}

test('fast_snapshot lists the frame\'s items in top-page space with namespaced ids; page.js injected into the frame in the MAIN world', async () => {
  setup();
  const r = await call('fast_snapshot', {});
  assert.match(r.framesNote, /^1 cross-origin frame\(s\) read into `frames` \(https:\/\/pay\.provider\.example\)/);
  assert.equal(r.frameNotice, undefined, 'a frame that was read is not reported as unreadable');
  assert.equal(r.frames.length, 1);
  const f = r.frames[0];
  assert.deepEqual([f.frame, f.frameId, f.url], ['https://pay.provider.example', 7, PAY]);
  assert.deepEqual(f.box, { x: 200, y: 300, w: 400, h: 200 });
  const pay = f.items.find((it) => /Pay now/.test(it.text || ''));
  assert.ok(pay, JSON.stringify(f.items));
  assert.equal(pay.x, 200 + 20);
  assert.equal(pay.y, 300 + 100);
  assert.match(pay.i, /^f7:\d+$/);
  assert.ok(calls.some((c) => c.files && c.ids[0] === 7 && c.world === 'MAIN'));
});

test('fast_click {text} whose target is only in the frame acts there, without the top auto-wait, and says where', async () => {
  const { pay } = setup();
  let clicked = 0;
  pay.document.querySelector('button').addEventListener('click', () => { clicked++; });
  const t0 = Date.now();
  const r = await call('fast_click', { text: 'Pay now', noSnapshot: true });
  assert.equal(clicked, 1, JSON.stringify(r));
  assert.ok(Date.now() - t0 < 1400, `took ${Date.now() - t0}ms — the top document's 1.5s auto-wait was paid`);
  assert.deepEqual(r.inFrame, { frame: 'https://pay.provider.example', url: PAY, frameId: 7 });
});

test('fast_fill {fields} splits by document: Email in the top, Card number in the frame, read back in the frame, card masked', async () => {
  const { top, pay } = setup();
  const r = await call('fast_fill', { fields: { Email: 'a@b.com', 'Card number': '4242 4242 4242 4242' }, noSnapshot: true });
  assert.equal(top.document.getElementById('em').value, 'a@b.com');
  assert.equal(pay.document.getElementById('cn').value, '4242 4242 4242 4242');
  assert.equal(r.verified, true, JSON.stringify(r));
  assert.deepEqual(Object.keys(r.fields), ['Email', 'Card number']);
  assert.equal(r.fields['Card number'].frame, 'https://pay.provider.example');
  assert.equal(r.fields['Card number'].verified, true);
  assert.doesNotMatch(JSON.stringify(r), /4242 4242 4242 4242|4242424242424242/);
  assert.match(r.fields['Card number'].value, /^•••• 4242$/);
});

test('a label in the top document AND a frame is refused with candidates from both; frame:"…" then picks one', async () => {
  const { top, pay } = setup({ payHtml: '<label for="e2">Email</label><input id="e2">' });
  const r = await call('fast_fill', { match: 'Email', value: 'x@y.z', noSnapshot: true });
  assert.match(r.error, /matches in the top document and in 1 cross-origin frame/);
  assert.deepEqual(r.candidates.map((c) => c.frame), ['top', 'https://pay.provider.example']);
  assert.equal(top.document.getElementById('em').value, '');
  assert.equal(pay.document.getElementById('e2').value, '');
  const r2 = await call('fast_fill', { match: 'Email', value: 'x@y.z', frame: 'pay.provider', noSnapshot: true });
  assert.equal(pay.document.getElementById('e2').value, 'x@y.z', JSON.stringify(r2));
  assert.equal(r2.inFrame.frameId, 7);
});

test('two frames holding the same button: refused; an id from the snapshot clicks the right one', async () => {
  const OTHER = 'https://ads.example/unit';
  setup({ second: { url: OTHER, box: '700,300,300,250', html: '<button data-box="10,10,120,30">Pay now</button>' } });
  const r = await call('fast_click', { text: 'Pay now', noSnapshot: true });
  assert.match(r.error, /matches in 2 cross-origin frame\(s\)/);
  const snap = await call('fast_snapshot', {});
  const inPay = snap.frames.find((f) => f.frameId === 7).items.find((it) => /Pay now/.test(it.text || ''));
  let clicked = 0;
  frames.get(7).win.document.querySelector('button').addEventListener('click', () => { clicked++; });
  const r2 = await call('fast_click', { id: inPay.i, noSnapshot: true });
  assert.equal(clicked, 1, JSON.stringify(r2));
  // a stale frame id is refused, not guessed
  const r3 = await call('fast_click', { id: 'f99:1', noSnapshot: true });
  assert.equal(r3.idStale, true);
});

test('no cross-origin frame on screen: the top call runs as before, nothing is injected into frames', async () => {
  setup({ topHtml: '<h1>Plain</h1><button>Go</button>' });
  frames = new Map([[0, frames.get(0)]]);
  let clicked = 0;
  frames.get(0).win.document.querySelector('button').addEventListener('click', () => { clicked++; });
  const r = await call('fast_click', { text: 'Go', noSnapshot: true });
  assert.equal(clicked, 1, JSON.stringify(r));
  assert.equal(r.inFrame, undefined);
  assert.ok(calls.every((c) => c.ids[0] === 0));
});

test('a miss names only the frames that could NOT be read; a miss with every frame read carries no notice', async () => {
  setup();
  const r = await call('fast_click', { text: 'Nowhere at all', noSnapshot: true });
  assert.ok(r.error);
  assert.equal(r.frameNotice, undefined, 'the payment frame was read and searched');
  // the frame is on screen but the extension has no frame for it (another extension's page, a torn-down frame)
  setup();
  frames.delete(7);
  const r2 = await call('fast_click', { text: 'Nowhere at all', noSnapshot: true });
  assert.match(r2.frameNotice, /^1 visible cross-origin frame\(s\) DOM tools could not read: https:\/\/pay\.provider\.example at x:200, y:300, 400x200\. Their content is visible in fast_screenshot, but DOM tools cannot target it\.$/);
  const snap = await call('fast_snapshot', {});
  assert.match(snap.frameNotice, /could not read/);
  assert.equal(snap.frames, undefined);
});

test('live Azure: {frame, role:"button", index:N} with no text clicks snapshot item N of that frame, never "undefined"', async () => {
  setup();
  const snap = await call('fast_snapshot', {});
  const f = snap.frames[0];
  const pay = f.items.find((it) => /Pay now/.test(it.text || ''));
  const cardInput = f.items.find((it) => it.tag === 'input');
  const n = Number(pay.i.split(':')[1]);
  let clicked = 0;
  frames.get(7).win.document.querySelector('button').addEventListener('click', () => { clicked++; });
  const r = await call('fast_click', { frame: 'pay.provider', role: 'button', index: n, noSnapshot: true });
  assert.equal(clicked, 1, JSON.stringify(r));
  assert.equal(r.inFrame.frameId, 7);
  // an index whose item is not a button: refused, naming the exact id form
  const m = Number(cardInput.i.split(':')[1]);
  const bad = await call('fast_click', { frame: 'pay.provider', role: 'button', index: m, noSnapshot: true });
  assert.match(bad.error, new RegExp(`index ${m} \\(read as snapshot item i:${m}, since no text was given\\) is a <input>.*pass id:"f7:<i>"`));
  assert.equal(clicked, 1);
  // no text, no id, no index: the two valid forms with the real frame id
  const none = await call('fast_click', { frame: 'pay.provider', role: 'button', noSnapshot: true });
  assert.match(none.error, /^fast_click needs a target — pass id:"f7:<i>" \(an item's i from fast_snapshot\) or text:"<label>"/);
  assert.doesNotMatch(JSON.stringify([r, bad, none]), /undefined/);
});

test('index with no text and no frame, while frames are on screen: refused with every exact id form', async () => {
  setup();
  const r = await call('fast_click', { role: 'button', index: 3, noSnapshot: true });
  assert.match(r.error, /^index:3 with no text is ambiguous on this page — nothing was clicked; pass id:"3" for snapshot item 3 of the top document, id:"f7:3" for item 3 in https:\/\/pay\.provider\.example, or text:"<label>"$/);
});

test('fast_snapshot puts frames right after url/title, before the top document\'s own items', async () => {
  setup();
  const keys = Object.keys(await call('fast_snapshot', {}));
  assert.ok(keys.indexOf('frames') < keys.indexOf('items'), keys.join(','));
});

test('a click in a frame that lands on a dropdown trigger carries the fast_select_option hint, as in the top document', async () => {
  setup({ payHtml: '<label id="rl">Region</label><div role="combobox" aria-labelledby="rl" aria-haspopup="listbox" aria-expanded="false" tabindex="0">(US) East US</div>' });
  const r = await call('fast_click', { frame: 'pay.provider', text: '(US) East US', noSnapshot: true });
  assert.equal(r.inFrame.frameId, 7, JSON.stringify(r));
  assert.match(r.hint || '', /fast_select_option/, JSON.stringify(r));
});

test('fast_select_option on a portalled listbox inside the frame (Fluent-shaped) picks and reads back there', async () => {
  const { pay } = setup({ payHtml: '<label id="rl">Region</label><div role="combobox" id="Dropdown90" tabindex="0" aria-labelledby="rl" aria-haspopup="listbox" aria-expanded="false"><span class="t">(US) East US</span></div>' });
  const d = pay.document, cb = d.getElementById('Dropdown90');
  pay.Element.prototype.scrollIntoView = function () {};
  cb.addEventListener('click', () => {
    if (cb.getAttribute('aria-expanded') === 'true') return;
    const layer = d.createElement('div'); layer.className = 'ms-Layer';
    const lb = d.createElement('div'); lb.setAttribute('role', 'listbox'); lb.id = 'Dropdown90-list';
    for (const text of ['(US) East US', '(Asia Pacific) Japan East']) {
      const o = d.createElement('button'); o.setAttribute('role', 'option'); o.textContent = text;
      o.addEventListener('click', () => { cb.querySelector('.t').textContent = text; layer.remove(); cb.setAttribute('aria-expanded', 'false'); });
      lb.appendChild(o);
    }
    layer.appendChild(lb); d.body.appendChild(layer); cb.setAttribute('aria-expanded', 'true');
  });
  const r = await call('fast_select_option', { field: 'Region', option: '(Asia Pacific) Japan East', noSnapshot: true });
  assert.equal(cb.querySelector('.t').textContent, '(Asia Pacific) Japan East', JSON.stringify(r).slice(0, 500));
  assert.equal(r.verified, true);
  assert.equal(r.inFrame.frameId, 7);
});
