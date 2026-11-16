// fast_upload: picking the one file input, and setting files on it like a real pick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickInput, fileInputsInFrame } from '../src/actions/upload.js';

const frame = (frameId, url, inputs, extra = {}) => ({ frameId, result: { url, inputs, ...extra } });
const inp = (n, o = {}) => ({ n, name: '', id: '', accept: '', multiple: false, disabled: false, label: '', ...o });

test('the only file input on the page is used, even hidden in a frame', () => {
  const r = pickInput([frame(0, 'https://a.test/', []), frame(5, 'https://pay.test/x', [inp(0, { accept: 'image/*' })])]);
  assert.equal(r.pick.frameId, 5);
  assert.equal(r.pick.n, 0);
});

test('several inputs: ambiguous, listed with refs; match / ref / selector pick one', () => {
  const frames = [frame(0, 'https://web.whatsapp.test/', [
    inp(0, { accept: 'image/*,video/mp4,video/3gpp', multiple: true, label: 'Photos & videos' }),
    inp(1, { accept: '*', label: 'Document' }),
  ])];
  const amb = pickInput(frames);
  assert.equal(amb.code, 'ambiguous');
  assert.deepEqual(amb.inputs.map((i) => i.ref), ['0:0', '0:1']);
  assert.equal(pickInput(frames, { match: 'photos' }).pick.n, 0);
  assert.equal(pickInput(frames, { match: 'image/' }).pick.n, 0);
  assert.equal(pickInput(frames, { ref: '0:1' }).pick.n, 1);
  assert.match(pickInput(frames, { match: 'nope' }).error, /no file input matches "nope"/);
  assert.match(pickInput(frames, { ref: '3:0' }).error, /no file input with ref/);
  const sel = [frame(0, 'https://a.test/', [inp(0, { sel: false }), inp(1, { sel: true })])];
  assert.equal(pickInput(sel, { selector: '#up' }).pick.n, 1);
});

test('a selector that hits something that is not a file input is refused', () => {
  const r = pickInput([frame(0, 'https://a.test/', [], { nonFile: ['input[type=text]'] })], { selector: '#name' });
  assert.equal(r.code, 'not_file_input');
  assert.match(r.error, /not a file input .*input\[type=text\]/);
  const r2 = pickInput([frame(0, 'https://a.test/', [inp(0, { sel: false })], { nonFile: ['textarea'] })], { selector: 'textarea' });
  assert.equal(r2.code, 'not_file_input');
});

test('no file input: says to open the attach menu first; frame filter narrows', () => {
  assert.equal(pickInput([frame(0, 'https://a.test/', [])]).code, 'no_file_input');
  const frames = [frame(0, 'https://a.test/', [inp(0)]), frame(3, 'https://b.test/', [inp(0)])];
  assert.equal(pickInput(frames, { frame: 'b.test' }).pick.frameId, 3);
  assert.match(pickInput([frame(0, 'https://a.test/', [], { badSelector: 'bad' })], { selector: '##' }).error, /bad selector/);
});

test('a disabled input is not used', () => {
  assert.match(pickInput([frame(0, 'https://a.test/', [inp(0, { disabled: true })])]).error, /disabled/);
});

// ---- the in-page half, on a tiny fake DOM ----------------------------------
class FakeInput {
  constructor(o = {}) { Object.assign(this, { tagName: 'INPUT', type: 'file', name: '', id: '', accept: '', multiple: false, disabled: false, title: '', labels: [], isConnected: true, parentElement: null, shadowRoot: null, events: [] }, o); this._files = null; }
  get files() { return this._files; }
  set files(v) { this._files = v; }
  getAttribute() { return null; }
  dispatchEvent(e) { this.events.push({ type: e.type, bubbles: e.bubbles }); return true; }
}
class FakeDataTransfer {
  constructor() { const list = []; this.items = { add: (f) => list.push(f) }; this.files = list; }
}
function page(inputs) {
  globalThis.location = { href: 'https://a.test/' };
  globalThis.document = { querySelectorAll: (sel) => (sel === '*' ? inputs : inputs.filter((i) => `#${i.id}` === sel)) };
  globalThis.DataTransfer = FakeDataTransfer;
}
const b64 = (s) => Buffer.from(s).toString('base64');

test('set: files land on the input with input + change events, bytes intact', async () => {
  const el = new FakeInput({ id: 'up', accept: 'image/*', multiple: true });
  page([el]);
  const list = fileInputsInFrame('list', {});
  assert.deepEqual(list.inputs.map((i) => [i.n, i.id, i.accept, i.multiple]), [[0, 'up', 'image/*', true]]);
  const r = fileInputsInFrame('set', { n: 0, files: [{ name: 'a.png', type: 'image/png', data: b64('PNGDATA') }, { name: 'b.jpg', type: 'image/jpeg', data: b64('JPG') }], expect: { name: '', id: 'up' } });
  assert.equal(r.filesOnInput, 2);
  assert.equal(r.acceptMismatch, undefined);
  assert.deepEqual(el.events, [{ type: 'input', bubbles: true }, { type: 'change', bubbles: true }]);
  assert.equal(el.files[0].name, 'a.png');
  assert.equal(el.files[0].type, 'image/png');
  assert.equal(Buffer.from(await el.files[0].arrayBuffer()).toString(), 'PNGDATA');
});

test('set: one-file input refuses several files; accept mismatch is flagged; a re-rendered input is refused', () => {
  const el = new FakeInput({ accept: '.jpg,image/png' });
  page([el]);
  assert.match(fileInputsInFrame('set', { n: 0, files: [{ name: 'a.png', type: 'image/png', data: b64('x') }, { name: 'b.png', type: 'image/png', data: b64('y') }] }).error, /takes one file/);
  const r = fileInputsInFrame('set', { n: 0, files: [{ name: 'doc.pdf', type: 'application/pdf', data: b64('x') }] });
  assert.match(r.acceptMismatch, /doc\.pdf/);
  assert.match(fileInputsInFrame('set', { n: 0, files: [{ name: 'a.jpg', type: 'image/jpeg', data: b64('x') }], expect: { name: 'other', id: '' } }).error, /changed/);
  assert.match(fileInputsInFrame('set', { n: 4, files: [{ name: 'a.jpg', type: 'image/jpeg', data: b64('x') }] }).error, /changed/);
});

test('list: a selector on a non-file element is reported as such', () => {
  const el = new FakeInput();
  const text = { tagName: 'INPUT', type: 'text', id: 'name', shadowRoot: null };
  page([el, text]);
  const r = fileInputsInFrame('list', { selector: '#name' });
  assert.deepEqual(r.nonFile, ['input[type=text]']);
  assert.equal(r.inputs[0].sel, false);
});
