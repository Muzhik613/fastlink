// node --test — fast_type's focus contract (fast-ext/src/actions/input.js), sliced
// from the source so there is one source of truth, with chrome/CDP stubbed.
// Three parts: inspectFocusInFrame (what ONE frame reports), followFocus (the
// top → iframe → field chain across frames, cross-origin included) and typeText
// (the guards + the verified/reason contract).
// Motivating runs: Azure portal, whose create-VM blade is a cross-origin iframe —
// fast_type {clear:true, force:true} select-all'd the WHOLE PAGE while the probe
// could only see the <iframe>, and later a vision fill typed into the wrong field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../fast-ext/src/actions/input.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\n/gm, '')
  .replace(/^export /gm, '');

// the real frames.js frame tree, bound to a stubbed chrome
const { frameTree: realFrameTree } = await import('../../fast-ext/src/actions/frames.js');
const frameTreeVia = (chrome) => (...a) => { const prev = globalThis.chrome; globalThis.chrome = chrome; try { return realFrameTree(...a); } finally { globalThis.chrome = prev; } };

// One sandbox per test: CDP commands are recorded. Each scripted focus state is
// a map frameId → that frame's report; a probe starts at frame 0 (which moves
// on to the next scripted state) and follows the chain one frame per
// executeScript call, exactly as probeFocus does. A frame with no report is one
// the extension cannot inject into. Every non-top frame of a state is a child
// of the top frame in webNavigation's tree, at BLADE_URL (or `tree` overrides).
const frameIdsCalls = [];
const BLADE_URL = 'https://sandbox-1.reactblade.portal.azure.net/blade';
function stubChrome(states, { tree, sendCommand } = {}) {
  const queue = [...states];
  let cur = {};
  return {
    debugger: { attach: async () => {}, sendCommand: sendCommand || (async () => {}), onDetach: { addListener() {} } },
    storage: { local: { get: async () => ({}) } },
    webNavigation: {
      getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: 'https://portal.azure.com/' },
        ...(tree || Object.keys(cur).filter((k) => k !== '0').map((k) => ({ frameId: Number(k), parentFrameId: 0, url: BLADE_URL })))],
    },
    scripting: {
      executeScript: async ({ target }) => {
        const [id] = target.frameIds;
        frameIdsCalls.push(target.frameIds);
        if (id === 0 && queue.length) cur = queue.shift();
        const r = typeof cur === 'function' ? cur()[id] : cur[id];
        if (!r) throw new Error(`No frame with id ${id}`);
        return [{ frameId: id, result: r }];
      },
    },
  };
}
function sandbox({ injections = [], tree, window: win, document: doc, location: loc } = {}) {
  const cdpCalls = [];
  const chrome = stubChrome(injections, { tree, sendCommand: async (_t, method, params) => { cdpCalls.push({ method, params }); } });
  const getInjectableTab = async () => ({ tab: { id: 1 } });
  const api = new Function('chrome', 'getInjectableTab', 'frameTree', 'window', 'document', 'location', 'navigator',
    `${src}\nreturn { typeText, clickXY, inspectFocusInFrame, followFocus };`)(
    chrome, getInjectableTab, frameTreeVia(chrome), win, doc, loc, { platform: 'Linux x86_64' });
  return { ...api, cdpCalls };
}

// ── inspectFocusInFrame: one frame's report ──────────────────────────────────
const el = (tag, props = {}) => ({
  tagName: tag.toUpperCase(), type: props.type || '', value: props.value,
  isContentEditable: props.contentEditable === true,
  textContent: props.textContent || '',
  getAttribute: (k) => (props.attrs && k in props.attrs ? props.attrs[k] : null),
  ...props,
});
const docWith = (active, body = el('body')) => ({ activeElement: active, body, documentElement: el('html') });
const inFrame = (doc, href = 'https://portal.azure.com/') =>
  sandbox({ document: doc, location: { href, host: new URL(href).host } }).inspectFocusInFrame();

