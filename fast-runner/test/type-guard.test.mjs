// node --test — fast_type's focus contract (fast-ext/src/actions/input.js), sliced
// from the source so there is one source of truth, with chrome/CDP stubbed.
// Two halves: inspectActiveElement (what the top frame can see and read) and
// typeText (the clear:true select-all guard + the verified/reason contract).
// Motivating run: Azure portal, cross-origin blade iframe — fast_type {clear:true,
// force:true} select-all'd the WHOLE PAGE (two screenshots show it blue) and the
// call reported success, so the agent claimed a VM name it never set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../fast-ext/src/actions/input.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\n/m, '')
  .replace(/^export /gm, '');

// One sandbox per test: CDP commands are recorded, the focus probe is scripted.
function sandbox({ probes = [], document: doc, location: loc } = {}) {
  const cdpCalls = [];
  const chrome = {
    debugger: {
      attach: async () => {},
      sendCommand: async (_t, method, params) => { cdpCalls.push({ method, params }); },
      onDetach: { addListener() {} },
    },
    storage: { local: { get: async () => ({}) } },
  };
  const queue = [...probes];
  const injectInTab = async () => ({ tab: { id: 1 }, result: queue.length ? queue.shift() : null });
  const getInjectableTab = async () => ({ tab: { id: 1 } });
  const api = new Function('chrome', 'getInjectableTab', 'injectInTab', 'document', 'location', 'navigator',
    `${src}\nreturn { typeText, inspectActiveElement };`)(
    chrome, getInjectableTab, injectInTab, doc, loc, { platform: 'Linux x86_64' });
  return { ...api, cdpCalls };
}

// ── inspectActiveElement: the probe that decides everything ──────────────────
const el = (tag, props = {}) => ({
  tagName: tag.toUpperCase(), type: props.type || '', value: props.value,
  isContentEditable: props.contentEditable === true,
  textContent: props.textContent || '',
  getAttribute: (k) => (props.attrs && k in props.attrs ? props.attrs[k] : null),
  ...props,
});
const docWith = (active, body = el('body')) => ({ activeElement: active, body, documentElement: el('html') });
const probe = (doc) => sandbox({ document: doc, location: { href: 'https://portal.azure.com/' } }).inspectActiveElement();

test('the document/body having focus is a fact the probe states, not a null', () => {
  const body = el('body');
  const d = probe(docWith(body, body));
  assert.equal(d.tag, 'body');
  assert.equal(d.editable, false);
  assert.match(d.reason, /document itself has focus/);
  assert.equal(probe(docWith(null)).tag, 'none');
});

test('a CROSS-ORIGIN iframe with focus is readable:false with the machine-readable reason + its host', () => {
  const frame = { tagName: 'IFRAME', src: 'https://sandbox-1.reactblade.portal.azure.net/blade', getAttribute: () => null,
    get contentDocument() { throw new Error('cross-origin'); } };
  const d = probe(docWith(frame));
  assert.equal(d.tag, 'iframe');
  assert.equal(d.editable, false);
  assert.equal(d.readable, false);
  assert.equal(d.reason, 'cross-origin: value not readable');
  assert.deepEqual(d.frames, ['sandbox-1.reactblade.portal.azure.net']);
});

test('a SAME-ORIGIN iframe is followed down to the element that really has focus', () => {
  const inner = el('input', { value: 'fastlink-bench-vm', attrs: { 'aria-label': 'Virtual machine name' } });
  const frame = { tagName: 'IFRAME', src: 'https://portal.azure.com/inner', getAttribute: () => null,
    contentDocument: docWith(inner) };
  const d = probe(docWith(frame));
  assert.equal(d.tag, 'input');
  assert.equal(d.editable, true);
  assert.equal(d.readable, true);
  assert.equal(d.value, 'fastlink-bench-vm');
  assert.equal(d.label, 'Virtual machine name');
  assert.deepEqual(d.frames, ['portal.azure.com']);
});

test('a password field is editable but NOT readable; a button is neither', () => {
  const pw = probe(docWith(el('input', { type: 'password', value: 'hunter22' })));
  assert.equal(pw.editable, true);
  assert.equal(pw.readable, false);
  assert.equal(pw.reason, 'password field: value not readable');
  assert.equal(pw.value, '••••••••');
  const btn = probe(docWith(el('button')));
  assert.equal(btn.editable, false);
  assert.match(btn.reason, /holds no editable value/);
});

// ── typeText: the clear guard ────────────────────────────────────────────────
const IFRAME = { tag: 'iframe', type: '', editable: false, readable: false, reason: 'cross-origin: value not readable', label: 'sandbox-1.reactblade.portal.azure.net', value: '', valueLen: 0, frames: ['sandbox-1.reactblade.portal.azure.net'] };
const BODY = { tag: 'body', type: '', editable: false, readable: true, reason: 'the document itself has focus — no field is focused', label: '', value: '', valueLen: 0, frames: [] };
const field = (value, label = 'Virtual machine name') => ({ tag: 'input', type: 'text', editable: true, readable: true, label, value, valueLen: String(value).length, frames: [] });

