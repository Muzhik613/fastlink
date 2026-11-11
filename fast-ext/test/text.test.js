// fast_text windows: ≤2M chars per call, offset/next, the page text cached between windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractText } from '../src/actions/text.js';

function page(text, href = 'https://x.test/a') {
  let reads = 0;
  globalThis.location = { href };
  globalThis.document = { body: { get innerText() { reads++; return text; } }, querySelectorAll: () => [] };
  globalThis.__fastlinkTextCache = null;
  return { reads: () => reads };
}
const read = (...a) => JSON.parse(extractText(...a));

test('a small page comes back whole', () => {
  page('hello');
  assert.deepEqual(read(null, 0, null, false), { truncated: false, text: 'hello', offset: 0, length: 5, kind: 'innerText', from: 'body' });
});

test('a big page is read in windows that join back exactly, from one page read', () => {
  const full = 'a'.repeat(2_000_000) + '😀' + 'b'.repeat(1_500_000);
  const p = page(full);
  let off = 0, out = '', calls = 0;
  for (;;) {
    const r = read(null, off, null, false);
    calls++;
    assert.equal(r.offset, off);
    assert.equal(r.length, full.length);
    out += r.text;
    if (!r.truncated) break;
    assert.ok(Object.keys(r)[0] === 'truncated' && r.next > off && /offset:\d+/.test(r.hint));
    off = r.next;
  }
  assert.equal(out, full);
  assert.equal(calls, 2);
  assert.equal(p.reads(), 1, 'later windows slice the cached text');
  assert.equal(globalThis.__fastlinkTextCache, null, 'the last window frees the cache');
});

test('a window never splits a surrogate pair', () => {
  page('ab😀cd');
  const r = read(null, 0, 3, false);
  assert.equal(r.text, 'ab');
  assert.equal(r.next, 2);
  assert.equal(read(null, 2, 3, false).text, '😀c');
});

test('maxLen over the per-call limit, a bad offset, an offset past the end: clear errors', () => {
  page('hello');
  assert.match(read(null, 0, 2_000_001, false).error, /over the 2000000-character limit.*offset/);
  assert.match(read(null, -1, null, false).error, /offset must be/);
  assert.match(read(null, 9, null, false).error, /past the end/);
});

test('a window on another page re-reads instead of using a stale cache', () => {
  page('x'.repeat(10));
  read(null, 0, 4, false);
  const p = page('y'.repeat(10), 'https://x.test/b');
  globalThis.__fastlinkTextCache = { key: JSON.stringify(['https://x.test/a', null, false]), text: 'x'.repeat(10), meta: {} };
  assert.equal(read(null, 4, 4, false).text, 'yyyy');
  assert.equal(p.reads(), 1);
});