test('the document/body having focus is a fact the probe states, not a null', () => {
  const body = el('body');
  const d = inFrame(docWith(body, body));
  assert.equal(d.tag, 'body');
  assert.equal(d.editable, false);
  assert.match(d.reason, /document itself has focus/);
  assert.equal(inFrame(docWith(null)).tag, 'none');
});

test('a frame whose focus is on an <iframe> names that iframe\'s URL and host', () => {
  const frame = { tagName: 'IFRAME', src: 'https://sandbox-1.reactblade.portal.azure.net/blade', getAttribute: () => null };
  assert.deepEqual(inFrame(docWith(frame)), { tag: 'iframe', src: 'https://sandbox-1.reactblade.portal.azure.net/blade', label: 'sandbox-1.reactblade.portal.azure.net' });
});

test('a field in a frame reports its value and label', () => {
  const input = el('input', { value: 'fastlink-bench-vm', attrs: { 'aria-label': 'Virtual machine name' } });
  const d = inFrame(docWith(input), 'https://sandbox-1.reactblade.portal.azure.net/blade');
  assert.equal(d.editable, true);
  assert.equal(d.value, 'fastlink-bench-vm');
  assert.equal(d.label, 'Virtual machine name');
});

test('focus inside an open shadow root is followed to the real field', () => {
  const inner = el('input', { value: 'x', attrs: { name: 'q' } });
  const host = el('my-field', { shadowRoot: { activeElement: inner } });
  const d = inFrame(docWith(host));
  assert.equal(d.tag, 'input');
  assert.equal(d.label, 'q');
});

test('a password field is editable but NOT readable; a button is neither', () => {
  const pw = inFrame(docWith(el('input', { type: 'password', value: 'hunter22' })));
  assert.equal(pw.editable, true);
  assert.equal(pw.readable, false);
  assert.equal(pw.reason, 'password field: value not readable');
  assert.equal(pw.value, '••••••••');
  const btn = inFrame(docWith(el('button')));
  assert.equal(btn.editable, false);
  assert.match(btn.reason, /holds no editable value/);
});

// ── followFocus: the chain across frames, one injection per level ─────────────
const HOST = 'sandbox-1.reactblade.portal.azure.net';
const BLADE = { tag: 'iframe', src: BLADE_URL, label: HOST };
const field = (value, label = 'Virtual machine name', extra = {}) => ({ tag: 'input', type: 'text', editable: true, readable: true, label, value, valueLen: String(value).length, ...extra });
const BODY = { tag: 'body', type: '', editable: false, readable: true, reason: 'the document itself has focus — no field is focused', label: '', value: '', valueLen: 0 };
// top frame focused on the blade iframe (frame 7), the blade (cross-origin) focused on `inner`
const crossOrigin = (inner) => ({ 0: BLADE, 7: inner });
const topOnly = (d) => ({ 0: d });
const kidsOf = (list) => async (id) => (id === 0 ? list : []);
const follow = (state, kids = Object.keys(state).filter((k) => k !== '0').map((k) => ({ id: Number(k), url: BLADE_URL }))) =>
  sandbox().followFocus(async (id) => state[id] || null, kidsOf(kids));

test('a field inside a CROSS-ORIGIN iframe is found, read and located to its frame', async () => {
  const d = await follow(crossOrigin(field('fastlink-bench-vm')));
  assert.equal(d.editable, true);
  assert.equal(d.readable, true);
  assert.equal(d.value, 'fastlink-bench-vm');
  assert.equal(d.frameId, 7);
  assert.deepEqual(d.frames, [HOST]);
  assert.equal(d.src, undefined, 'bookkeeping does not leak into the descriptor');
});

test('only the frames on the focus chain are injected — never every frame of the page', async () => {
  frameIdsCalls.length = 0;
  const s = sandbox({ injections: [crossOrigin(field('')), crossOrigin(field('vm'))] });
  await s.typeText({ text: 'vm' });
  assert.deepEqual(frameIdsCalls, [[0], [7], [0], [7]], 'probe before + read-back after, two frames each');
});