test('clear:true with a CROSS-ORIGIN iframe focused is REFUSED — no select-all, nothing typed (the Azure bug)', async () => {
  const s = sandbox({ probes: [IFRAME] });
  const r = await s.typeText({ text: 'fastlink-bench-vm', clear: true, force: true });
  assert.equal(r.code, 'clear_without_editable_focus');
  assert.match(r.error, /cross-origin <iframe> \(sandbox-1\.reactblade\.portal\.azure\.net\) has focus/);
  assert.match(r.error, /selects the WHOLE PAGE/);
  assert.equal(r.focused.tag, 'iframe');
  assert.match(r.hint, /clickCount:3/);
  assert.deepEqual(s.cdpCalls, [], 'no Ctrl+A, no Delete, no insertText');
});

test('clear:true with the document focused is refused, force or not — nothing typed either way', async () => {
  const forced = sandbox({ probes: [BODY] });
  const r = await forced.typeText({ text: 'x', clear: true, force: true });
  assert.equal(r.code, 'clear_without_editable_focus');
  assert.match(r.error, /<body> has focus/);
  assert.deepEqual(forced.cdpCalls, []);
  // without force the older editable-focus guard refuses first — same outcome,
  // no select-all, nothing typed
  const plain = sandbox({ probes: [BODY] });
  const p = await plain.typeText({ text: 'x', clear: true });
  assert.match(p.error, /no editable element focused/);
  assert.deepEqual(plain.cdpCalls, []);
});

test('clear:true with an editable field focused still select-alls, deletes and types', async () => {
  const s = sandbox({ probes: [field('API key 4'), field('FastLink key')] });
  const r = await s.typeText({ text: 'FastLink key', clear: true });
  assert.equal(r.verified, true);
  assert.equal(r.cleared, true);
  const keys = s.cdpCalls.filter(c => c.method === 'Input.dispatchKeyEvent');
  assert.equal(keys.length, 4, 'Ctrl+A down/up then Delete down/up');
  assert.equal(keys[0].params.modifiers, 2);
  assert.equal(keys[0].params.key, 'a');
  assert.equal(keys[2].params.key, 'Delete');
  assert.deepEqual(s.cdpCalls.at(-1), { method: 'Input.insertText', params: { text: 'FastLink key' } });
});

// ── typeText: the verified contract ──────────────────────────────────────────
test('a forced write into a cross-origin iframe is verified:false with the reason and typedInto', async () => {
  const s = sandbox({ probes: [IFRAME, IFRAME] });
  const r = await s.typeText({ text: 'fastlink-bench-vm', force: true });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'cross-origin: value not readable');
  assert.deepEqual(r.typedInto, { tag: 'iframe', type: '', label: 'sandbox-1.reactblade.portal.azure.net', value: '', frames: ['sandbox-1.reactblade.portal.azure.net'] });
  assert.equal(r.forced, true);
  assert.equal(Object.keys(r)[0], 'verified', 'the read-back state leads the result');
  assert.equal(s.cdpCalls.filter(c => c.method === 'Input.insertText').length, 1, 'it still typed');
});

test('a readable field that now holds the text is verified:true; one that reads something else says what', async () => {
  const ok = sandbox({ probes: [field(''), field('fastlink-bench-vm')] });
  const good = await ok.typeText({ text: 'fastlink-bench-vm' });
  assert.equal(good.verified, true);
  assert.equal(good.reason, undefined);
  assert.equal(good.typedInto.value, 'fastlink-bench-vm');

  const bad = sandbox({ probes: [field(''), field('(555) 123-')] });
  const r = await bad.typeText({ text: '5551234567' });
  assert.equal(r.verified, false);
  assert.match(r.reason, /the field reads "\(555\) 123-" after typing/);
  assert.doesNotMatch(r.reason, /cross-origin/);
});

test('a value longer than the read-back window says unreadable, not "reads something else"', async () => {
  const long = { ...field('x'.repeat(300) + '…'), valueLen: 900 };
  const s = sandbox({ probes: [field(''), long] });
  const r = await s.typeText({ text: 'y'.repeat(400) });
  assert.equal(r.verified, false);
  assert.match(r.reason, /^unreadable: the field holds 900 characters/);
});

test('the no-editable-focus refusal (no clear) still fires and now names what had focus', async () => {
  const s = sandbox({ probes: [BODY] });
  const r = await s.typeText({ text: 'x' });
  assert.match(r.error, /no editable element focused/);
  assert.equal(r.focused.tag, 'body');
  assert.deepEqual(s.cdpCalls, []);
});
