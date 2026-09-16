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
  // a cross-origin frame's document is closed to the parent; a same-origin one (listed in
  // SAME_ORIGIN_DOCS by src) is open — its own window, with its own http(s) URL
  for (const f of w.document.querySelectorAll('iframe')) Object.defineProperty(f, 'contentDocument', { get: () => (SAME_ORIGIN_DOCS.get(f.getAttribute('src')) || {}).document || null });
  return w;
}

let frames = new Map();   // frameId → { win, parent, url, injected }
const SAME_ORIGIN_DOCS = new Map();   // iframe src → window, for frames the parent may read
const calls = [];
globalThis.chrome = {
  runtime: { lastError: null, getURL: (p) => p },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}) }, onChanged: { addListener() {} } },
  tabs: {
    query: async () => [{ id: 1, url: frames.get(0).url, active: true, windowId: 1 }],
    get: async () => ({ id: 1, url: frames.get(0).url, status: 'complete' }),
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
        const bound = new Function('window', 'document', 'location', 'NodeFilter', 'getComputedStyle', `return (${func.toString()});`)(f.win, f.win.document, f.win.location, f.win.NodeFilter, f.win.getComputedStyle.bind(f.win));
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
  assert.equal(r.framesNote, 'read 1 frame(s) into frames; act on their items by id or text');
  assert.equal(r.frameNotice, undefined, 'a frame that was read is not reported as unreadable');
  assert.equal(r.frames.length, 1);
  const f = r.frames[0];
  assert.deepEqual([f.frame, f.frameId, f.url], ['https://pay.provider.example', 7, undefined]);
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
  assert.deepEqual(r.inFrame, { frame: 'https://pay.provider.example', frameId: 7 });
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
  assert.match(r.error, /matches in the top document and in 1 frame/);
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
  assert.match(r.error, /matches in 2 frame\(s\)/);
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
  assert.equal(r2.frameNotice, '1 frame(s) DOM tools cannot read: https://pay.provider.example at 200,300 400x200 (visible in fast_screenshot only)');
  const snap = await call('fast_snapshot', {});
  assert.match(snap.frameNotice, /cannot read/);
  assert.equal(snap.frames, undefined);
});

