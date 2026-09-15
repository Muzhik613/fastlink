// node --test — fast_fill's duplicate-label refusal: the outline-path helpers
// (page.js outlineTitles / distinguishingSections) against a synthetic DOM shaped
// like GCP's OAuth form (two "URIs 1" inputs under two <h2>s, each with an <h3>
// "Item 1" directly above), sliced from page.js so there is one source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');
const slice = (name) => { const i = src.indexOf(`const ${name} =`); const j = src.indexOf('\n};\n', i); return src.slice(i, j + 3); };
const oneLiner = (name) => { const i = src.indexOf(`const ${name} =`); const j = src.indexOf('\n});\n', i); return src.slice(i, j + 4); };
const { outlineTitles, distinguishingSections } = new Function(`${slice('outlineTitles')}\n${oneLiner('distinguishingSections')}\nreturn { outlineTitles, distinguishingSections };`)();

// Document order = array position; `contains` is explicit per node.
const node = (title, level, pos, kids = []) => ({ title, level, pos, kids });
const level = (a) => a.level;
const contains = (a, b) => a.kids.includes(b);
const follows = (a, b) => b.pos > a.pos;
const title = (a) => a.title;

test('two same-labelled inputs under two h2s (h3 "Item 1" above each) resolve to distinct h2 sections', () => {
  const h1 = node('Create OAuth client ID', 1, 0);
  const h2a = node('Authorized JavaScript origins', 2, 10);
  const h3a = node('Item 1', 3, 11);
  const inputA = { pos: 12 };
  const h2b = node('Authorized redirect URIs', 2, 20);
  const h3b = node('Item 1', 3, 21);
  const inputB = { pos: 22 };
  const anchors = [h1, h2a, h3a, h2b, h3b];
  const pa = outlineTitles(anchors, inputA, level, contains, follows, title);
  const pb = outlineTitles(anchors, inputB, level, contains, follows, title);
  assert.deepEqual(pa, ['Create OAuth client ID', 'Authorized JavaScript origins', 'Item 1']);
  assert.deepEqual(pb, ['Create OAuth client ID', 'Authorized redirect URIs', 'Item 1']);
  assert.deepEqual(distinguishingSections([pa, pb]), ['Authorized JavaScript origins', 'Authorized redirect URIs']);
});

test('an <h2> nested inside its own <legend> is one section, not two; a later h2 ends the earlier span', () => {
  const legend = node('Name', 2, 0);
  const h2in = node('Name', 2, 1);
  legend.kids.push(h2in);
  const input = { pos: 2 };
  const later = node('Other', 2, 5);
  assert.deepEqual(outlineTitles([legend, h2in, later], input, level, contains, follows, title), ['Name']);
  assert.deepEqual(outlineTitles([legend, h2in, later], { pos: 6 }, level, contains, follows, title), ['Other']);
});

test('candidates whose paths are identical fall back to the nearest title', () => {
  assert.deepEqual(distinguishingSections([['A', 'B'], ['A', 'B']]), ['B', 'B']);
  assert.deepEqual(distinguishingSections([[], ['A']]), [null, 'A']);
});

test('page.js refuses an ambiguous fill unless index picks one (a section still holding several does not)', () => {
  assert.match(src, /if \(!idxGiven && \(ordered\.length > 1 \|\| hiddenInRows\.length\)\)/, 'refusal gate: 2+ visible, or 1 visible with hidden copies in other rows');
  assert.match(src, /visible field\(s\) match \$\{JSON\.stringify\(sp\.match\)\}/, 'error text');
  assert.match(src, /index: spec\.index \?\? args\.index/, 'top-level index is the fields-form default');
});
