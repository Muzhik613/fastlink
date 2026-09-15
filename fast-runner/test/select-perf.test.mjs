// node --test — PERF GUARD for fast_select_option's field resolution.
//
// 2026-09-15: 9d18d4d made the resolution super-linear in DOCUMENT size. Its
// repeated-row detection (rowContextOf) climbed 16 ancestors, ran a
// querySelectorAll over ancestor subtrees that grow toward the whole document,
// and resolved every field's label through labelFor() with no precomputed
// label[for] map — two document-wide querySelector calls per field — with no
// caching, 3-6x per element per call. On a console SPA fast_select_option then
// burned the whole 20s runBridge deadline ("page busy") while every REPORTED
// timing phase stayed cheap, because the row block sits after resolveMs is
// stamped. This test pins the cost so that cannot come back silently.
//
// The primary assertion is the DOM-QUERY COUNT, not wall clock: the bug was
// "walks/queries the document per candidate and per row". The scale test is the
// real contract — doubling the page must NOT multiply the work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const PAGE_JS = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');

// A console-SPA-shaped page: the target control buried in a classless wrapper
// chain, sibling panels of labelled id'd fields at 8 of those levels, and 50
// repeated rows whose labels repeat row to row.
function buildHtml({ rows = 50, sections = 60, depth = 22 } = {}) {
  const panel = (name, n) => {
    let h = '<div>';
    for (let i = 0; i < n; i++) {
      h += `<div><div><label for="${name}-${i}">${name} field ${i}</label>` +
           `<input id="${name}-${i}" name="${name}_${i}"></div></div>`;
    }
    return h + '</div>';
  };
  let rowsHtml = '<h2>Members</h2><div>';
  for (let r = 0; r < rows; r++) {
    rowsHtml += '<div class="row"><div>' +
      `<label for="fn-${r}">First name</label><input id="fn-${r}" value="Person ${r}">` +
      `<label for="plan-${r}">Plan</label><select id="plan-${r}"><option>Basic</option><option>Pro</option></select>` +
      `<label for="ctry-${r}">Country</label><select id="ctry-${r}"><option>US</option><option>UK</option></select>` +
      '</div></div>';
  }
  rowsHtml += '</div>';
  let heavy = '';
  for (let s = 0; s < sections; s++) {
    heavy += `<section><h3>Group ${s}</h3><div class="menu">`;
    for (let b = 0; b < 10; b++) {
      const i = s * 10 + b;
      heavy += '<div><div><div><div>' +
        `<button type="button" id="menu-${i}" aria-haspopup="menu" aria-label="Actions ${i}">.</button>` +
        '</div></div></div></div>';
    }
    heavy += '</div><div class="grid">';
    for (let k = 0; k < 40; k++) heavy += `<span>c${s}.${k}</span>`;
    heavy += '</div></section>';
  }
  const core = '<h1>Create OAuth client ID</h1>' +
    '<div><div><label for="app">Application type</label>' +
    '<select id="app"><option value="">Select</option><option value="web">Web application</option>' +
    '<option value="and">Android</option><option value="ios">iOS</option></select></div></div>' +
    rowsHtml + heavy;
  const SIB_LEVELS = new Set([3, 5, 7, 9, 11, 13, 15, 17]);
  let html = core;
  for (let d = depth; d >= 1; d--) {
    html = '<div>' + html + (SIB_LEVELS.has(d) ? panel(`panel${d}a`, 60) + panel(`panel${d}b`, 60) : '') + '</div>';
  }
  return `<!doctype html><html><body><div id="root">${html}</div></body></html>`;
}