test('the focused iframe maps to its frame by URL, else origin; same-URL siblings → the one holding focus', async () => {
  const other = 'https://ads.example/x';
  let d = await follow({ 0: BLADE, 3: field('ad', 'Ad'), 7: field('vm') }, [{ id: 3, url: other }, { id: 7, url: BLADE_URL + '#redirected' }]);
  assert.equal(d.frameId, 7, 'same origin when the committed URL differs from src');
  d = await follow({ 0: BLADE, 5: BODY, 7: field('vm') }, [{ id: 5, url: BLADE_URL }, { id: 7, url: BLADE_URL }]);
  assert.equal(d.frameId, 7);
  assert.equal(d.value, 'vm');
});

test('a focused top-frame field ends the chain at frame 0', async () => {
  const d = await follow({ 0: field('top value', 'Search'), 3: field('stale', 'Email') });
  assert.equal(d.label, 'Search');
  assert.equal(d.frameId, 0);
});

test('a focused frame that cannot be injected, or is not in the frame tree, is reachable:false, not a guess', async () => {
  for (const [state, kids] of [[{ 0: BLADE }, [{ id: 7, url: BLADE_URL }]], [{ 0: BLADE }, []]]) {
    const d = await follow(state, kids);
    assert.equal(d.tag, 'iframe');
    assert.equal(d.reachable, false);
    assert.equal(d.readable, false);
    assert.equal(d.frameId, 0);
    assert.match(d.reason, /^unreadable: focus is inside a frame \(sandbox-1\.reactblade\.portal\.azure\.net\) the extension cannot inject into/);
  }
  assert.match((await follow({})).reason, /the page could not be inspected/);
});

// ── typeText: guards ─────────────────────────────────────────────────────────
const UNREACHABLE = { 0: BLADE };   // the blade frame is not in the tree

test('clear:true on a field inside a cross-origin iframe now select-alls that field and replaces', async () => {
  const s = sandbox({ injections: [crossOrigin(field('fastlink-bench-vm')), crossOrigin(field('vm-2'))] });
  const r = await s.typeText({ text: 'vm-2', clear: true });
  assert.equal(r.verified, true);
  assert.deepEqual(r.typedInto.frames, [HOST]);
  const keys = s.cdpCalls.filter(c => c.method === 'Input.dispatchKeyEvent');
  assert.equal(keys.length, 4, 'Ctrl+A down/up then Delete down/up');
  assert.deepEqual(s.cdpCalls.at(-1), { method: 'Input.insertText', params: { text: 'vm-2' } });
});

test('clear:true where focus cannot be inspected is REFUSED — no select-all, nothing typed (the Azure blue page)', async () => {
  const s = sandbox({ injections: [UNREACHABLE] });
  const r = await s.typeText({ text: 'fastlink-bench-vm', clear: true, force: true });
  assert.equal(r.code, 'clear_without_editable_focus');
  assert.match(r.error, /uninspectable <iframe> \(sandbox-1\.reactblade\.portal\.azure\.net\) has focus/);
  assert.match(r.error, /WHOLE PAGE/);
  assert.match(r.hint, /clickCount:3/);
  assert.deepEqual(s.cdpCalls, [], 'no Ctrl+A, no Delete, no insertText');
});

test('the document having focus is refused, force or not — nothing typed either way', async () => {
  for (const args of [{ text: 'x', clear: true, force: true }, { text: 'x', force: true }, { text: 'x' }]) {
    const s = sandbox({ injections: [topOnly(BODY)] });
    const r = await s.typeText(args);
    assert.equal(r.code, 'no_editable_focus');
    assert.match(r.error, /no editable element focused — the document itself has focus/);
    assert.equal(r.focused.tag, 'body');
    assert.deepEqual(s.cdpCalls, []);
  }
});

test('an uninspectable frame without force is refused with the force hint', async () => {
  const s = sandbox({ injections: [UNREACHABLE] });
  const r = await s.typeText({ text: 'x' });
  assert.equal(r.code, 'no_editable_focus');
  assert.match(r.hint, /force:true/);
  assert.deepEqual(s.cdpCalls, []);
});

