// node --test — the report_done evidence gate on synthetic tool logs (no browser, no model).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateProblems, recordResult, unresolvedFailures, buildSystem, loadToolset } from '../runner.mjs';

const LIST = 'https://dash.cloudflare.com/acc/workers-and-pages';
const WORKER = 'https://dash.cloudflare.com/acc/workers/services/view/fastlink-relay/production';

// Feed results through recordResult exactly as the loop does: [name, args, resultText, isError?].
function runOf(rows) {
  const run = { toolLog: [], corpus: [], urlTrail: [], gateRefusals: [] };
  rows.forEach(([name, args, text = '{}', isError = false], i) => {
    const ok = recordResult(run, text, isError);
    run.toolLog.push({ t: i * 1000, name, args, ok, preview: text.slice(0, 100) });
  });
  return run;
}
const snap = (url, ...texts) => JSON.stringify({ url, content: texts.map(text => ({ text })) });
const txt = (text) => JSON.stringify({ from: 'body', text });
const problems = (run, evidence) => gateProblems(run, { result: 'x', evidence }).join(';');

test('check 1 (as before): a read must follow the last action; evidence must quote a result', () => {
  const corpus = [{ text: '{"content":[{"text":"It\'s Only the Himalayas"},{"text":"£45.17"}],"url":"https://x"}', url: '' }];
  const log = (rows) => rows.map(([name, ok, args = {}]) => ({ name, ok, args }));
  const run = (rows) => ({ toolLog: log(rows), corpus, urlTrail: [], gateRefusals: [] });
  assert.match(problems(run([['fast_tab', true], ['fast_fill', true]]), '"£45.17"'), /no tool has read the page since your last fast_fill/);
  assert.match(problems(run([['fast_fill', true], ['fast_snapshot', true]]), 'the price is right, trust me'), /evidence does not quote/);
  assert.equal(problems(run([['fast_fill', true], ['fast_snapshot', true]]), 'h1 "It\'s Only the Himalayas", price £45.17 at https://x'), '');
  assert.match(problems(run([['fast_click', true], ['fast_text', false]]), '"£45.17"'), /no tool has read/); // failed read does not count
  assert.match(problems(run([['fast_snapshot', true], ['fast_select_option', true]]), '"£45.17"'), /fast_select_option/); // auto-snapshot is not a read-back
  assert.match(problems(run([['fast_click', true], ['fast_wait', true, { networkIdle: true }]]), '"£45.17"'), /no tool has read/);
  assert.equal(problems(run([['fast_click', true], ['fast_wait', true, { text: 'Himalayas' }]]), '"£45.17"'), '');
  assert.match(problems({ toolLog: [], corpus: [], urlTrail: [], gateRefusals: [] }, '"£45.17"'), /no tool has been called/);
  assert.match(problems(run([['fast_snapshot', true]]), ''), /evidence is empty/);
});

test('urlTrail: distinct URLs from results (top-level or auto-snapshot), url-less results inherit the last one', () => {
  const run = runOf([
    ['fast_tab', { url: 'https://dash.cloudflare.com/?to=/:account/workers-and-pages' }, '{"id":1,"url":"https://dash.cloudflare.com/?to=/:account/workers-and-pages"}'],
    ['fast_wait', { text: 'Workers' }, JSON.stringify({ found: {}, snapshot: { url: LIST, content: [] } })],
    ['fast_snapshot', {}, snap(LIST, 'fastlink-relay', 'gauth-father')],
    ['fast_text', {}, txt('Workers & Pages\nfastlink-relay')],
    ['fast_click', { text: 'fastlink-relay' }, '{"error":"nothing matched"}'],
    ['fast_click', { text: 'fastlink-relay', index: 1 }, JSON.stringify({ clicked: {}, url: WORKER, urlChanged: true })],
    ['fast_snapshot', {}, snap(LIST)], // back on the list: a repeat URL re-enters the trail as the current one
  ]);
  assert.deepEqual(run.urlTrail, ['https://dash.cloudflare.com/?to=/:account/workers-and-pages', LIST, WORKER, LIST]);
  assert.deepEqual(run.corpus.map(c => c.url), [run.urlTrail[0], LIST, LIST, LIST, WORKER, LIST]);
  assert.deepEqual(run.toolLog.map(e => e.ok), [true, true, true, true, false, true, true]);
  assert.equal(recordResult({ corpus: [], urlTrail: [] }, 'plain text', true), false, 'MCP isError');
  assert.equal(recordResult({ corpus: [], urlTrail: [] }, '[{"url":"https://a"}]', false), true, 'fast_list array carries no page url');
});