// jsdom has no layout, so every element gets a plausible box; every document
// query is counted.
function makePage(opts) {
  const { window: win } = new JSDOM(buildHtml(opts), { pretendToBeVisual: true, runScripts: 'outside-only' });
  const RECT = { x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 20, width: 200, height: 20 };
  win.Element.prototype.getBoundingClientRect = () => RECT;
  win.requestIdleCallback = win.requestIdleCallback
    || ((cb) => win.setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: true }), 0));
  win.cancelIdleCallback = win.cancelIdleCallback || ((h) => win.clearTimeout(h));
  const counts = { queries: 0 };
  for (const [proto, name] of [
    [win.Element.prototype, 'querySelectorAll'], [win.Document.prototype, 'querySelectorAll'],
    [win.Element.prototype, 'querySelector'], [win.Document.prototype, 'querySelector'],
  ]) {
    const orig = proto[name];
    proto[name] = function (...a) { counts.queries++; return orig.apply(this, a); };
  }
  win.eval(PAGE_JS);
  const nodes = win.document.getElementsByTagName('*').length;
  return { win, counts, nodes };
}

const select = (win, args) => win.__fastlink.run('fast_select_option', { noSnapshot: true, ...args });

test('resolution on a ~10k-node DOM with 50 repeated rows is cheap and correct', async (t) => {
  const { win, counts, nodes } = makePage();
  t.after(() => win.close());   // jsdom keeps a rAF loop per window; unclosed windows OOM the run
  assert.ok(nodes > 9000 && nodes < 13000, `expected a ~10k-node DOM, got ${nodes}`);
  counts.queries = 0;
  const res = await select(win, { field: 'Application type', option: 'Web application' });

  assert.equal(res.verified, true, `pick not verified: ${JSON.stringify(res).slice(0, 300)}`);
  assert.equal(res.picked, 'Web application');
  // Every phase is timed — the regression hid because the row block was not.
  assert.equal(typeof res.timing.rowsMs, 'number', 'row resolution must report its own timing.rowsMs');
  const resolveCost = res.timing.resolveMs + res.timing.rowsMs;
  assert.ok(resolveCost < 1000, `field resolution took ${resolveCost}ms (was ~6500ms on 9d18d4d)`);
  // The real shape of the bug: thousands of document-wide queries. 9d18d4d: ~3100.
  assert.ok(counts.queries < 800, `resolution issued ${counts.queries} DOM queries (9d18d4d issued ~3100)`);
});

test('resolution cost does not scale with DOCUMENT size — no document-wide walk per candidate/row', async (t) => {
  const small = makePage({ sections: 60 });
  t.after(() => small.win.close());
  small.counts.queries = 0;
  await select(small.win, { field: 'Application type', option: 'Web application' });

  const big = makePage({ sections: 180 });
  t.after(() => big.win.close());
  big.counts.queries = 0;
  await select(big.win, { field: 'Application type', option: 'Web application' });

  assert.ok(big.nodes > small.nodes * 1.8, `the big DOM must really be bigger (${small.nodes} -> ${big.nodes})`);
  assert.ok(big.counts.queries < small.counts.queries * 1.5,
    `doubling the page multiplied the DOM queries ${small.counts.queries} -> ${big.counts.queries}: something walks the document per candidate/row again`);
});

// The cheap path must still do everything 9d18d4d added, or it is not a fix.
test('repeated-row behaviour is preserved: ambiguity refused and named, index:N picks one row', async (t) => {
  const { win } = makePage();
  t.after(() => win.close());
  const doc = win.document;

  const refused = await select(win, { field: 'Plan', option: 'Pro' });
  assert.ok(refused.error && /visible dropdown\(s\) match/.test(refused.error),
    `an un-indexed write across 50 identical rows must be refused, got ${JSON.stringify(refused).slice(0, 300)}`);
  assert.equal(doc.getElementById('plan-0').value, 'Basic', 'a refused write must change nothing');
  const named = refused.candidates[0];
  assert.equal(named.rows, 50, 'each candidate names how many rows the group has');
  assert.equal(typeof named.row, 'number', 'each candidate names its row index');
  assert.ok(named.rowFirst, 'each candidate names its row by its first value');

  const picked = await select(win, { field: 'Plan', option: 'Pro', index: 3 });
  assert.equal(picked.verified, true, `index:3 should select: ${JSON.stringify(picked).slice(0, 300)}`);
  assert.equal(doc.getElementById('plan-3').value, 'Pro', 'index:3 writes the 4th row');
  assert.equal(doc.getElementById('plan-0').value, 'Basic', 'and leaves every other row alone');
});