test('clear:true with a top-frame field focused still select-alls, deletes and types', async () => {
  const s = sandbox({ injections: [topOnly(field('API key 4')), topOnly(field('FastLink key'))] });
  const r = await s.typeText({ text: 'FastLink key', clear: true });
  assert.equal(r.verified, true);
  assert.equal(r.cleared, true);
  const keys = s.cdpCalls.filter(c => c.method === 'Input.dispatchKeyEvent');
  assert.equal(keys[0].params.modifiers, 2);
  assert.equal(keys[0].params.key, 'a');
  assert.equal(keys[2].params.key, 'Delete');
});

// ── typeText: the verified contract ──────────────────────────────────────────
test('a forced write into an uninspectable frame is verified:false with the reason and typedInto', async () => {
  const s = sandbox({ injections: [UNREACHABLE, UNREACHABLE] });
  const r = await s.typeText({ text: 'fastlink-bench-vm', force: true });
  assert.equal(r.verified, false);
  assert.match(r.reason, /^unreadable: focus is inside a frame/);
  assert.equal(r.typedInto.tag, 'iframe');
  assert.equal(r.forced, true);
  assert.equal(Object.keys(r)[0], 'verified', 'the read-back state leads the result');
  assert.equal(s.cdpCalls.filter(c => c.method === 'Input.insertText').length, 1, 'it still typed');
});

test('a write into a cross-origin iframe field is READ BACK now — verified:true without force', async () => {
  const s = sandbox({ injections: [crossOrigin(field('')), crossOrigin(field('fastlink-bench-vm'))] });
  const r = await s.typeText({ text: 'fastlink-bench-vm' });
  assert.equal(r.verified, true);
  assert.equal(r.typedInto.value, 'fastlink-bench-vm');
});

test('a readable field that now holds the text is verified:true; one that reads something else says what', async () => {
  const ok = sandbox({ injections: [topOnly(field('')), topOnly(field('fastlink-bench-vm'))] });
  const good = await ok.typeText({ text: 'fastlink-bench-vm' });
  assert.equal(good.verified, true);
  assert.equal(good.reason, undefined);

  const bad = sandbox({ injections: [topOnly(field('')), topOnly(field('(555) 123-'))] });
  const r = await bad.typeText({ text: '5551234567' });
  assert.equal(r.verified, false);
  assert.match(r.reason, /the field reads "\(555\) 123-" after typing/);
});

test('a value longer than the read-back window says unreadable, not "reads something else"', async () => {
  const long = { ...field('x'.repeat(300) + '…'), valueLen: 900 };
  const s = sandbox({ injections: [topOnly(field('')), topOnly(long)] });
  const r = await s.typeText({ text: 'y'.repeat(400) });
  assert.equal(r.verified, false);
  assert.match(r.reason, /^unreadable: the field holds 900 characters/);
});

// ── force: a coordinate-focused write lands in what was clicked ──────────────
// The live bug (Azure create-VM, vision fill): Resource group / Region / Image
// were dropdowns that take no text focus, so each click left focus on the VM
// name box and each "any valid" was typed THERE — the name read
// "fastlink-bench-vmany validany valid" and every fill reported only "unverified".
test('inspectFocusInFrame: underPointer is true on the field, via its <label>, or via a wrapper holding only it', () => {
  const input = el('input', { value: 'a', matches: () => true });
  assert.equal(inFrame({ ...docWith(input), querySelectorAll: () => [] }).underPointer, true);

  const off = () => el('input', { value: 'a', matches: () => false });
  const viaLabel = off();
  const label = { closest: () => ({ control: viaLabel }), contains: () => false, querySelectorAll: () => [] };
  assert.equal(inFrame({ ...docWith(viaLabel), querySelectorAll: () => [label] }).underPointer, true);

  const wrapped = off();
  const wrapper = { closest: () => null, contains: (x) => x === wrapped, querySelectorAll: () => [wrapped] };
  assert.equal(inFrame({ ...docWith(wrapped), querySelectorAll: () => [wrapper] }).underPointer, true);
});