test('check 2: evidence must quote a result read on the current URL, not an earlier page', () => {
  const rows = [
    ['fast_tab', { url: LIST }, `{"id":1,"url":"${LIST}"}`],
    ['fast_snapshot', {}, snap(LIST, 'gauth-father', 'fd-relay')],
    ['fast_click', { text: 'fastlink-relay' }, JSON.stringify({ clicked: {}, url: WORKER, urlChanged: true })],
    ['fast_text', {}, txt('fastlink-relay\nDeployments\nVersion 3f2a9c1')],
  ];
  const run = runOf(rows);
  // quotes only the LIST page after navigating to the WORKER page -> refused, naming both URLs
  const p = problems(run, 'Workers listed: "gauth-father" and "fd-relay"');
  assert.match(p, new RegExp(`evidence quotes a result read on ${LIST.replace(/[.?]/g, '\\$&')}, but the page is now at ${WORKER.replace(/[.?]/g, '\\$&')}`));
  assert.doesNotMatch(p, /does not quote/);
  // quotes the read taken on the current page -> accepted
  assert.equal(problems(run, `"Version 3f2a9c1" at ${WORKER}`), '');
  // no URL ever seen (results without url) -> no URL check, the plain quote check stands
  const blind = runOf([['fast_snapshot', {}, '{"content":[{"text":"hello world page"}]}']]);
  assert.equal(problems(blind, 'it says "hello world page"'), '');
  // the trail is the last-seen URL: back on the list, a list quote is current again
  const back = runOf([...rows, ['fast_click', { text: 'Workers & Pages' }, JSON.stringify({ clicked: {}, url: LIST })], ['fast_snapshot', {}, snap(LIST, 'gauth-father')]]);
  assert.equal(problems(back, 'the list shows "gauth-father"'), '');
});

test('check 3: a failed call never retried is refused once, then recorded as unresolvedFailures', () => {
  // the cfworkers run (ae2428fc): click with role:"a" failed, never retried, then a fast_text of the list page
  const rows = [
    ['fast_tab', { url: LIST }, `{"id":1,"url":"${LIST}"}`],
    ['fast_snapshot', { full: true }, snap(LIST, 'fastlink-relay', 'gauth-father')],
    ['fast_click', { text: 'fastlink-relay', role: 'a', index: 0 }, '{"error":"Found 2 match(es) for \\"fastlink-relay\\" but none satisfied role=\\"a\\""}'],
    ['fast_text', { selector: 'body' }, txt('Workers & Pages\nfastlink-relay\ngauth-father')],
  ];
  const run = runOf(rows);
  assert.deepEqual(unresolvedFailures(run.toolLog), [{ name: 'fast_click', target: 'fastlink-relay', t: 2000 }]);
  const ev = `"gauth-father" listed at ${LIST}`;
  assert.equal(problems(run, ev), 'your last attempt to fast_click "fastlink-relay" failed and was never retried; retry it or explain in `result` why it is not needed');
  // once refused (the loop records unresolvedFailures on the refusal), the next report_done passes the gate
  run.gateRefusals.push({ turn: 3, t: 5000, problems: ['…'], unresolvedFailures: unresolvedFailures(run.toolLog) });
  assert.equal(problems(run, ev), '');
  assert.equal(unresolvedFailures(run.toolLog).length, 1, 'still unresolved: the run row gets it');
  // a later successful call of the same tool + target resolves it
  const retried = runOf([...rows, ['fast_click', { text: 'fastlink-relay', index: 1 }, JSON.stringify({ clicked: {}, url: WORKER })], ['fast_text', {}, txt('fastlink-relay\nMetrics')]]);
  assert.deepEqual(unresolvedFailures(retried.toolLog), []);
  assert.equal(problems(retried, `"Metrics" at ${WORKER}`), '');
  // ...or another tool acting on the same target (field / match / text are interchangeable)
  const other = runOf([...rows, ['fast_wait', { text: 'fastlink-relay' }, JSON.stringify({ found: {}, snapshot: { url: LIST, content: [{ text: 'fastlink-relay' }] } })]]);
  assert.deepEqual(unresolvedFailures(other.toolLog), []);
  const fill = [{ name: 'fast_fill', ok: false, args: { match: 'Name' }, t: 0 }, { name: 'fast_select_option', ok: true, args: { field: 'Name' }, t: 1 }];
  assert.deepEqual(unresolvedFailures(fill), []);
  // a target-less failure (fast_evaluate disabled) is resolved only by the same tool succeeding
  const evalLog = [{ name: 'fast_evaluate', ok: false, args: { fn: '() => 1' }, t: 0 }, { name: 'fast_snapshot', ok: true, args: {}, t: 1 }];
  assert.deepEqual(unresolvedFailures(evalLog), [{ name: 'fast_evaluate', target: '', t: 0 }]);
  assert.match(gateProblems({ toolLog: evalLog, corpus: [{ text: '{"content":[{"text":"page body here"}]}', url: '' }], urlTrail: [], gateRefusals: [] }, { evidence: '"page body here"' }).join(';'), /your last attempt to fast_evaluate failed/);
  assert.deepEqual(unresolvedFailures([...evalLog, { name: 'fast_evaluate', ok: true, args: { fn: '() => 2' }, t: 2 }]), []);
  // repeated failures of one intent collapse to the latest attempt
  const twice = [{ name: 'fast_click', ok: false, args: { text: 'Go' }, t: 0 }, { name: 'fast_click', ok: false, args: { text: 'Go' }, t: 1 }];
  assert.deepEqual(unresolvedFailures(twice), [{ name: 'fast_click', target: 'Go', t: 1 }]);
});

