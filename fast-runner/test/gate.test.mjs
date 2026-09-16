// node --test — the report_done evidence gate on synthetic tool logs (no browser, no model).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateProblems, recordResult, corpusRow, unresolvedFailures, claimMismatch, partialFailures, entryFacts, buildSystem, loadToolset, reportDone, gateMode } from '../runner.mjs';

const LIST = 'https://dash.cloudflare.com/acc/workers-and-pages';
const WORKER = 'https://dash.cloudflare.com/acc/workers/services/view/fastlink-relay/production';

// Feed results through recordResult exactly as the loop does: [name, args, resultText, isError?].
function runOf(rows) {
  const run = { toolLog: [], corpus: [], urlTrail: [], gateRefusals: [] };
  rows.forEach(([name, args, text = '{}', isError = false], i) => {
    const ok = recordResult(run, text, isError);
    run.toolLog.push({ t: i * 1000, name, args, ok, preview: text.slice(0, 100), ...entryFacts(name, args, text, ok) });
  });
  return run;
}
const snap = (url, ...texts) => JSON.stringify({ url, content: texts.map(text => ({ text })) });
const txt = (text) => JSON.stringify({ from: 'body', text });
const problems = (run, evidence) => gateProblems(run, { result: 'x', evidence }).join(';');

