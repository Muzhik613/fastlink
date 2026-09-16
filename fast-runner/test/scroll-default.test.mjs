// node --test — fast_scroll's default amount (page.js scrollDest / scrollOutcome),
// sliced from the source so there is one source of truth.
// Holdout: the model called fast_scroll {selector:"#demo-tree"} four times without
// `pixels`, and every call errored. A scroll with no amount pages the scroller by
// one visible screenful and says how far it moved and whether it hit the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');
const constLine = (name) => { const i = src.indexOf(`const ${name} =`); return src.slice(i, src.indexOf('\n', i) + 1); };
const slice = (name) => { const i = src.indexOf(`const ${name} =`); assert.ok(i >= 0, name); const j = src.indexOf('\n};\n', i); return src.slice(i, j + 3); };
const { scrollDest, scrollOutcome } = new Function(`${constLine('SCROLL_OVERLAP_PX')}${slice('scrollDest')}\n${slice('scrollOutcome')}\nreturn { scrollDest, scrollOutcome };`)();

// the page.js sequence: plan → clamp to [0,max] → the scroller settles there
const run = (args, top, max, viewH) => {
  const plan = scrollDest(args, { top, max, viewH });
  if (plan.error) return plan;
  const after = Math.max(0, Math.min(max, plan.dest));
  return { ...scrollOutcome(top, after, max, plan.dest), scrollTop: after, screenful: plan.screenful };
};

test('#demo-tree with no pixels: one screenful (view height minus a small overlap), not an error', () => {
  const r = run({ selector: '#demo-tree' }, 0, 2000, 400);
  assert.equal(r.error, undefined);
  assert.equal(r.screenful, 360, '400px view − 40px overlap');
  assert.deepEqual([r.moved, r.atEnd, r.scrollTop], [360, false, 360]);
});

test('paging reaches the end: the last page moves only what is left and says atEnd', () => {
  let top = 0; const moves = [];
  for (let i = 0; i < 4; i++) { const r = run({ selector: '#demo-tree' }, top, 1000, 400); moves.push([r.moved, r.atEnd]); top = r.scrollTop; }
  assert.deepEqual(moves, [[360, false], [360, false], [280, true], [0, true]]);
});

test('a small view keeps a proportional overlap; a zero-height view still moves', () => {
  assert.equal(scrollDest({}, { top: 0, max: 500, viewH: 100 }).screenful, 90);
  assert.equal(scrollDest({}, { top: 0, max: 500, viewH: 0 }).screenful, 1);
});

test('explicit amounts are unchanged: pixels delta, top, bottom, percentage', () => {
  assert.deepEqual(run({ pixels: -100 }, 300, 1000, 400), { moved: -100, atEnd: false, scrollTop: 200, screenful: undefined });
  assert.deepEqual(run({ pixels: -500 }, 300, 1000, 400).atEnd, true);
  assert.equal(run({ to: 'bottom' }, 0, 1000, 400).atEnd, true);
  assert.equal(run({ to: 'top' }, 300, 1000, 400).moved, -300);
  assert.equal(scrollDest({ to: '50%' }, { top: 0, max: 1000, viewH: 400 }).dest, 500);
});

test('malformed amounts are refused, not silently turned into a screenful', () => {
  assert.match(scrollDest({ to: 'middle' }, { top: 0, max: 1, viewH: 1 }).error, /to must be/);
  assert.match(scrollDest({ pixels: '300' }, { top: 0, max: 1, viewH: 1 }).error, /pixels must be a number/);
});
