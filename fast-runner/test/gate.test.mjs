// node --test — the report_done evidence gate on synthetic tool logs (no browser, no model).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateProblems, recordResult, unresolvedFailures, claimMismatch, partialFailures, buildSystem, loadToolset } from '../runner.mjs';

const LIST = 'https://dash.cloudflare.com/acc/workers-and-pages';
const WORKER = 'https://dash.cloudflare.com/acc/workers/services/view/fastlink-relay/production';

// Feed results through recordResult exactly as the loop does: [name, args, resultText, isError?].
function runOf(rows) {
  const run = { toolLog: [], corpus: [], urlTrail: [], gateRefusals: [] };
  rows.forEach(([name, args, text = '{}', isError = false], i) => {
    const ok = recordResult(run, text, isError);
    const partial = ok ? partialFailures(name, args, text) : [];
    run.toolLog.push({ t: i * 1000, name, args, ok, preview: text.slice(0, 100), ...(partial.length ? { partial } : {}) });
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

test('check 4: an action the result claims but no call performed is refused once, then recorded as claimMismatch', () => {
  // cfworkers over relay, 2026-09-15T19:28:48Z (fbc16cf2): tab → wait → snapshot, never clicked, result says "opened"
  const rows = [
    ['fast_tab', { url: 'https://dash.cloudflare.com/?to=/:account/workers-and-pages' }, '{"id":1,"url":"https://dash.cloudflare.com/?to=/:account/workers-and-pages"}'],
    ['fast_wait', { text: 'Workers & Pages', networkIdle: true, timeoutMs: 15000 }, JSON.stringify({ found: {}, snapshot: { url: LIST, content: [] } })],
    ['fast_snapshot', { full: true, limit: 100 }, snap(LIST, 'fastlink-relay', 'gauth-father', 'gauth-broker-mt', 'gauth-broker-staging', 'fd-relay')],
  ];
  const run = runOf(rows);
  const result = 'Worker "fastlink-relay" opened; other Workers listed: gauth-father, gauth-broker-mt, gauth-broker-staging, fd-relay (plus Pages).';
  const evidence = `"fastlink-relay", "gauth-father", "gauth-broker-mt", "gauth-broker-staging", "fd-relay" at ${LIST}`;
  assert.deepEqual(claimMismatch(run.toolLog, result), [{ verb: 'opened', family: 'fast_click / fast_nav / fast_tab (beyond the first page load)' }]);
  const p = gateProblems(run, { result, evidence });
  assert.deepEqual(p, ['your result says "opened" but no fast_click / fast_nav / fast_tab (beyond the first page load) call succeeded. If the task asked you to open, do it now; only if it did not, rewrite result to say what you actually observed']);
  assert.match(p[0], /If the task asked you to open, do it now/);   // the do-it branch leads (19:36:57Z: "or rewrite" invited the rewrite)
  assert.match(gateProblems(runOf(rows), { result: 'Submitted the search', evidence }).join(), /If the task asked you to submit, do it now/);
  assert.match(gateProblems(runOf(rows), { result: 'We went to the Worker', evidence }).join(), /If the task asked you to go to, do it now/);
  run.gateRefusals.push({ turn: 4, t: 15000, problems: p, claimMismatch: claimMismatch(run.toolLog, result) });
  assert.deepEqual(gateProblems(run, { result, evidence }), [], 'second report_done passes; the row carries claimMismatch');
  // a genuine click run with the same claim: no refusal
  const clicked = runOf([...rows, ['fast_click', { text: 'fastlink-relay', index: 1 }, JSON.stringify({ clicked: {}, url: WORKER })], ['fast_text', {}, txt('fastlink-relay\nMetrics')]]);
  assert.deepEqual(claimMismatch(clicked.toolLog, 'Opened the Worker "fastlink-relay"; it shows Metrics'), []);
  assert.deepEqual(gateProblems(clicked, { result: 'Opened the Worker "fastlink-relay"; it shows Metrics', evidence: `"Metrics" at ${WORKER}` }), []);
  // extract: fast_tab + fast_text, result lists countries → no claim at all
  const WIKI = 'https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population';
  const extract = runOf([['fast_tab', { url: WIKI }, `{"id":2,"url":"${WIKI}"}`], ['fast_text', { selector: 'table.wikitable' }, txt('India 1,417,492,000\nChina 1,408,280,000')]]);
  assert.deepEqual(gateProblems(extract, { result: '1. India — 1,417,492,000\n2. China — 1,408,280,000', evidence: `"India 1,417,492,000" at ${WIKI}` }), []);
  // not claims: negations, and "opened a new tab" satisfied by the first load
  assert.deepEqual(claimMismatch(extract.toolLog, 'Opened a new tab to the list. Search NOT clicked, form not submitted, nothing was filled'), []);
  // other families: fill / select / submit, including fast_batch steps and Enter
  assert.deepEqual(claimMismatch(extract.toolLog, 'Filled the name and selected Two').map(c => c.verb), ['selected', 'filled']);
  const batch = [{ name: 'fast_batch', ok: true, args: { actions: [{ name: 'fast_fill', args: {} }, { name: 'fast_select_option', args: {} }] } }];
  assert.deepEqual(claimMismatch(batch, 'Filled the name and selected Two'), []);
  assert.deepEqual(claimMismatch([{ name: 'fast_key_press', ok: true, args: { key: 'Enter' } }], 'Submitted the search'), []);
  // react-select: fast_select_option failed, the pick was done by clicks → "Selected" is backed
  assert.deepEqual(claimMismatch([{ name: 'fast_tab', ok: true, args: {} }, { name: 'fast_select_option', ok: false, args: {} }, { name: 'fast_click_xy', ok: true, args: {} }], 'Selected "Forest" in the Single dropdown'), []);
  // a batch step named fast_fill_form (rewritten to fast_fill by the batch) backs "Filled"
  assert.deepEqual(claimMismatch([{ name: 'fast_batch', ok: true, args: { actions: [{ name: 'fast_fill_form', args: {} }] } }], 'Filled the form'), []);
  assert.deepEqual(claimMismatch([{ name: 'fast_key_press', ok: true, args: { key: 'Tab' } }], 'Submitted the search').map(c => c.verb), ['submitted']);
});

test('check 3: each missed field of fast_fill {fields} / failed batch step is its own failed action', () => {
  // gcpform over relay 19:50:07Z (cc84b8b9): both fills logged ok:true, two labels were never filled, result said "(blank)"
  const GCP = 'https://console.cloud.google.com/auth/clients/create?project=booming-argon-464605-n5';
  const miss = (l) => ({ error: `No visible fillable element matching "${l}". Nothing was filled.`, candidates: [{ tag: 'input', type: 'search' }] });
  const JS = 'Authorized JavaScript origins', RD = 'Authorized redirect URIs';
  const rows = [
    ['fast_tab', { url: GCP }, `{"id":1,"url":"${GCP}"}`],
    ['fast_snapshot', { full: true }, snap(GCP, 'Create OAuth client ID')],
    ['fast_snapshot', { full: true, screenshot: false }, snap(GCP, 'Application type')],
    ['fast_fill', { fields: { 'Application type': 'Web application', Name: 'FastLink Bench', [JS]: 'https://bench.example.com', [RD]: 'https://bench.example.com/callback' } },
      JSON.stringify({ verified: false, filled: 0, missed: 4, total: 4, fields: { 'Application type': miss('Application type'), Name: miss('Name'), [JS]: miss(JS), [RD]: miss(RD) } })],
    ['fast_text', { selector: 'body' }, txt('Create OAuth client ID\nApplication type')],
    ['fast_snapshot', { full: true, limit: 100 }, snap(GCP, 'Application type')],
    ['fast_select_option', { field: 'Application type', option: 'Web application' }, JSON.stringify({ verified: true, picked: 'Web application', snapshot: { url: GCP, content: [] } })],
    ['fast_fill', { fields: { Name: 'FastLink Bench', [JS]: 'https://bench.example.com', [RD]: 'https://bench.example.com/callback' } },
      JSON.stringify({ verified: false, filled: 1, missed: 2, total: 3, fields: { Name: { verified: true, value: 'FastLink Bench' }, [JS]: miss(JS), [RD]: miss(RD) } })],
    ['fast_text', { selector: 'body' }, txt('Application type\nWeb application\nName\nFastLink Bench')],
  ];
  const run = runOf(rows);
  assert.equal(run.toolLog[3].ok, true, 'the fill call itself is ok');
  assert.deepEqual(run.toolLog[3].partial.map(p => p.target), ['Application type', 'Name', JS, RD]);
  // Application type ← fast_select_option; Name ← the second fill; the two URI sections never
  assert.deepEqual(unresolvedFailures(run.toolLog), [{ name: 'fast_fill', target: JS, t: 7000 }, { name: 'fast_fill', target: RD, t: 7000 }]);
  const p = gateProblems(run, { result: 'Application type=Web application, Name=FastLink Bench, Authorized JavaScript origins=(blank), Authorized redirect URIs=(blank). Did not click Create.', evidence: '"Web application" and "FastLink Bench"' });
  assert.ok(p.includes(`your last attempt to fast_fill "${JS}" failed and was never retried; retry it or explain in \`result\` why it is not needed`), p.join('\n'));
  assert.ok(p.includes(`your last attempt to fast_fill "${RD}" failed and was never retried; retry it or explain in \`result\` why it is not needed`));
  // a later fill of the section (after "Add URI") resolves it; so does a batch step on that label
  const fixed = runOf([...rows,
    ['fast_click', { text: 'Add URI' }, '{"clicked":{}}'],
    ['fast_fill', { match: JS, value: 'https://bench.example.com' }, '{"verified":true}'],
    ['fast_batch', { actions: [{ name: 'fast_fill', args: { fields: { [RD]: 'https://bench.example.com/callback' } } }] }, JSON.stringify({ summary: '1/1 steps ok', results: [{ step: 0, name: 'fast_fill', ok: true, result: { verified: true, fields: { [RD]: { verified: true } } } }] })],
  ]);
  assert.deepEqual(unresolvedFailures(fixed.toolLog), []);
  // a failed batch step (and a batch fill step's missed field) are partial failures too
  const batch = partialFailures('fast_batch', { actions: [{ name: 'fast_click', args: { text: 'Add URI' } }, { name: 'fast_fill', args: { fields: { A: 'x', B: 'y' } } }] },
    JSON.stringify({ results: [{ step: 0, name: 'fast_click', ok: false, error: 'nothing matched' }, { step: 1, name: 'fast_fill', ok: true, result: { fields: { A: { verified: true }, B: miss('B') } } }] }));
  assert.deepEqual(batch, [{ name: 'fast_click', target: 'Add URI' }, { name: 'fast_fill', target: 'B' }]);
});

test('system prompt tells the model an unretried failure blocks report_done', () => {
  assert.match(buildSystem(loadToolset('phase2'), ''), /A tool call that failed and was never retried also blocks report_done/);
});
