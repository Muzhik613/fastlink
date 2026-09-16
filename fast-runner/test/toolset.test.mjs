// node --test fast-runner/test/  — toolset filter/rename/describe mapping, no browser, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadToolset, buildTools, buildSystem, HIDDEN_TOOLS } from '../runner.mjs';
import { TOOLS } from '../../fast-dxt/server/tools.js';

// Tools that attach chrome.debugger (fast-ext/src/actions/input.js tier + its importers).
const CDP = ['fast_click_xy', 'fast_type', 'fast_evaluate', 'fast_screenshot'];
const NATIVE = ['ask_caller', 'report_done'];
const names = (tools) => tools.map(t => t.name);

test('default toolset = every server tool + native, descriptions untouched, instructions kept', () => {
  const ts = loadToolset();
  assert.equal(ts.name, 'default');
  const { tools, back } = buildTools(TOOLS, ts);
  assert.equal(TOOLS.length, 22);
  assert.equal(tools.length, TOOLS.length - HIDDEN_TOOLS.size + NATIVE.length);
  // fast_ext_reload is on the server for scripts/ship-ext.sh, but even "*" hides it: a model reloading the
  // extension mid-run tears down its own content scripts and can drop the broker link under its own run.
  assert.ok(TOOLS.some(t => t.name === 'fast_ext_reload'), 'ops tool fast_ext_reload is on the server');
  assert.ok(!names(tools).includes('fast_ext_reload') && !back.has('fast_ext_reload'), 'default "*" does not offer the operator reload');
  for (const t of TOOLS.filter(t => !HIDDEN_TOOLS.has(t.name))) {
    const seen = tools.find(x => x.name === t.name);
    assert.equal(seen.description, t.description);
    assert.equal(seen.input_schema, t.inputSchema);
    assert.equal(back.get(t.name), t.name);
  }
  assert.match(tools.find(t => t.name === 'report_done').description, /^Finish the task\. result = concise/, 'baseline native descriptions untouched');
  assert.match(buildSystem(ts, 'ESSAY'), /Tool guidance from FastLink:\nESSAY$/);
  assert.match(buildSystem(ts, ''), /Today is \w+ \d{4}-\d{2}-\d{2} \(America\/Chicago\)/, 'system prompt carries today\'s date + timezone');
});

test('hidden tools (scorer fast_frame_read, operator fast_ext_reload) are on the server but never model-facing: absent under every shipped toolset and an explicit allow', () => {
  assert.deepEqual([...HIDDEN_TOOLS].sort(), ['fast_ext_reload', 'fast_frame_read']);
  for (const h of HIDDEN_TOOLS) assert.ok(TOOLS.some(t => t.name === h), `${h} exists on the server`);
  assert.ok(!HIDDEN_TOOLS.has('fast_evaluate'), 'phase2-eval offers fast_evaluate on purpose');
  for (const name of ['default', 'phase2', 'phase2-eval', 'no-cdp']) {
    const { tools, back } = buildTools(TOOLS, loadToolset(name));
    for (const h of HIDDEN_TOOLS) {
      assert.ok(!names(tools).includes(h), `${name}: ${h}`);
      assert.equal(back.has(h), false, `${name}: a call to ${h} maps to nothing`);
    }
  }
  const { tools } = buildTools(TOOLS, { name: 'x', allow: ['fast_snapshot', ...HIDDEN_TOOLS], rename: {}, describe: {} });
  assert.deepEqual(names(tools), ['fast_snapshot', ...NATIVE]);
});

test('no shipped toolset override contradicts tools.js on id / frame / index (da54792, 81054d8)', () => {
  // Two descriptions of one tool must agree: the override replaces tools.js's text, but the model still
  // sees tools.js's input schema, so an override that says otherwise sends it two stories.
  for (const name of ['phase2', 'phase2-eval', 'no-cdp']) {
    const ts = loadToolset(name);
    for (const [tool, text] of Object.entries(ts.describe)) {
      const schema = TOOLS.find(t => t.name === tool)?.inputSchema?.properties || {};
      const at = `${name} ${tool}`;
      assert.doesNotMatch(text, /NOT a snapshot id/i, `${at}: a snapshot item id IS a target now`);
      if (schema.id) assert.match(text, /`id`/, `${at}: names the id target`);
      if (schema.id) assert.match(text, /f7:42|f<frameId>:/, `${at}: shows the frame id form`);
      // fast_wait's `frame` is the scorer's hidden read-back (fast-ext index.js), so its override does not advertise it
      if (schema.frame && tool !== 'fast_snapshot' && tool !== 'fast_wait') assert.match(text, /`frame/, `${at}: names frame`);
      if (tool === 'fast_wait') assert.match(text, /frames are searched/, `${at}: a text wait searches frames`);
      if (tool === 'fast_snapshot') assert.match(text, /`frames`/, `${at}: frame items come under frames`);
      if (schema.index && /index = the N-th/.test(text) && tool === 'fast_click') assert.match(text, /with text|text match/, `${at}: the N-th-match reading of index is only WITH text`);
      if (tool === 'fast_click_xy') assert.doesNotMatch(text, /cross-origin iframe\)/, `${at}: fast_click reaches visible cross-origin frames`);
    }
  }
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
  assert.ok(!names(tools).includes('fast_status') && !names(tools).includes('fast_profile'));
  assert.ok(!names(tools).includes('fast_ext_reload'), 'INTERNAL ops tool never offered to Grok');
  // fill_form is folded into fast_fill {fields}; the batching nudge is in the data + one sentence each
  assert.ok(!TOOLS.some(t => t.name === 'fast_fill_form') && !names(tools).includes('fast_fill_form'));
  assert.ok(TOOLS.find(t => t.name === 'fast_fill').inputSchema.properties.fields, 'server fast_fill takes fields');
  assert.match(ts.describe.fast_fill, /fields:\{/); assert.match(ts.describe.fast_snapshot, /fillable:N/); assert.match(ts.describe.fast_batch, /ifFound/);
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
  assert.equal(tools.length, 13);
  assert.ok(!names(tools).includes('fast_ext_reload'), 'INTERNAL ops tool never offered to Grok');
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
