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
  assert.match(r.framesNote, /^1 frame\(s\) read into `frames` \(https:\/\/pay\.provider\.example\)/);
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
  assert.match(r2.frameNotice, /^1 visible frame\(s\) DOM tools could not read: https:\/\/pay\.provider\.example at x:200, y:300, 400x200\. Their content is visible in fast_screenshot, but DOM tools cannot target it\.$/);
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

test('a frame value that names no frame lists the frame URLs that exist', async () => {
  setup();
  const r = await call('fast_snapshot', { frame: 'https://shop.example/checkout', full: true });
  assert.match(r.error, /^no visible frame URL contains "https:\/\/shop\.example\/checkout" — nothing was done; the frames on this page are: https:\/\/pay\.provider\.example\/card-form \(the value you passed is the top page URL: omit frame to act on the top document\)$/);
  assert.equal(r.frames[0].url, PAY);
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
  assert.match(r.framesAppeared, /^frames appeared since your last snapshot: https:\/\/pay\.provider\.example\/card-form \(2 items\) — fast_snapshot lists their items under frames$/, JSON.stringify(r).slice(0, 300));
  const again = await call('fast_click', { text: 'Nothing like this', noSnapshot: true });
  assert.equal(again.framesAppeared, undefined, 'said once, not on every call');
});

test('live Azure 639a6714: controls below a frame\'s fold are listed offscreen:true in a full read; an action scrolls them into view in the frame; fast_scroll takes frame', async () => {
  const { pay } = setup({ payHtml: '<h2>Basics</h2><label for="vm">Virtual machine name</label><input id="vm" data-box="20,40,300,30"><label id="rl" data-box="20,900,80,20">Region</label><div role="combobox" aria-labelledby="rl" aria-haspopup="listbox" tabindex="0" data-box="120,900,300,30">(US) East US</div><button data-box="20,1400,160,30">See all images</button>' });
  let scrolled = 0;
  pay.Element.prototype.scrollIntoView = function () { scrolled++; };
  const snap = await call('fast_snapshot', { frame: 'pay.provider', full: true });
  const region = snap.items.find((it) => /East US/.test(it.text || ''));
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
  const image = snap.items.find((it) => /Ubuntu/.test(it.text || ''));
  assert.ok(image, JSON.stringify(snap.items));
  assert.deepEqual(Object.keys(image).slice(0, 4), ['i', 'tag', 'label', 'value']);
  assert.equal(image.label, 'Image');
  assert.equal(image.value, 'Ubuntu Server 24.04 LTS - x64 Gen2');
  assert.equal(image.offscreen, true);
  assert.equal(snap.items.find((it) => /East US/.test(it.text || '')).label, 'Region');
});

test('live Azure a6396ba9: an undeclared dialog (a fixed portal layer holding focus) leads the snapshot with its OK, even when the preview is capped', async () => {
  const many = Array.from({ length: 60 }, (_, k) => `<button data-box="20,${40 + k * 30},120,24">Row action ${k}</button>`).join('');
  const { pay } = setup({ payHtml: `<label for="rg">Resource group</label><div role="combobox" id="rg" aria-label="Resource group" tabindex="0">(New) vm_group</div><button>Create new</button>${many}` });
  const d = pay.document;
  d.querySelector('button').addEventListener('click', () => {
    const layer = d.createElement('div');
    layer.style.position = 'fixed';
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
    layer.style.position = 'fixed';
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

test('live Azure a25a6ef7: batch [fill VM name, click Create new, fill Name, click OK] — the dialog mounts first, Name is the dialog field, OK waits to be enabled, the group is applied', async () => {
  const { pay } = setup({ payHtml: RG_FORM });
  const st = createNewDialog(pay);
  const F = 'pay.provider';
  const r1 = await call('fast_fill', { frame: F, match: 'Virtual machine name', value: 'bench-vm', noSnapshot: true });
  const r2 = await call('fast_click', { frame: F, text: 'Create new', noSnapshot: true });
  assert.ok(r2.dialogOpened, JSON.stringify(r2).slice(0, 300));
  const r3 = await call('fast_fill', { frame: F, match: 'Name', value: 'bench-rg', noSnapshot: true });
  assert.equal(pay.document.getElementById('nm').value, 'bench-rg', JSON.stringify(r3).slice(0, 300));
  assert.equal(pay.document.getElementById('vmn').value, 'bench-vm', 'the VM name field behind the dialog was not touched');
  const r4 = await call('fast_click', { frame: F, text: 'OK', noSnapshot: true });
  assert.equal(st.applied, 'bench-rg', JSON.stringify(r4).slice(0, 400));
  assert.equal(r4.dialogClosed, true);
  assert.equal(r4.verified, undefined);
  assert.equal(r1.verified, true);
});

test('a dialog OK that stays disabled is refused; one the page does not accept is verified:false (dialogStillOpen)', async () => {
  const { pay } = setup({ payHtml: RG_FORM });
  createNewDialog(pay, { validateMs: 5000 });
  await call('fast_click', { frame: 'pay.provider', text: 'Create new', noSnapshot: true });
  await call('fast_fill', { frame: 'pay.provider', match: 'Name', value: 'bench-rg', noSnapshot: true });
  const r = await call('fast_click', { frame: 'pay.provider', text: 'OK', noSnapshot: true });
  assert.match(r.error, /^"OK" is disabled — nothing was clicked/, JSON.stringify(r).slice(0, 300));

  const { pay: pay2 } = setup({ payHtml: RG_FORM });
  createNewDialog(pay2, { validateMs: 10, refuse: true });
  await call('fast_click', { frame: 'pay.provider', text: 'Create new', noSnapshot: true });
  await call('fast_fill', { frame: 'pay.provider', match: 'Name', value: 'bench-rg', noSnapshot: true });
  const r2 = await call('fast_click', { frame: 'pay.provider', text: 'OK', noSnapshot: true });
  assert.equal(r2.verified, false, JSON.stringify(r2).slice(0, 400));
  assert.ok(r2.dialogStillOpen);
  assert.match(r2.reason, /still open after clicking "OK"/);
});