test('inspectFocusInFrame: underPointer is false when the pointer is over another control, or in another frame', () => {
  const name = el('input', { value: 'fastlink-bench-vm', matches: () => false });
  const dropdown = { closest: () => null, contains: () => false, querySelectorAll: () => [] };
  assert.equal(inFrame({ ...docWith(name), querySelectorAll: () => [dropdown] }).underPointer, false);
  // a form that holds this field AND others is not "the field's wrapper"
  const form = { closest: () => null, contains: () => true, querySelectorAll: () => [name, {}, {}] };
  assert.equal(inFrame({ ...docWith(name), querySelectorAll: () => [form] }).underPointer, false);
  // nothing hovered in this frame: the pointer is in some other frame
  assert.equal(inFrame({ ...docWith(name), querySelectorAll: () => [] }).underPointer, false);
  // a probe that cannot evaluate hover reports nothing rather than a guess
  assert.equal(inFrame(docWith(el('input', { value: '' }))).underPointer, undefined);
});

test('REGRESSION doubled text: a forced type whose click left focus on the previous field types NOTHING', async () => {
  const stale = field('fastlink-bench-vm', 'Virtual machine name', { underPointer: false });
  const s = sandbox({ injections: [crossOrigin(stale)] });
  const r = await s.typeText({ text: 'any valid', force: true });
  assert.equal(r.code, 'focus_not_on_clicked_target');
  assert.match(r.error, /focus is still on <input> \(Virtual machine name\) \(holding "fastlink-bench-vm"\)/);
  assert.match(r.reason, /nothing typed/);
  assert.match(r.hint, /dropdown/);
  assert.deepEqual(s.cdpCalls, [], 'no insertText into the name box');
});

test('REGRESSION doubled text: filling the same field twice with clear:true leaves the value once', async () => {
  // a field model: Ctrl+A+Delete empties it, insertText appends at the caret
  let value = 'fastlink-bench-vm';
  const probe = () => crossOrigin(field(value, 'Virtual machine name', { underPointer: true }));
  const chrome = stubChrome([], {
    sendCommand: async (_t, method, params) => {
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && params.key === 'Delete') value = '';
      if (method === 'Input.insertText') value += params.text;
    },
  });
  chrome.scripting.executeScript = async ({ target }) => [{ frameId: target.frameIds[0], result: probe()[target.frameIds[0]] }];
  chrome.webNavigation.getAllFrames = async () => [{ frameId: 0, parentFrameId: -1, url: 'https://portal.azure.com/' }, { frameId: 7, parentFrameId: 0, url: BLADE_URL }];
  const { typeText } = new Function('chrome', 'getInjectableTab', 'frameTree', 'window', 'document', 'location', 'navigator',
    `${src}\nreturn { typeText };`)(chrome, async () => ({ tab: { id: 1 } }), frameTreeVia(chrome), undefined, undefined, undefined, { platform: 'Linux' });
  for (let i = 0; i < 2; i++) {
    const r = await typeText({ text: 'fastlink-bench-vm', clear: true, force: true });
    assert.equal(r.verified, true);
  }
  assert.equal(value, 'fastlink-bench-vm');
});

test('a forced type whose click DID focus the field types normally; clickXY moves the pointer first and flags a missed focus', async () => {
  const s = sandbox({ injections: [crossOrigin(field('', 'Name', { underPointer: true })), crossOrigin(field('vm', 'Name'))] });
  const r = await s.typeText({ text: 'vm', force: true });
  assert.equal(r.verified, true);

  const c = sandbox({ injections: [crossOrigin(field('fastlink-bench-vm', 'Virtual machine name', { underPointer: false }))] });
  const out = await c.clickXY({ x: 10, y: 20, clickCount: 3 });
  assert.deepEqual(c.cdpCalls[0], { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 10, y: 20, button: 'none', buttons: 0 } });
  assert.equal(c.cdpCalls.filter(k => k.params.type === 'mousePressed').length, 3);
  assert.match(out.hint, /NOT the element that was clicked/);
});
