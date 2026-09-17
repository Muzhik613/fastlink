// node --test — MATCH QUALITY ranks a click's candidates (exact > word-boundary prefix >
// buried in longer text, the longer the host the weaker), position is only a tiebreak, and a
// control the click relabelled says so in `changed`.
// (fast-ext/src/actions/page.js matchScore / fast_click; the REAL page.js runs in jsdom.)
// Live stopwatch.net (build 8b93bb0): fast_click {text:"Stop"} hit the FAQ button
// "Is Stopwatch.net free to use?" ~2,700px below the fold and scrolled the page to it,
// skipping the primary control that had just relabelled itself exactly "Stop"; and the
// click that relabelled it (Start → Stop) came back changed "none".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const PAGE_JS = readFileSync(new URL('../../fast-ext/src/actions/page.js', import.meta.url), 'utf8');
// Boxes come from data-y (page y); the viewport is 768 tall, so data-y 2700 is below the fold.
function page(html, wire = () => {}) {
  const dom = new JSDOM(`<body>${html}</body>`, { url: 'https://stopwatch.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = function () {
    if (!this.isConnected) return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    const y = Number(this.getAttribute('data-y') || 100), h = Number(this.getAttribute('data-h') || 40);
    return { x: 20, y, left: 20, top: y, width: 300, height: h, right: 320, bottom: y + h };
  };
  wire(w.document);
  w.eval(PAGE_JS);
  return w;
}
const run = async (w, a, x) => JSON.parse(JSON.stringify(await w.__fastlink.run(a, { noSnapshot: true, ...x })));
// the page: one primary control that relabels itself, FAQ buttons far below the fold whose
// long text contains the word
const STOPWATCH = `<button id="go" data-y="200">Start</button>
  <button data-y="2700">Is Stopwatch.net free to use?</button>
  <button data-y="2800">How do I stop the stopwatch and save a lap?</button>`;
const wireGo = (d) => d.getElementById('go').addEventListener('click', () => { d.getElementById('go').textContent = d.getElementById('go').textContent === 'Start' ? 'Stop' : 'Start'; });

test('the visible control labelled exactly "Stop" wins over an offscreen button whose long text contains it', async () => {
  const w = page(STOPWATCH, wireGo);
  await run(w, 'fast_snapshot', {});
  await run(w, 'fast_click', { text: 'Start' });
  const r = await run(w, 'fast_click', { text: 'Stop' });
  assert.equal(r.clicked.text, 'Stop', JSON.stringify(r.clicked));
  assert.equal(r.scrolledIntoView, undefined, 'it must not scroll away to a below-the-fold match');
});

test('the click that relabels a control reports it in `changed`', async () => {
  const w = page(STOPWATCH, wireGo);
  await run(w, 'fast_snapshot', {});
  const r = await run(w, 'fast_click', { text: 'Start' });
  assert.equal(r.labelNow, 'Stop');
  assert.deepEqual(r.changed, ['the clicked control: "Start" → "Stop"'], JSON.stringify(r.changed));
});

test('an exact aria-label / title / placeholder match also outranks a substring in longer text', async () => {
  const w = page(`<button data-y="150">Save the draft of your report now</button>
    <button data-y="250" aria-label="Save"></button>
    <div data-y="350"><input placeholder="Search the archive"><input placeholder="Search"></div>`);
  await run(w, 'fast_snapshot', {});
  const r = await run(w, 'fast_click', { text: 'Save' });
  assert.equal(r.clicked.ariaLabel || r.clicked.text, 'Save', JSON.stringify(r.clicked));
  const f = await run(w, 'fast_fill', { fields: { Search: 'laps' } });
  assert.equal(JSON.stringify(f).includes('Search the archive'), false, JSON.stringify(f));
});

test('with no exact match the longest-standing behaviour holds: the substring match is still clicked', async () => {
  const w = page('<button data-y="180">Pause the stopwatch</button>');
  await run(w, 'fast_snapshot', {});
  const r = await run(w, 'fast_click', { text: 'Pause' });
  assert.equal(r.clicked.text, 'Pause the stopwatch');
});

test('an EXACT match far below the fold still beats an on-screen substring match', async () => {
  const w = page(`<button data-y="120">Stop the ads on this page</button>
    <button data-y="3000">Stop</button>`);
  await run(w, 'fast_snapshot', {});
  const r = await run(w, 'fast_click', { text: 'Stop' });
  assert.equal(r.clicked.text, 'Stop', JSON.stringify(r.clicked));
  assert.equal(r.clicked.y, 3000, 'the one below the fold');
});

test('when the ONLY match is below the fold it is clicked, not refused', async () => {
  const w = page('<h1 data-y="40">Report</h1><button data-y="2900">Download the full audit log</button>');
  await run(w, 'fast_snapshot', {});
  const r = await run(w, 'fast_click', { text: 'Download' });
  assert.equal(r.clicked.text, 'Download the full audit log');
});

test('position breaks a tie only between matches of the SAME quality', async () => {
  const w = page('<button data-y="2600">Save</button><button data-y="180">Save</button>');
  await run(w, 'fast_snapshot', {});
  const r = await run(w, 'fast_click', { text: 'Save' });
  assert.equal(r.scrolledIntoView, undefined, 'the on-screen one of two exact matches');
  assert.equal(r.clicked.y, 180, JSON.stringify(r.clicked));
});

test('a word-boundary prefix beats the same text buried mid-sentence — even from below the fold', async () => {
  const w = page('<button data-y="150">Never stop the recording without saving</button><button data-y="2800">Stop recording</button>');
  await run(w, 'fast_snapshot', {});
  const r = await run(w, 'fast_click', { text: 'Stop' });
  assert.equal(r.clicked.text, 'Stop recording');
});

test('a weak winner carries the runner-up and why it lost, so the model can correct in one turn', async () => {
  const w = page(`<button data-y="150">Pause the stopwatch now</button>
    <button data-y="2700">Is Stopwatch.net free to use?</button>`);
  await run(w, 'fast_snapshot', {});
  const r = await run(w, 'fast_click', { text: 'stopwatch' });
  assert.ok(Array.isArray(r.alsoMatched) && r.alsoMatched.length, JSON.stringify(r));
  assert.equal(r.alsoMatched[0].text, 'Is Stopwatch.net free to use?');
  assert.match(r.alsoMatched[0].lost, /below the fold|longer|ranked lower/);
});

test('a clean exact win carries no runner-up note', async () => {
  const w = page('<button data-y="150">Stop</button><button data-y="220">Stop the stopwatch and save</button>');
  await run(w, 'fast_snapshot', {});
  const r = await run(w, 'fast_click', { text: 'Stop' });
  assert.equal(r.clicked.text, 'Stop');
  assert.equal(r.alsoMatched, undefined, JSON.stringify(r.alsoMatched));
});
