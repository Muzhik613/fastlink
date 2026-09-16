// node --test — fast_snapshot's total size cap (fast-ext/src/actions/frames.js capRead).
// Live Oracle dd2cf71c: a default read of 80,136 chars took the model 43.6s and ended with no tool call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.chrome = { storage: { session: { get: async () => ({}) } }, tabs: { query: async () => [] } };
const { capRead, READ_MAX, READ_MAX_FULL } = await import('../../fast-ext/src/actions/frames.js');

const big = () => ({
  url: 'https://cloud.example/create', title: 'Create',
  items: Array.from({ length: 60 }, (_, k) => ({ i: k, tag: 'a', text: `Top navigation link number ${k} with a long label`, x: 0, y: 10 + k, w: 100, h: 20 })),
  content: Array.from({ length: 40 }, (_, k) => ({ tag: 'p', text: `Help paragraph ${k} `.repeat(12), x: 0, y: 5000 + k, w: 100, h: 20 })),
  frames: [{
    frame: 'https://cloud.example', frameId: 9, box: { x: 0, y: 80, w: 1400, h: 800 },
    items: [
      ...Array.from({ length: 150 }, (_, k) => ({ i: `f9:${k}`, tag: 'input', label: `Configuration field ${k} with a long descriptive label`, value: `default ${k}`, x: 20, y: 100 + k * 60, w: 500, h: 30, ...(k > 12 ? { offscreen: true } : {}) })),
      ...Array.from({ length: 40 }, (_, k) => ({ i: `f9:d${k}`, tag: 'div', role: 'radio', text: `Image ${k}: Oracle Linux 9.${k} (x86_64) with Secure Boot`, x: 320, y: 140 + k * 10, w: 700, h: 26, inDialog: true })),
    ],
    content: Array.from({ length: 60 }, (_, k) => ({ tag: 'p', text: `Frame help ${k} `.repeat(15), x: 20, y: 100 + k * 60, w: 900, h: 20 })),
  }],
});

test('a default read over the cap is cut to ≤16k chars, dialog items kept first, then on-screen controls; it says truncated with counts and how to get more', () => {
  const r = capRead(big(), READ_MAX);
  const len = JSON.stringify(r).length;
  assert.ok(len <= READ_MAX, `${len} chars`);
  assert.deepEqual(Object.keys(r).slice(0, 3), ['truncated', 'dropped', 'hint']);
  assert.match(r.hint, /^read capped at ~16k chars: \d+ item\(s\) \/ \d+ content block\(s\) not shown .*full:true \(up to 40k chars\), limit:N, or frame:"fN"/);
  const f = r.frames[0];
  assert.equal(f.items.filter((it) => it.inDialog).length, 40, 'every dialog item kept');
  assert.ok(f.items.some((it) => !it.offscreen && it.tag === 'input'), 'on-screen fields kept before offscreen ones');
  assert.equal(r.dropped.content > 0, true, 'content goes before controls');
});

test('full:true is held to ~40k with the same honest truncation; a read under the cap is untouched', () => {
  const huge = big();
  huge.frames[0].items.push(...Array.from({ length: 400 }, (_, k) => ({ i: `f9:x${k}`, tag: 'button', text: `Learn more about option ${k} in detail`, x: 20, y: 10000 + k, w: 200, h: 20, offscreen: true })));
  const r = capRead(huge, READ_MAX_FULL, { full: true });
  assert.ok(JSON.stringify(r).length <= READ_MAX_FULL);
  assert.equal(r.truncated, true);
  assert.ok(!r.frames[0].items.some((it) => it.offscreen && 'x' in it), 'offscreen items are compact lines');
  const small = { url: 'u', items: [{ i: 1, tag: 'button', text: 'Go', x: 1, y: 1, w: 1, h: 1 }] };
  assert.deepEqual(capRead(small, READ_MAX), small);
});
