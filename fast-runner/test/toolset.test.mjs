// node --test fast-runner/test/  — toolset filter/rename/describe mapping, no browser, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadToolset, buildTools, buildSystem, gateProblems } from '../runner.mjs';
import { TOOLS } from '../../fast-dxt/server/tools.js';

// Tools that attach chrome.debugger (fast-ext/src/actions/input.js tier + its importers).
const CDP = ['fast_click_xy', 'fast_wheel', 'fast_drag_xy', 'fast_type', 'fast_key', 'fast_upload', 'fast_evaluate', 'fast_screenshot', 'fast_fill_vision', 'fast_do'];
const NATIVE = ['ask_caller', 'report_done'];
const names = (tools) => tools.map(t => t.name);

test('default toolset = every server tool + native, descriptions untouched, instructions kept', () => {
  const ts = loadToolset();
  assert.equal(ts.name, 'default');
  const { tools, back } = buildTools(TOOLS, ts);
  assert.equal(tools.length, TOOLS.length + NATIVE.length);
  assert.equal(TOOLS.length, 45);
  for (const t of TOOLS) {
    const seen = tools.find(x => x.name === t.name);
    assert.equal(seen.description, t.description);
    assert.equal(seen.input_schema, t.inputSchema);
    assert.equal(back.get(t.name), t.name);
  }
  assert.match(tools.find(t => t.name === 'report_done').description, /^Finish the task\. result = concise/, 'baseline native descriptions untouched');
  assert.match(buildSystem(ts, 'ESSAY'), /Tool guidance from FastLink:\nESSAY$/);
  assert.match(buildSystem(ts, ''), /Today is \w+ \d{4}-\d{2}-\d{2} \(America\/Chicago\)/, 'system prompt carries today\'s date + timezone');
});

test('evidence gate: refuses report_done without a read after the last action or without a verbatim quote', () => {
  const log = (rows) => rows.map(([name, ok, args = {}]) => ({ name, ok, args }));
  const corpus = ['{"content":[{"text":"It\'s Only the Himalayas"},{"text":"£45.17"}],"url":"https://x"}'];
  // last action = fill, nothing read since -> refused
  assert.match(gateProblems({ toolLog: log([['fast_tab', true], ['fast_fill', true]]), corpus }, { evidence: '"£45.17"' }).join(';'), /no tool has read the page since your last fast_fill/);
  // read after the action but evidence quotes nothing from a result -> refused
  assert.match(gateProblems({ toolLog: log([['fast_fill', true], ['fast_snapshot', true]]), corpus }, { evidence: 'the price is right, trust me' }).join(';'), /evidence does not quote/);
  // read after the action + verbatim quote -> accepted
  assert.deepEqual(gateProblems({ toolLog: log([['fast_fill', true], ['fast_snapshot', true]]), corpus }, { evidence: 'h1 "It\'s Only the Himalayas", price £45.17 at https://x' }), []);
  // a failed read does not count
  assert.match(gateProblems({ toolLog: log([['fast_click', true], ['fast_text', false]]), corpus }, { evidence: '"£45.17"' }).join(';'), /no tool has read/);
  // the action's own auto-snapshot is not a read-back
  assert.match(gateProblems({ toolLog: log([['fast_snapshot', true], ['fast_select_option', true]]), corpus }, { evidence: '"£45.17"' }).join(';'), /fast_select_option/);
  // networkIdle wait reads nothing; text-mode wait does
  assert.match(gateProblems({ toolLog: log([['fast_click', true], ['fast_wait', true, { networkIdle: true }]]), corpus }, { evidence: '"£45.17"' }).join(';'), /no tool has read/);
  assert.deepEqual(gateProblems({ toolLog: log([['fast_click', true], ['fast_wait', true, { text: 'Himalayas' }]]), corpus }, { evidence: '"£45.17"' }), []);
});

test('"default" and unset and FASTRUN_TOOLSET resolve the same file', () => {
  const a = loadToolset('default'), b = loadToolset(undefined);
  process.env.FASTRUN_TOOLSET = 'phase2';
  const c = loadToolset();
  delete process.env.FASTRUN_TOOLSET;
  assert.equal(a.file, b.file);
  assert.equal(c.name, 'phase2');
});