test('check 1 (as before): a read must follow the last action; evidence must quote a result', () => {
  const corpus = [corpusRow(['{"content":[{"text":"It\'s Only the Himalayas"},{"text":"£45.17"}],"url":"https://x"}'])];
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
  assert.match(gateProblems({ toolLog: evalLog, corpus: [corpusRow(['{"content":[{"text":"page body here"}]}'])], urlTrail: [], gateRefusals: [] }, { evidence: '"page body here"' }).join(';'), /your last attempt to fast_evaluate failed/);
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
  // the entity is QUOTED and is not the page that loaded, so this is still an
  // overclaim (a bare "We went to the Worker" is credited to the first load since
  // 2026-09-16 — see the Azure test below)
  assert.match(gateProblems(runOf(rows), { result: 'We went to the "fastlink-relay" Worker', evidence }).join(), /If the task asked you to go to, do it now/);
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

// ── evidence matcher: the real reports the old matcher refused ─────────────────
const AA = 'https://www.aa.com/booking/search/find-flights';
const aaRows = () => [
  ['fast_tab', { url: AA }, `{"id":1,"url":"${AA}"}`],
  ['fast_batch', { actions: [{ name: 'fast_fill', args: { fields: { 'Leaving from': 'JFK', 'Going to': 'LAX', 'Departure date': '10/15/2026', 'Return date': '10/22/2026' } } }] },
    JSON.stringify({ summary: '4/4 steps ok', ok: 4, results: [
      { step: 0, name: 'fast_fill', ok: true, result: { verified: true, fields: {
        'Leaving from': { verified: true, value: 'JFK', filled: { tag: 'input', placeholder: 'Leaving from', name: 'orig', ariaLabel: 'Departure airport' } },
        'Going to': { verified: true, value: 'LAX', filled: { tag: 'input', placeholder: 'Going to', name: 'dest' } },
        'Departure date': { verified: true, value: '10/15/2026', filled: { tag: 'input', placeholder: 'mm/dd/yyyy', ariaLabel: 'Departure date' } },
        'Return date': { verified: true, value: '10/22/2026', filled: { tag: 'input', placeholder: 'mm/dd/yyyy', ariaLabel: 'Return date' } } } } },
      { step: 1, name: 'fast_select_option', ok: true, result: { verified: true, picked: '2', value: '2', field: { tag: 'select', label: 'Number of passengers', section: 'Passengers' } } },
      { step: 2, name: 'fast_select_option', ok: true, result: { verified: true, picked: 'Business / First', value: 'Business / First', field: { tag: 'select', label: 'Class' } } },
      { step: 3, name: 'fast_select_option', ok: true, result: { verified: true, picked: 'American Airlines', value: 'American Airlines', field: { tag: 'select', label: 'Airline' } } }] })],
  ['fast_snapshot', { full: true, limit: 30 }, JSON.stringify({ url: AA, title: 'American Airlines - Advanced search', items: [
    { i: 284, tag: 'input', text: 'JFK', role: 'combobox', value: 'JFK', name: 'orig', placeholder: 'Leaving from' },
    { i: 290, tag: 'select', value: 'Business / First', innerText: 'Show all  Business / First', label: 'Class' }] })],
];

test('evidence: hvm flightsearch reports (refused 3× and overridden by the old matcher) quote real values', () => {
  const run = runOf(aaRows());
  // 18:26 / 18:41 / 18:44 / 19:53 (78477b54, 319ebee7, df8959b2, fcd7afc5) and 17:48 (d133d581): the
  // 3-char "JFK" shifted the old quote pairing onto ` ... value=`, and value="…" never equals "value":"…"
  for (const ev of [
    'value="JFK" (Leaving from), value="LAX" (Going to), value="10/15/2026" (Departure date), value="10/22/2026" (Return date); select value="2" (Number of passengers), value="Business / First" (Class), value="American Airlines" (Airline)',
    `value="JFK" ... value="LAX" ... value="10/15/2026" ... value="10/22/2026" ... value="2" ... value="Business / First" ... value="American Airlines" (URL ${AA})`,
    `value="JFK" ... value="LAX" ... value="10/15/2026" ... value="10/22/2026" ... value="2" ... value="Business / First" ... value="American Airlines" (from fast_snapshot items on ${AA})`,
    'value="JFK" (item 284 in snapshot)',
    '"value":"JFK","name":"orig" ... "value":"LAX","name":"dest" ... "value":"10/15/2026","name":"date"',
    'Leaving from=JFK; Going to=LAX; Departure date=10/15/2026',
  ]) assert.equal(problems(run, ev), '', ev);
});

test('evidence: fabricated quotes still fail — values, phrases and short tokens that no result holds', () => {
  const run = runOf(aaRows());
  for (const ev of [
    'value="SFO" ... value="ORD" ... value="11/01/2026" ... value="Economy"',
    'the price is right, trust me',
    '"SFO" and "ORD"',
    'Flights from Boston to Denver on 11/01/2026',
    'value="JF" (item 284)',                       // a 2-char fragment of a real value is not a quote
    `"Search completed, 42 flights found" at ${AA}`,
  ]) assert.match(problems(run, ev), /evidence does not quote/, ev);
  // structure words alone ("value", "name", "placeholder") are JSON keys, never evidence
  assert.match(problems(run, 'value name placeholder'), /evidence does not quote/);
});

test('evidence: normalization — newlines between blocks, JSON escapes, curly quotes, dashes, every text block', () => {
  const SEL = 'https://www.selenium.dev/selenium/web/web-form.html';
  const run = runOf([['fast_tab', { url: SEL }, `{"id":1,"url":"${SEL}"}`], ['fast_snapshot', {}, snap(SEL, 'Web form', 'Text input', 'Password', 'Textarea', 'Open this select menu')]]);
  // selenium 18:00 (c76dc2c9): consecutive content blocks copied as lines
  assert.equal(problems(run, `Web form\nText input\n Password\n Textarea | ${SEL}`), '');
  assert.equal(problems(run, 'the select reads \\"Open this select menu\\"'), '');            // JSON-escaped quote copied verbatim
  assert.equal(problems(run, 'heading “Web form”, then ‘Text input’'), '');                  // curly quotes
  const dash = runOf([['fast_snapshot', {}, snap('https://a', 'Google Auth Platform – Google Cloud console')]]);
  assert.equal(problems(dash, '"Google Auth Platform - Google Cloud console"'), '');         // en dash vs hyphen
  // a quote from the SECOND text block of a result is in the corpus too
  const two = { toolLog: [{ name: 'fast_snapshot', ok: true, args: {} }], corpus: [], urlTrail: [], gateRefusals: [] };
  recordResult(two, ['{"url":"https://b","items":[]}', 'Extra block: Order #77812 confirmed'], false);
  assert.equal(problems(two, '"Order #77812 confirmed"'), '');
});

// ── gcpform recording #4 (relay, grok-4.3, 2026-09-15T20:03:03Z, f96c8d9c) ────
const GCP4 = 'https://console.cloud.google.com/auth/clients/create?project=booming-argon-464605-n5';
const JS4 = 'Authorized JavaScript origins', RD4 = 'Authorized redirect URIs';
const sectionMiss = (l, btns) => ({ error: `No visible fillable element matching "${l}". Nothing was filled.`, candidates: [{ tag: 'input', label: 'Name' }], section: l, buttons: btns, hint: `"${l}" is a section with no input yet` });
const uriFill = (v) => JSON.stringify({ verified: true, filled: 1, missed: 0, total: 1, fields: { 'URIs 1': { verified: true, value: v, filled: { tag: 'input', label: 'URIs 1', placeholder: 'https://www.example.com' } } }, snapshot: { url: GCP4, items: [] } });
const gcp4 = [
  ['fast_tab', { url: GCP4 }, `{"id":1220561903,"url":"${GCP4}"}`],
  ['fast_snapshot', { full: true }, snap(GCP4, 'Google Auth Platform')],
  ['fast_snapshot', { full: true, limit: 200 }, snap(GCP4, 'Create OAuth client ID', JS4, RD4)],
  ['fast_select_option', { field: 'Application type', option: 'Web application' }, JSON.stringify({ verified: true, picked: 'Web application', field: { tag: 'cfc-select', label: 'Application type', section: 'Create OAuth client ID' }, snapshot: { url: GCP4, items: [] } })],
  ['fast_fill', { fields: { Name: 'FastLink Bench', [JS4]: 'https://bench.example.com', [RD4]: 'https://bench.example.com/callback' } },
    JSON.stringify({ verified: false, filled: 1, missed: 2, total: 3, fields: { Name: { verified: true, value: 'FastLink Bench', filled: { tag: 'input', label: 'Name' } }, [JS4]: sectionMiss(JS4, ['Add URI', 'Help with Javascript origins']), [RD4]: sectionMiss(RD4, ['Add URI']) } })],
  ['fast_click', { text: 'Add URI', index: 0 }, JSON.stringify({ clicked: { text: 'Add URI' }, url: GCP4 })],
  ['fast_click', { text: 'Add URI', index: 1 }, JSON.stringify({ clicked: { text: 'Add URI' }, url: GCP4 })],
  ['fast_fill', { fields: { 'URIs 1': 'https://bench.example.com' }, section: JS4 }, uriFill('https://bench.example.com')],
  ['fast_fill', { fields: { 'URIs 1': 'https://bench.example.com/callback' }, section: RD4 }, uriFill('https://bench.example.com/callback')],
  ['fast_snapshot', { full: true, limit: 50 }, snap(GCP4, 'Create OAuth client ID', JS4, RD4)],
];

test('check 3: a missed section label is resolved by a later fill with section:<that label> (recording #4)', () => {
  const run = runOf(gcp4);
  assert.deepEqual(unresolvedFailures(run.toolLog), []);
  const p = gateProblems(run, { result: 'All four fields filled', evidence: `"${JS4}" and "${RD4}" (exact phrases from the final fast_snapshot content at ${GCP4})` });
  assert.deepEqual(p, [], p.join('\n'));
  // only ONE section filled → the other label is still unresolved
  const half = runOf(gcp4.filter((_, i) => i !== 8));
  assert.deepEqual(unresolvedFailures(half.toolLog).map(f => f.target), [RD4]);
  // a fill in that section that MISSED its field does not resolve the label
  const missed = runOf([...gcp4.slice(0, 7), ['fast_fill', { fields: { 'URIs 1': 'x' }, section: JS4 }, JSON.stringify({ verified: false, filled: 0, missed: 1, total: 1, fields: { 'URIs 1': { error: 'No fillable element matching "URIs 1" inside section' } } })]]);
  assert.deepEqual(unresolvedFailures(missed.toolLog).map(f => f.target), [JS4, RD4, 'URIs 1']);
  // per-field section (fields:{label:{value, section}}) and a single {match, section} fill count too
  const perField = runOf([...gcp4.slice(0, 7), ['fast_fill', { fields: { 'URIs 1': { value: 'a', section: JS4 }, 'URIs 2': { value: 'b', section: RD4 } } }, '{"verified":true,"fields":{}}']]);
  assert.deepEqual(unresolvedFailures(perField.toolLog), []);
  const single = runOf([...gcp4.slice(0, 7), ['fast_fill', { match: 'URIs 1', value: 'a', section: JS4.toLowerCase() }, '{"verified":true}'], ['fast_fill', { match: 'URIs 1', value: 'b', near: RD4 }, '{"verified":true}']]);
  assert.deepEqual(unresolvedFailures(single.toolLog), []);
  // ...and a fill whose RESULT reports the section it wrote in (no section arg)
  const byResult = runOf([...gcp4.slice(0, 7),
    ['fast_fill', { match: 'URIs 1', value: 'a', index: 0 }, JSON.stringify({ verified: true, filled: { tag: 'input', label: 'URIs 1', section: JS4 } })],
    ['fast_select_option', { field: 'Region', option: 'EU' }, JSON.stringify({ verified: true, field: { tag: 'select', label: 'Region', section: RD4 } })]]);
  assert.deepEqual(unresolvedFailures(byResult.toolLog), []);
});

// ── gate mode: on | record | off ──────────────────────────────────────────────
const CF = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages';
const cfRows = [
  ['fast_tab', { url: CF }, `{"id":1,"url":"${CF}"}`],
  ['fast_snapshot', { full: true }, snap(LIST, 'fastlink-relay', 'gauth-father')],
  ['fast_click', { text: 'fastlink-relay', role: 'a' }, '{"error":"none satisfied role=\\"a\\""}'],
  ['fast_text', {}, txt('Workers & Pages\nfastlink-relay\ngauth-father')],
];
const bad = { result: 'Worker "fastlink-relay" opened', evidence: 'the price is right, trust me' };   // 3 checks fire + claimMismatch
const good = { result: 'Listed: fastlink-relay, gauth-father', evidence: `"gauth-father" at ${LIST}` };
const moded = (gate, rows = cfRows) => Object.assign(runOf(rows), { gate, turns: [] });

test('gate mode: record runs the same checks as on, never refuses, and records what on would have refused', () => {
  const on = moded('on');
  const refused = reportDone(on, bad, 1234);
  assert.ok(refused.refuse?.length >= 3, JSON.stringify(refused));
  const rec = moded('record');
  const v = reportDone(rec, bad, 1234);
  assert.equal(v.refuse, undefined, 'record never refuses');
  assert.deepEqual(v.finish.gateWouldRefuse, [{ t: 1234, problems: refused.refuse, evidence: bad.evidence, result: bad.result }]);
  assert.deepEqual(rec.gateRefusals, [], 'no refusal is logged in record mode');
  assert.deepEqual(v.finish.unresolvedFailures, unresolvedFailures(rec.toolLog));
  assert.deepEqual(v.finish.claimMismatch, [{ verb: 'opened', family: 'fast_click / fast_nav / fast_tab (beyond the first page load)' }]);
  // a report on would pass → record finishes with no gateWouldRefuse (only the unresolved click is still carried, as on carries it)
  const clean = moded('record', [...cfRows.slice(0, 2), cfRows[3]]);
  const ok = reportDone(clean, good, 50);
  assert.equal(ok.finish.gateWouldRefuse, undefined);
  assert.deepEqual(reportDone(moded('on', [...cfRows.slice(0, 2), cfRows[3]]), good, 50), ok);
});

test('gate mode: on refuses up to 3 times then accepts flagged gateOverridden (unchanged); off checks nothing', () => {
  const on = moded('on');
  for (let i = 0; i < 3; i++) assert.ok(reportDone(on, bad, i).refuse, `refusal ${i + 1}`);
  const last = reportDone(on, bad, 9);
  assert.equal(last.finish.result, bad.result);
  assert.equal(on.gateRefusals.length, 3);
  assert.match(on.gateOverridden.join(), /evidence does not quote/);
  const off = moded('off');
  assert.deepEqual(reportDone(off, bad, 1), { finish: { result: bad.result, evidence: bad.evidence } });
  assert.deepEqual(reportDone(moded('off', []), {}, 1), { finish: { result: '', evidence: '' } }, 'not even "no tool has been called"');
  assert.deepEqual(off.gateRefusals, []);
  assert.equal(off.gateOverridden, undefined);
});

test('gate mode: default on, FASTRUN_GATE / explicit spec, bad values throw', () => {
  const env = process.env.FASTRUN_GATE;
  delete process.env.FASTRUN_GATE;
  assert.equal(gateMode(), 'on');
  process.env.FASTRUN_GATE = 'record';
  assert.equal(gateMode(), 'record');
  assert.equal(gateMode('OFF'), 'off');
  assert.throws(() => gateMode('maybe'), /must be one of on \| record \| off/);
  if (env == null) delete process.env.FASTRUN_GATE; else process.env.FASTRUN_GATE = env;
});

// ── gate=record 2026-09-15 would-refuse entries (docs/GROK_RUNNER_BENCH_hvm_gate_record_2026-09-15.md) ──
const RS = 'https://react-select.com/home';
const forest = JSON.stringify({ verified: true, picked: 'Forest', value: 'Forest', field: { tag: 'input', role: 'combobox', id: 'react-select-3-input', section: 'Single' }, kind: 'react-select', snapshot: { url: RS, items: [] } });
const oceanMiss = JSON.stringify({ error: 'Found 1 match(es) for "Ocean" but none satisfied role="combobox". Nothing was clicked', hint: 'this is a select control (field "Multi Select"); use fast_select_option {field:"Multi Select", option:"<choice>"} instead of clicking/typing its value', selectField: { tag: 'input', role: 'combobox', id: 'react-select-8-input', section: 'Multi Select' } });
const overlay = [
  ['fast_tab', { url: RS }, `{"id":1,"url":"${RS}"}`],
  ['fast_snapshot', { full: true }, snap(RS, 'Single', 'Multi Select')],
  ['fast_select_option', { field: 'Single', option: 'Forest' }, forest],
];
const overlayEv = { result: 'Selected "Forest" in the first (Single) dropdown.', evidence: `picked:"Forest", value:"Forest", field section:"Single" (URL ${RS})` };

test('check 1: a write whose own result is verified:true is its read-back (overlay p2/p3 9f8e55fd-class)', () => {
  const run = runOf(overlay);
  assert.equal(run.toolLog[2].verified, true);
  assert.deepEqual(gateProblems(run, overlayEv), []);
  // not for a LATER action: a click after the verified select still needs a read
  const clicked = runOf([...overlay, ['fast_click', { text: 'Go' }, '{"clicked":{}}']]);
  assert.match(gateProblems(clicked, overlayEv).join(), /no tool has read the page since your last fast_click/);
  // verified:false (a missed field) is no read-back
  const unverified = runOf([...overlay.slice(0, 2), ['fast_fill', { fields: { A: 'x', B: 'y' } }, JSON.stringify({ verified: false, fields: { A: { verified: true, value: 'x' }, B: { error: 'no match' } } })]]);
  assert.match(gateProblems(unverified, { result: 'r', evidence: '"Single"' }).join(), /no tool has read the page since your last fast_fill/);
  // fast_fill {fields} and fast_batch whose LAST state-changing step is a verified write
  assert.equal(entryFacts('fast_fill', { fields: { A: 'x' } }, '{"verified":true,"fields":{"A":{"verified":true}}}', true).verified, true);
  const b = (steps, results) => entryFacts('fast_batch', { actions: steps }, JSON.stringify({ results }), true).verified;
  assert.equal(b([{ name: 'fast_fill', args: {} }, { name: 'fast_select_option', args: {} }, { name: 'fast_snapshot', args: {} }],
    [{ step: 0, name: 'fast_fill', ok: true, result: { verified: true } }, { step: 1, name: 'fast_select_option', ok: true, result: { verified: true } }, { step: 2, name: 'fast_snapshot', ok: true, result: {} }]), true);
  assert.equal(b([{ name: 'fast_fill', args: {} }, { name: 'fast_click', args: {} }],
    [{ step: 0, name: 'fast_fill', ok: true, result: { verified: true } }, { step: 1, name: 'fast_click', ok: true, result: {} }]), undefined, 'a click after the fill is unread');
  assert.equal(entryFacts('fast_click', {}, '{"verified":true}', true).verified, undefined, 'only writes carry a read-back');
});

test('check 3: a failed click whose error redirected to fast_select_option is superseded by a later successful select (overlay p1)', () => {
  const rows = [...overlay.slice(0, 2), ['fast_click', { text: 'Ocean', role: 'combobox', index: 0 }, oceanMiss], overlay[2]];
  const run = runOf(rows);
  assert.equal(run.toolLog[2].redirect, 'fast_select_option');
  assert.deepEqual(unresolvedFailures(run.toolLog), []);
  assert.deepEqual(gateProblems(run, overlayEv), []);
  // without the later select, the failed click stands
  assert.deepEqual(unresolvedFailures(runOf(rows.slice(0, 3)).toolLog).map(f => f.target), ['Ocean']);
  // a plain failed click (no redirect) is not superseded by an unrelated select
  const plain = runOf([...overlay.slice(0, 2), ['fast_click', { text: 'Ocean' }, '{"error":"nothing matched"}'], overlay[2]]);
  assert.deepEqual(unresolvedFailures(plain.toolLog).map(f => f.target), ['Ocean']);
});

test('check 4: the first load satisfies a claim that names its URL or its tab, whatever the phrasing (flightsearch p1-p3)', () => {
  const AA_ASK = 'https://www.aa.com/booking/find-flights';
  const run = runOf([['fast_tab', { url: AA_ASK }, `{"id":1,"url":"${AA}"}`], ...aaRows().slice(1)]);
  for (const result of [
    `New tab opened to ${AA}; fields set to: Round trip, From=JFK, To=LAX, Dep=10/15/2026, Ret=10/22/2026, Passengers=2, Class=Business / First, Airline=American Airlines (verified live; Search untouched).`,
    `New tab opened to ${AA}. Round-trip form fields set (no Search clicked): Leaving from=JFK, Going to=LAX. All read back from page.`,
    `New tab opened to ${AA}. Round-trip fields set: From=JFK, To=LAX (no Search clicked).`,
    `Navigated to ${AA_ASK} and filled the form.`,           // the requested URL counts as well as the landed one
    'Opened aa.com/booking/search/find-flights/ in the browser.',
  ]) assert.deepEqual(claimMismatch(run.toolLog, result), [], result);
  // a claim naming another page is not satisfied by the first load
  assert.deepEqual(claimMismatch(run.toolLog, 'Opened https://www.aa.com/booking/flights/results and picked the cheapest').map(c => c.verb), ['opened']);
  // cfworkers fbc16cf2 still flagged (see check 4 above): the clause names neither the list URL nor a tab
  const cf = runOf([['fast_tab', { url: CF }, `{"id":1,"url":"${CF}"}`], ['fast_snapshot', {}, snap(LIST, 'fastlink-relay')]]);
  assert.deepEqual(claimMismatch(cf.toolLog, 'Worker "fastlink-relay" opened; other Workers listed: gauth-father.').map(c => c.verb), ['opened']);
  assert.deepEqual(claimMismatch(cf.toolLog, `Opened ${CF}; the Worker "fastlink-relay" is listed.`), []);
  // DELIBERATE LOOSENING (2026-09-16, Azure): an unquoted, URL-less open/navigate
  // claim is satisfied by the run's own first load. Refusing these was costing gate
  // rounds to make an already-honest sentence sound different. What still catches an
  // overclaim: a URL no load fetched, or a quoted entity the loaded URL does not name.
  const nav = runOf([['fast_nav', { url: 'https://example.com/a' }, '{"url":"https://example.com/a"}']]);
  assert.deepEqual(claimMismatch(nav.toolLog, 'Opened a new tab with the report'), []);
  assert.deepEqual(claimMismatch(nav.toolLog, 'Opened https://example.com/b').map(c => c.verb), ['opened']);
  assert.deepEqual(claimMismatch(nav.toolLog, 'Navigated to https://example.com/a.'), []);
});

test('check 4: an honest claim about the page the run DID load is not refused for wording (Azure, 6ff5592)', () => {
  // Three result strings from one live run, all factually identical and all true; the
  // gate refused twice on wording and the model rewrote itself three times, which is
  // what spent the round the visual note needed.
  const AZ = 'https://portal.azure.com/#create/Microsoft.VirtualMachine';
  const run = runOf([
    ['fast_tab', { url: AZ }, `{"id":1,"url":"${AZ}"}`],
    ['fast_fill_vision', { fields: { 'Virtual machine name input': 'fastlink-bench-vm' } },
      JSON.stringify({ filled: [{ field: 'Virtual machine name input', found: true, value: 'fastlink-bench-vm', verified: false, reason: 'unreadable: typed but not read back' }], missed: [], submitted: false })],
    ['fast_snapshot', { full: true }, snap(AZ, 'Create a virtual machine', 'Basics')],
  ]);
  for (const result of [
    'fast_tab succeeded; filled only the VM name (unverified, cross-origin iframe) and could go no further.',
    'Opened the VM creation page and filled the VM name as fastlink-bench-vm; the value could not be read back (cross-origin iframe).',
    'Navigated to the Azure create-VM form. Only the name field was filled, and it is unverified.',
  ]) assert.deepEqual(claimMismatch(run.toolLog, result), [], result);
  // still caught: a quoted target the loaded page is not
  assert.deepEqual(claimMismatch(run.toolLog, 'Opened "Networking" and filled the subnet').map(c => c.verb), ['opened']);
});