test('check 3: a failed read/wait is resolved by a later action + read; a failed action is not', () => {
  // mapsdir run 9555f5ff: two waits timed out, then Enter submitted the route and a snapshot read it
  const ROUTE = 'https://www.google.com/maps/dir/JFK/Times+Square';
  const rows = [
    ['fast_tab', { url: 'https://www.google.com/maps' }, '{"id":1,"url":"https://www.google.com/maps"}'],
    ['fast_fill', { fields: { 'Choose starting point': 'JFK', 'Choose destination': 'Times Square' } }, '{"verified":true}'],
    ['fast_wait', { text: 'min', networkIdle: true }, '{"error":"Timed out waiting for \\"min\\""}'],
    ['fast_wait', { text: 'min without traffic' }, '{"error":"Timed out waiting for \\"min without traffic\\""}'],
  ];
  const stuck = runOf(rows);
  assert.deepEqual(unresolvedFailures(stuck.toolLog).map(f => f.target), ['min', 'min without traffic']);
  const done = runOf([...rows, ['fast_key_press', { key: 'Enter' }, '{"keyDispatched":"Enter"}'], ['fast_snapshot', {}, snap(ROUTE, '1 hr 11 min', '14.9 miles')]]);
  assert.deepEqual(unresolvedFailures(done.toolLog), []);
  assert.equal(problems(done, `"1 hr 11 min" at ${ROUTE}`), '');
  // a read alone after the failed wait does not resolve it (nothing changed the page)
  assert.equal(unresolvedFailures(runOf([...rows, ['fast_snapshot', {}, snap(ROUTE, 'Delays')]]).toolLog).length, 2);
  // an action with no read after it does not resolve it either
  assert.equal(unresolvedFailures(runOf([...rows, ['fast_key_press', { key: 'Enter' }, '{}']]).toolLog).length, 2);
  // failed snapshot / text reads follow the same rule
  const readFail = [{ name: 'fast_text', ok: false, args: { selector: '#x' }, t: 0 }, { name: 'fast_click', ok: true, args: { text: 'Go' }, t: 1 }, { name: 'fast_text', ok: true, args: {}, t: 2 }];
  assert.deepEqual(unresolvedFailures(readFail), []);
  // a failed ACTION still needs a retry on its own target: another action + read is not enough
  const actFail = [{ name: 'fast_click', ok: false, args: { text: 'Search' }, t: 0 }, { name: 'fast_key_press', ok: true, args: { key: 'Enter' }, t: 1 }, { name: 'fast_snapshot', ok: true, args: {}, t: 2 }];
  assert.deepEqual(unresolvedFailures(actFail), [{ name: 'fast_click', target: 'Search', t: 0 }]);
});

test('system prompt tells the model an unretried failure blocks report_done', () => {
  assert.match(buildSystem(loadToolset('phase2'), ''), /A tool call that failed and was never retried also blocks report_done/);
});