test('SAFETY live Azure 5a6edf40: {frame, tag:"button", index:N} with no text is refused — an index is never read as an item id', async () => {
  const { pay } = setup();
  const snap = await call('fast_snapshot', {});
  const pay1 = snap.frames[0].items.find((it) => /Pay now/.test(it.text || ''));
  const n = Number(pay1.i.split(':')[1]);
  let clicked = 0;
  pay.document.querySelector('button').addEventListener('click', () => { clicked++; });
  for (const args of [{ frame: 'pay.provider', tag: 'button', index: n }, { frame: 'pay.provider', role: 'button', index: 0 }, { tag: 'button', index: n }]) {
    const r = await call('fast_click', { ...args, noSnapshot: true });
    assert.match(r.error, /^fast_click needs a target — pass id:".*<i>" \(an item's i from fast_snapshot\) or text:"<label>"; index only picks among matches of text, it is not an item id; nothing was clicked$/, JSON.stringify(r));
  }
  assert.equal(clicked, 0);
  const none = await call('fast_click', { frame: 'pay.provider', noSnapshot: true });
  assert.match(none.error, /^fast_click needs a target — pass id:"f7:<i>"/);
  assert.doesNotMatch(JSON.stringify(none), /undefined/);
});

test('SAFETY: after the frame re-renders and reorders its buttons, an old id is refused — never clicks the new occupant', async () => {
  const { pay } = setup({ payHtml: '<div id="bar"><button id="next">Next</button><button id="back">Back</button></div>' });
  const d = pay.document;
  const snap = await call('fast_snapshot', {});
  const next = snap.frames[0].items.find((it) => it.text === 'Next');
  const hits = [];
  // (1) React reuses the node in place: "Next" now reads "Create"
  d.getElementById('next').textContent = 'Create';
  d.getElementById('next').addEventListener('click', () => hits.push('create'));
  const r1 = await call('fast_click', { id: next.i, noSnapshot: true });
  assert.equal(r1.idStale, true, JSON.stringify(r1));
  assert.match(r1.error, /was "Next" when listed and now reads "Create" — nothing was clicked/);
  assert.equal(r1.labelNow, 'Create');
  // (2) the bar re-renders: every node replaced, order swapped
  const snap2 = await call('fast_snapshot', {});
  const back = snap2.frames[0].items.find((it) => it.text === 'Back');
  d.getElementById('bar').innerHTML = '<button id="del">Delete</button><button id="cancel">Cancel</button>';   // no "Back" any more
  d.getElementById('del').addEventListener('click', () => hits.push('delete'));
  const r2 = await call('fast_click', { id: back.i, noSnapshot: true });
  assert.equal(r2.idStale, true, JSON.stringify(r2));
  assert.match(r2.error, /\("Back"\) is no longer on the page/);
  // (3) an id no snapshot listed (a guess past the end) is refused
  const r3 = await call('fast_click', { id: 'f7:999', noSnapshot: true });
  assert.match(r3.error, /f7:999 was not listed by any snapshot of this page/);
  assert.deepEqual(hits, []);
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


test('live OCI: a form rendered LATE into a SAME-origin frame (URL = the top page URL) is read by the frame path, not missed or listed twice', async () => {
  const OCI = 'https://cloud.example/compute/instances/create?region=us-1';
  const formWin = doc('<h1>Loading…</h1>', OCI);
  SAME_ORIGIN_DOCS.set(OCI, formWin);
  const top = doc(`<header><button>Navigation menu</button></header><iframe src="${OCI}" data-box="0,120,1400,700"></iframe>`, OCI);
  top.eval(PAGE_JS);
  frames = new Map([[0, { win: top, parent: -1, url: OCI }], [5, { win: formWin, parent: 0, url: OCI }]]);
  const first = await call('fast_snapshot', { full: true });
  assert.equal(first.frames.length, 1, JSON.stringify(first).slice(0, 400));
  // the form mounts after the first read
  const d = formWin.document;
  d.body.innerHTML = '<h2>Create compute instance</h2><label for="nm">Name</label><input id="nm" data-box="20,60,300,30"><button data-box="20,120,120,30">Create</button>';
  const snap = await call('fast_snapshot', { full: true });
  const f = snap.frames[0];
  assert.equal(f.frameId, 5);
  const name = f.items.find((it) => it.tag === 'input');
  assert.ok(name, JSON.stringify(f.items));
  assert.deepEqual([name.x, name.y], [20, 180]);
  assert.ok(!snap.items.some((it) => it.tag === 'input'), 'the frame\'s field is not also listed as a top-document item');
  // the model passed the TOP page URL as frame: it is also this frame's URL, so it works
  const r = await call('fast_fill', { frame: OCI, match: 'Name', value: 'bench-vm', noSnapshot: true });
  assert.equal(d.getElementById('nm').value, 'bench-vm', JSON.stringify(r));
  assert.equal(r.verified, true);
  SAME_ORIGIN_DOCS.clear();
});

test('a frame value that names no frame lists the frames (origin + id); a frame id picks one', async () => {
  setup();
  const r = await call('fast_snapshot', { frame: 'https://shop.example/checkout', full: true });
  assert.equal(r.error, 'no frame matches "https://shop.example/checkout" (nothing done); frames: https://pay.provider.example (f7); that is the top page — omit frame');
  const byId = await call('fast_snapshot', { frame: 'f7' });
  assert.equal(byId.inFrame.frameId, 7, 'a frame id picks the frame');
});

test('depth 2: a same-origin frame nested inside a cross-origin frame is read, coordinates added through both frames', async () => {
  const INNER = 'https://pay.provider.example/card-form/inner';
  const innerWin = doc('<label for="z">Postal code</label><input id="z" data-box="5,5,100,20">', INNER);
  SAME_ORIGIN_DOCS.set(INNER, innerWin);
  setup({ payHtml: `<p>outer</p><iframe src="${INNER}" data-box="30,40,300,100"></iframe>` });
  frames.set(11, { win: innerWin, parent: 7, url: INNER });
  const snap = await call('fast_snapshot', {});
  const inner = snap.frames.find((f) => f.frameId === 11);
  assert.ok(inner, JSON.stringify(snap.frames.map((f) => f.frameId)));
  const z = inner.items.find((it) => it.tag === 'input');
  assert.deepEqual([z.x, z.y], [200 + 30 + 5, 300 + 40 + 5]);
  assert.match(z.i, /^f11:/);
  SAME_ORIGIN_DOCS.clear();
});


test('live Azure aef0c734: a text wait that hits inside a frame carries that frame\'s items, in top-page space', async () => {
  setup();
  const r = await call('fast_wait', { text: 'Pay now', timeoutMs: 3000 });
  assert.equal(r.inFrame, true, JSON.stringify(r).slice(0, 400));
  assert.equal(r.found.frameId, 7);
  assert.equal(r.snapshot.frameId, 7);
  const pay = r.snapshot.items.find((it) => /Pay now/.test(it.text || ''));
  assert.ok(pay, JSON.stringify(r.snapshot).slice(0, 400));
  assert.deepEqual([pay.x, pay.y], [220, 400]);
  assert.match(pay.i, /^f7:/);
});

test('a frame that appears after the last fast_snapshot is named once, in one line, on the next action', async () => {
  setup({ topHtml: '<h1>Signing in…</h1>' });
  const pay = frames.get(7);
  frames = new Map([[0, frames.get(0)]]);
  const first = await call('fast_snapshot', {});
  assert.equal(first.frames, undefined);
  // the redirect lands: the form frame renders
  const top = frames.get(0).win;
  const el = top.document.createElement('iframe');
  el.setAttribute('src', PAY); el.setAttribute('data-box', '200,300,400,200');
  Object.defineProperty(el, 'contentDocument', { get: () => null });
  top.document.body.appendChild(el);
  frames.set(7, pay);
  const r = await call('fast_click', { text: 'Nothing like this', noSnapshot: true });
  assert.equal(r.framesAppeared, 'new frame(s) since your last snapshot: https://pay.provider.example f7 (2 items)', JSON.stringify(r).slice(0, 300));
  const again = await call('fast_click', { text: 'Nothing like this', noSnapshot: true });
  assert.equal(again.framesAppeared, undefined, 'said once, not on every call');
});

test('live Azure 639a6714: controls below a frame\'s fold are listed offscreen:true in a full read; an action scrolls them into view in the frame; fast_scroll takes frame', async () => {
  const { pay } = setup({ payHtml: '<h2>Basics</h2><label for="vm">Virtual machine name</label><input id="vm" data-box="20,40,300,30"><label id="rl" data-box="20,900,80,20">Region</label><div role="combobox" aria-labelledby="rl" aria-haspopup="listbox" tabindex="0" data-box="120,900,300,30">(US) East US</div><button data-box="20,1400,160,30">See all images</button>' });
  let scrolled = 0;
  pay.Element.prototype.scrollIntoView = function () { scrolled++; };
  const snap = await call('fast_snapshot', { frame: 'pay.provider', full: true });
  const region = snap.items.find((it) => /East US/.test(it.value || ''));
  const images = snap.items.find((it) => /See all images/.test(it.text || ''));
  assert.ok(region && images, JSON.stringify(snap.items.map((i) => i.text)));
  assert.equal(region.offscreen, true);
  assert.deepEqual([images.offscreen, images.y], [true, 300 + 1400]);
  assert.equal(snap.items.find((it) => it.tag === 'input').offscreen, undefined);
  let clicked = 0;
  pay.document.querySelector('button').addEventListener('click', () => { clicked++; });
  const r = await call('fast_click', { id: images.i, noSnapshot: true });
  assert.equal(clicked, 1, JSON.stringify(r));
  assert.ok(scrolled >= 1, 'scrolled into view inside the frame before the click');
  const sc = await call('fast_scroll', { frame: 'pay.provider', noSnapshot: true });
  assert.equal(sc.inFrame.frameId, 7, JSON.stringify(sc));
  assert.equal(sc.scrolled, true);
});

test('live Azure probe: a frame combobox reads as label (its name) then value, first, even when the name is only an aria-label', async () => {
  setup({ payHtml: '<label id="rl">Region</label><div role="combobox" aria-labelledby="rl" aria-label="Region" tabindex="0" data-box="120,40,300,30">(US) East US</div><div role="combobox" aria-label="Image" tabindex="0" data-box="120,900,300,30">Ubuntu Server 24.04 LTS - x64 Gen2</div>' });
  const snap = await call('fast_snapshot', { frame: 'pay.provider', full: true });
  const image = snap.items.find((it) => /Ubuntu/.test(it.value || ''));
  assert.ok(image, JSON.stringify(snap.items));
  assert.deepEqual(Object.keys(image).slice(0, 4), ['i', 'tag', 'label', 'value']);
  assert.equal(image.label, 'Image');
  assert.equal(image.value, 'Ubuntu Server 24.04 LTS - x64 Gen2');
  assert.equal(image.offscreen, true);
  assert.equal(snap.items.find((it) => /East US/.test(it.value || '')).label, 'Region');
});

test('live Azure a6396ba9: an undeclared dialog (a fixed portal layer holding focus) leads the snapshot with its OK, even when the preview is capped', async () => {
  const many = Array.from({ length: 60 }, (_, k) => `<button data-box="20,${40 + k * 30},120,24">Row action ${k}</button>`).join('');
  const { pay } = setup({ payHtml: `<label for="rg">Resource group</label><div role="combobox" id="rg" aria-label="Resource group" tabindex="0">(New) vm_group</div><button>Create new</button>${many}` });
  const d = pay.document;
  d.querySelector('button').addEventListener('click', () => {
    const layer = d.createElement('div');
    layer.style.position = 'fixed'; layer.setAttribute('data-box', '0,0,1024,768');   // a Fluent layer host covers the viewport
    layer.innerHTML = '<div><p>A resource group is a container that holds related resources.</p><label for="nm">Name</label><input id="nm"><button>OK</button><button>Cancel</button></div>';
    d.body.appendChild(layer);
    d.getElementById('nm').focus();
  });
  const click = await call('fast_click', { frame: 'pay.provider', text: 'Create new' });
  assert.match(String(click.dialogOpened), /resource group/i, JSON.stringify(click).slice(0, 300));
  const snap = click.snapshot;
  assert.ok(snap.dialog, JSON.stringify(Object.keys(snap)));
  assert.deepEqual(snap.dialog.items.map((it) => it.text || it.label), ['Name', 'OK', 'Cancel']);
  const ok = snap.items.find((it) => it.text === 'OK');
  assert.ok(ok && ok.inDialog, 'the capped preview kept the dialog\'s OK');
  assert.match(ok.i, /^f7:/);
  assert.match(snap.dialog.items[1].i, /^f7:/, 'dialog ids are namespaced like the items');
});

// A Create-new dialog that mounts a tick after the click, whose OK stays disabled while the
// name is validated (async), and that applies the new group only when OK is pressed enabled.
function createNewDialog(win, { validateMs = 300, refuse = false } = {}) {
  const d = win.document;
  const state = { applied: null };
  d.getElementById('create').addEventListener('click', () => setTimeout(() => {
    const layer = d.createElement('div');
    layer.style.position = 'fixed'; layer.setAttribute('data-box', '0,0,1024,768');   // a Fluent layer host covers the viewport
    layer.innerHTML = '<p>A resource group is a container</p><label for="nm">Name</label><input id="nm"><button id="ok" disabled>OK</button><button>Cancel</button>';
    d.body.appendChild(layer);
    const nm = d.getElementById('nm'), ok = d.getElementById('ok');
    nm.focus();
    nm.addEventListener('input', () => { ok.disabled = true; setTimeout(() => { ok.disabled = !nm.value; }, validateMs); });
    ok.addEventListener('click', () => { if (ok.disabled || refuse) return; state.applied = nm.value; layer.remove(); d.getElementById('rg').textContent = `(New) ${nm.value}`; });
  }, 40));
  return state;
}
const RG_FORM = '<label for="vmn">Virtual machine name</label><input id="vmn"><label for="rg">Resource group</label><div role="combobox" id="rg" aria-label="Resource group" tabindex="0">(New) vm_group</div><button id="create">Create new</button><button>OK</button>';

test('live Azure a25a6ef7: Create new → fill Name → OK — Name is the dialog field; a disabled OK fails at once and the retry applies the group', async () => {
  const { pay } = setup({ payHtml: RG_FORM });
  const st = createNewDialog(pay, { validateMs: 300 });
  const F = 'pay.provider';
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  await call('fast_fill', { frame: F, match: 'Virtual machine name', value: 'bench-vm', noSnapshot: true });
  await call('fast_click', { frame: F, text: 'Create new', noSnapshot: true });
  await tick(80);   // the next call: the dialog has mounted
  await call('fast_fill', { frame: F, match: 'Name', value: 'bench-rg', noSnapshot: true });
  assert.equal(pay.document.getElementById('nm').value, 'bench-rg');
  assert.equal(pay.document.getElementById('vmn').value, 'bench-vm', 'the VM name field behind the dialog was not touched');
  const t0 = Date.now();
  const early = await call('fast_click', { frame: F, text: 'OK', noSnapshot: true });
  assert.match(early.error, /^"OK" is disabled \(not clicked\)/, JSON.stringify(early).slice(0, 300));
  assert.ok(Date.now() - t0 < 1400, 'refused at once, no wait');
  await tick(350);   // validation done
  const r = await call('fast_click', { frame: F, text: 'OK', noSnapshot: true });
  assert.equal(st.applied, 'bench-rg', JSON.stringify(r).slice(0, 400));
  assert.equal(r.dialogClosed, true);
});

test('a dialog OK the page does not accept is verified:false (dialogStillOpen)', async () => {
  const { pay } = setup({ payHtml: RG_FORM });
  createNewDialog(pay, { validateMs: 10, refuse: true });
  await call('fast_click', { frame: 'pay.provider', text: 'Create new', noSnapshot: true });
  await new Promise((r) => setTimeout(r, 80));
  await call('fast_fill', { frame: 'pay.provider', match: 'Name', value: 'bench-rg', noSnapshot: true });
  await new Promise((r) => setTimeout(r, 50));
  const r2 = await call('fast_click', { frame: 'pay.provider', text: 'OK', noSnapshot: true });
  assert.equal(r2.verified, false, JSON.stringify(r2).slice(0, 400));
  assert.ok(r2.dialogStillOpen);
  assert.match(r2.reason, /still open after clicking "OK"/);
});

test('an action\'s snapshot preview says omitted (an honest count), never truncated:true; an explicit fast_snapshot still does', async () => {
  const many = Array.from({ length: 120 }, (_, k) => `<button>Action number ${k} with a long enough label to fill the preview</button>`).join('');
  setup({ topHtml: `<h1>Big</h1><button id="go">Go</button>${many}` });
  frames = new Map([[0, frames.get(0)]]);
  const r = await call('fast_click', { text: 'Go' });
  assert.equal(r.snapshot.truncated, undefined, JSON.stringify(Object.keys(r.snapshot)));
  assert.ok(r.snapshot.omitted && r.snapshot.omitted.items > 0, JSON.stringify(r.snapshot.omitted));
  assert.equal(Object.keys(r.snapshot)[0], 'omitted');
  const s = await call('fast_snapshot', {});
  assert.equal(s.truncated, true);
});

test('fast_nav waits for the load to complete and returns the page\'s snapshot; noSnapshot skips it', async () => {
  setup({ topHtml: '<h1>Create a resource</h1><label for="n">Name</label><input id="n">' });
  frames = new Map([[0, frames.get(0)]]);
  const t0 = Date.now();
  const saved = { get: chrome.tabs.get, update: chrome.tabs.update };
  chrome.tabs.update = async () => ({});
  chrome.tabs.get = async () => ({ id: 1, url: SHOP, status: Date.now() - t0 > 200 ? 'complete' : 'loading' });
  const r = await call('fast_nav', { url: SHOP });
  assert.ok(Date.now() - t0 >= 200, 'waited for the load');
  assert.ok(Date.now() - t0 < 1500, 'no extra settle window');
  assert.equal(r.url, SHOP);
  assert.ok(r.snapshot && r.snapshot.items.some((it) => it.tag === 'input'), JSON.stringify(r.snapshot).slice(0, 300));
  const skip = await call('fast_nav', { url: SHOP, noSnapshot: true });
  chrome.tabs.get = saved.get; chrome.tabs.update = saved.update;
  assert.equal(skip.snapshot, undefined);
});


test('a successful click names what it hit in one short string: clicked:"<label or text>"', async () => {
  const { pay } = setup();
  const snap = await call('fast_snapshot', {});
  const payBtn = snap.frames[0].items.find((it) => /Pay now/.test(it.text || ''));
  const r = await call('fast_click', { id: payBtn.i, noSnapshot: true });
  assert.equal(r.clicked, 'Pay now', JSON.stringify(r));
});

test('live Azure 0a0b5258: a fixed top header strip holding the focused search box is NOT a dialog; a centred callout layer still is', async () => {
  const { pay } = setup({ payHtml: '<label for="q">Search</label><input id="q"><p>Form body</p><button>Create new</button>' });
  const d = pay.document;
  const header = d.createElement('div');
  header.style.position = 'fixed';
  header.setAttribute('data-box', '0,0,1024,48');
  header.innerHTML = '<button>Show portal menu</button><label for="s">Search resources</label><input id="s">';
  d.body.appendChild(header);
  d.getElementById('s').focus();
  const snap = await call('fast_snapshot', { frame: 'pay.provider' });
  assert.equal(snap.dialog, undefined, JSON.stringify(snap.dialog));
  const nav = d.createElement('div');
  nav.style.position = 'fixed';
  nav.setAttribute('data-box', '0,0,400,768');   // big enough, but it holds the main navigation
  nav.innerHTML = '<nav><button>Home</button></nav><input id="n">';
  d.body.appendChild(nav);
  d.getElementById('n').focus();
  assert.equal((await call('fast_snapshot', { frame: 'pay.provider' })).dialog, undefined, 'a navigation landmark is not a dialog');
  const callout = d.createElement('div');
  callout.style.position = 'fixed';
  callout.setAttribute('data-box', '300,200,420,300');
  callout.innerHTML = '<p>A resource group is a container</p><label for="nm">Name</label><input id="nm"><button>OK</button>';
  d.body.appendChild(callout);
  d.getElementById('nm').focus();
  const s2 = await call('fast_snapshot', { frame: 'pay.provider' });
  assert.equal(s2.dialog && s2.dialog.label, 'A resource group is a container', JSON.stringify(s2.dialog));
});

test('live Azure 0a0b5258: fast_nav waits out a login redirect chain and reports it; an ordinary page pays nothing; a real sign-in page returns after a short hold', async () => {
  setup({ topHtml: '<h1>Create a resource</h1><label for="n">Name</label><input id="n">' });
  frames = new Map([[0, frames.get(0)]]);
  const saved = { get: chrome.tabs.get, update: chrome.tabs.update };
  chrome.tabs.update = async () => ({});
  const script = (steps) => { const t0 = Date.now(); return async () => { const ms = Date.now() - t0; const s = steps.find((x) => ms < x.until) || steps[steps.length - 1]; return { id: 1, url: s.url, status: s.status }; }; };
  const APP = 'https://portal.example/create/vm';
  try {
    // ordinary: loads at the asked URL
    chrome.tabs.get = script([{ until: 100, url: APP, status: 'loading' }, { until: Infinity, url: APP, status: 'complete' }]);
    let t0 = Date.now();
    let r = await call('fast_nav', { url: APP, noSnapshot: true });
    assert.ok(Date.now() - t0 < 400, `ordinary page took ${Date.now() - t0}ms`);
    assert.equal(r.redirected, undefined);
    // chain: /auth/login/ loads, then forwards to the app
    chrome.tabs.get = script([
      { until: 150, url: 'https://portal.example/auth/login/', status: 'loading' },
      { until: 500, url: 'https://portal.example/auth/login/', status: 'complete' },
      { until: 700, url: APP, status: 'loading' },
      { until: Infinity, url: APP, status: 'complete' },
    ]);
    t0 = Date.now();
    r = await call('fast_nav', { url: APP, noSnapshot: true });
    assert.ok(Date.now() - t0 >= 700, `returned at ${Date.now() - t0}ms, before the app loaded`);
    assert.equal(r.url, APP);
    assert.deepEqual(r.redirected, ['portal.example/auth/login/']);
    // a real sign-in page: stays on /signin — returned after the hold, not at waitMs
    chrome.tabs.get = script([{ until: Infinity, url: 'https://login.example/signin', status: 'complete' }]);
    t0 = Date.now();
    r = await call('fast_nav', { url: APP, noSnapshot: true, waitMs: 10000 });
    const ms = Date.now() - t0;
    assert.ok(ms >= 2900 && ms < 4500, `sign-in page took ${ms}ms`);
    assert.equal(r.url, 'https://login.example/signin');
  } finally { chrome.tabs.get = saved.get; chrome.tabs.update = saved.update; }
});


// A picker panel whose option list is rebuilt (new nodes, same labels) after the model's read.
function pickerPanel(win, labels) {
  const d = win.document;
  const list = d.getElementById('opts');
  const hits = [];
  const render = (ls) => { list.innerHTML = ls.map((l) => `<div role="option" tabindex="0">${l}</div>`).join(''); for (const o of list.children) o.addEventListener('click', () => hits.push(o.textContent)); };
  render(labels);
  return { hits, render };
}

test('live Oracle dd2cf71c: an id whose option was re-rendered is re-resolved by its label when exactly one visible option carries it', async () => {
  const { pay } = setup({ payHtml: '<div role="listbox" id="opts"></div>' });
  const p = pickerPanel(pay, ['Oracle Linux 9', 'Ubuntu', 'Windows']);
  const snap = await call('fast_snapshot', {});
  const ub = snap.frames[0].items.find((it) => it.text === 'Ubuntu');
  p.render(['Oracle Linux 9', 'Ubuntu', 'Windows', 'Rocky Linux']);   // rebuilt: every node new
  const r = await call('fast_click', { id: ub.i, noSnapshot: true });
  assert.equal(r.reResolved, true, JSON.stringify(r));
  assert.equal(r.clicked, 'Ubuntu');
  assert.deepEqual(p.hits, ['Ubuntu']);
});

test('re-resolve refuses when two visible options now carry the label, and when the label is gone', async () => {
  const { pay } = setup({ payHtml: '<div role="listbox" id="opts"></div>' });
  const p = pickerPanel(pay, ['Oracle Linux 9', 'Ubuntu']);
  const snap = await call('fast_snapshot', {});
  const ub = snap.frames[0].items.find((it) => it.text === 'Ubuntu');
  p.render(['Ubuntu', 'Ubuntu']);
  const two = await call('fast_click', { id: ub.i, noSnapshot: true });
  assert.equal(two.idStale, true, JSON.stringify(two));
  const snap2 = await call('fast_snapshot', {});
  const ub2 = snap2.frames[0].items.find((it) => it.text === 'Ubuntu');
  p.render(['Oracle Linux 9', 'Debian']);
  const gone = await call('fast_click', { id: ub2.i, noSnapshot: true });
  assert.equal(gone.idStale, true, JSON.stringify(gone));
  assert.deepEqual(p.hits, []);
});

test('a text click that misses while the document is mid-render gets one short retry', async () => {
  const { pay } = setup({ payHtml: '<div role="listbox" id="opts"><div role="option">Loading…</div></div>' });
  const d = pay.document;
  let n = 0;
  const tick = setInterval(() => { const el = d.createElement('span'); el.textContent = `spinner ${n++}`; d.body.appendChild(el); }, 100);
  setTimeout(() => { const o = d.createElement('div'); o.setAttribute('role', 'option'); o.textContent = 'Ampere A1'; d.getElementById('opts').appendChild(o); }, 1800);
  const t0 = Date.now();
  const r = await call('fast_click', { frame: 'pay.provider', text: 'Ampere A1', noSnapshot: true });
  clearInterval(tick);
  assert.equal(r.clicked, 'Ampere A1', JSON.stringify(r));
  assert.ok(Date.now() - t0 < 2600, `took ${Date.now() - t0}ms`);
});

test('live Oracle 46acec38: an id handed out by a wait hit is recorded (clickable by id); a same-label duplicate that is one control (card + its radio) still re-resolves', async () => {
  const { pay } = setup({ payHtml: '<div id="panel"></div><button id="arm">Arm-based processor</button>' });
  const d = pay.document;
  const hits = [];
  const render = () => {
    d.getElementById('panel').innerHTML = ['Oracle Linux 9', 'Canonical Ubuntu'].map((l, k) => `<div role="radio" tabindex="0" id="card${k}"><input type="radio" id="r${k}" name="os"><label for="r${k}">${l}</label></div>`).join('');
    for (const c of d.querySelectorAll('[role=radio]')) c.addEventListener('click', () => hits.push(c.textContent));
  };
  render();
  // the id comes from a wait inside the frame, never from a snapshot
  await call('fast_snapshot', {});                       // builds the frame's index
  pay.__fastlinkIndex.served.clear();                      // …but forget every id it listed: the wait alone hands out the id
  const w = await call('fast_wait', { frame: 'pay.provider', text: 'Arm-based processor', timeoutMs: 2000, noSnapshot: true });
  assert.ok(w.found && typeof w.found.i === 'string', JSON.stringify(w));
  let armClicks = 0; d.getElementById('arm').addEventListener('click', () => { armClicks++; });
  const byWaitId = await call('fast_click', { id: w.found.i, noSnapshot: true });
  assert.equal(byWaitId.idStale, undefined, JSON.stringify(byWaitId));
  assert.equal(armClicks, 1);
  // card id from a snapshot, then the panel is rebuilt: the label shows twice (card text + radio label), same control
  const snap = await call('fast_snapshot', {});
  const card = snap.frames[0].items.find((it) => it.tag === 'div' && /Canonical Ubuntu/.test(it.text || ''));
  assert.ok(card, JSON.stringify(snap.frames[0].items));
  render();
  hits.length = 0;
  const r = await call('fast_click', { id: card.i, noSnapshot: true });
  assert.equal(r.reResolved, true, JSON.stringify(r));
  assert.deepEqual(hits, ['Canonical Ubuntu']);
});