test('phase2: 12 FastLink + 2 native = 14 (no fast_evaluate), every allowed tool re-described, instructions dropped', () => {
  const ts = loadToolset('phase2');
  const { tools, back } = buildTools(TOOLS, ts);
  assert.equal(tools.length, 14);
  assert.ok(!names(tools).includes('fast_evaluate'), 'fast_evaluate is relay-disabled for the runner account: not offered');
  assert.deepEqual(names(tools).slice(-2), NATIVE);
  assert.deepEqual([...names(tools).slice(0, -2)].sort(), [...ts.allow].sort(), 'exactly the allowed tools (server order, allow order irrelevant)');
  for (const t of tools) {
    if (NATIVE.includes(t.name)) continue;
    assert.ok(ts.describe[t.name], `${t.name} has a Grok-tuned description`);
    assert.equal(t.description, ts.describe[t.name]);
    assert.ok(t.description.split(/(?<=[.!?])\s+/).length <= 2, `${t.name}: <= 2 sentences`);
    assert.equal(back.get(t.name), t.name);
    assert.ok(TOOLS.some(s => s.name === t.name), `${t.name} exists on the server`);
  }
  for (const k of Object.keys(ts.describe)) assert.ok(ts.allow.includes(k) || NATIVE.includes(k), `describe key ${k} is allowed or native`);
  // report_done is re-described in phase2 (terse report = fewer output tokens per run); ask_caller keeps the baseline text.
  assert.equal(tools.find(t => t.name === 'report_done').description, ts.describe.report_done);
  assert.ok(ts.describe.report_done && !ts.describe.ask_caller);
  assert.ok(!names(tools).includes('fast_status') && !names(tools).includes('fast_scout') && !names(tools).includes('fast_prewarm'));
  assert.equal(buildSystem(ts, 'ESSAY'), buildSystem(ts, ''));
  assert.doesNotMatch(buildSystem(ts, 'ESSAY'), /ESSAY/);
});

test('phase2-eval = phase2 + fast_evaluate, nothing else differs', () => {
  const a = loadToolset('phase2'), b = loadToolset('phase2-eval');
  assert.deepEqual(b.allow, [...a.allow, 'fast_evaluate']);
  assert.ok(b.describe.fast_evaluate && /READ-ONLY/.test(b.describe.fast_evaluate));
  const { fast_evaluate, ...rest } = b.describe;
  assert.deepEqual(rest, a.describe);
  assert.equal(buildTools(TOOLS, b).tools.length, 15);
});

test('no-cdp: no tool that attaches chrome.debugger', () => {
  const ts = loadToolset('no-cdp');
  const { tools } = buildTools(TOOLS, ts);
  assert.equal(tools.length, 14);
  for (const n of names(tools)) assert.ok(!CDP.includes(n), `${n} needs CDP`);
  for (const k of Object.keys(ts.describe)) assert.ok(ts.allow.includes(k), `describe key ${k} is allowed`);
});

test('rename maps the Grok-facing name back to the real tool on call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fastrun-ts-'));
  const file = join(dir, 'toolset.custom.json');
  writeFileSync(file, JSON.stringify({ allow: ['fast_click', 'fast_snapshot'], rename: { fast_snapshot: 'read_page' }, describe: { fast_snapshot: 'Read it.' } }));
  const ts = loadToolset(file);
  assert.equal(ts.name, 'custom');
  const { tools, back } = buildTools(TOOLS, ts);
  assert.deepEqual(names(tools), ['fast_snapshot', 'fast_click', 'ask_caller', 'report_done'].map(n => n === 'fast_snapshot' ? 'read_page' : n));
  assert.equal(back.get('read_page'), 'fast_snapshot');
  assert.equal(back.get('fast_snapshot'), undefined);
  assert.equal(tools.find(t => t.name === 'read_page').description, 'Read it.');
});

test('bad toolset name or shape throws before any connect', () => {
  assert.throws(() => loadToolset('nope'), /toolset "nope": cannot read/);
  const dir = mkdtempSync(join(tmpdir(), 'fastrun-ts-'));
  const file = join(dir, 'empty.json');
  writeFileSync(file, JSON.stringify({ allow: [] }));
  assert.throws(() => loadToolset(file), /"allow" must be a non-empty array/);
});
