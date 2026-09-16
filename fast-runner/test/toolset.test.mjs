// node --test fast-runner/test/  — toolset selection and the ONE concise description set, no browser, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadToolset, buildTools, buildSystem, HIDDEN_TOOLS } from '../runner.mjs';
import { TOOLS } from '../../fast-dxt/server/tools.js';
import { TOOLS as RELAY_TOOLS } from '../../fastlink-relay/tools.js';

// Tools that attach chrome.debugger (fast-ext/src/actions/input.js tier + its importers).
const CDP = ['fast_click_xy', 'fast_type', 'fast_evaluate', 'fast_screenshot'];
const NATIVE = ['ask_caller', 'report_done'];
const names = (tools) => tools.map(t => t.name);
const tool = (n) => TOOLS.find(t => t.name === n);
const param = (n, p) => tool(n).inputSchema.properties[p]?.description || '';

test('one concise description set: every tool <= 300 chars, every param one short line, relay identical', () => {
  for (const t of TOOLS) {
    assert.ok(t.description.length <= 300, `${t.name}: ${t.description.length} chars`);
    for (const [p, v] of Object.entries(t.inputSchema.properties || {})) assert.ok((v.description || '').length <= 100, `${t.name}.${p}: ${(v.description || '').length} chars`);
  }
  const local = TOOLS.filter(t => t.name !== 'fast_ext_reload');
  assert.deepEqual(RELAY_TOOLS, local, 'fastlink-relay/tools.js carries the same set, minus the local-only fast_ext_reload');
});

test('the must-knows survive the cut (Azure-shaped flows depend on each)', () => {
  const snap = tool('fast_snapshot').description;
  for (const w of ['items', 'i, tag, label, value', 'offscreen', '`frames`', 'f<frameId>:<i>', 'truncated:true', 'full:true']) assert.ok(snap.includes(w), `fast_snapshot: ${w}`);
  const click = tool('fast_click').description;
  for (const w of ['`id`', '`text`', 'f7:42', 'fast_select_option']) assert.ok(click.includes(w), `fast_click: ${w}`);
  for (const n of ['fast_click', 'fast_fill', 'fast_select_option', 'fast_snapshot', 'fast_wait', 'fast_scroll']) assert.match(param(n, 'frame'), /frame/, `${n}.frame`);
  assert.match(param('fast_click', 'index'), /`text` only/); assert.match(param('fast_click', 'index'), /Never an item id/);
  assert.match(param('fast_click', 'id'), /f7:42/);
  assert.match(tool('fast_fill').description, /fast_select_option/, 'fill points dropdowns to select');
  assert.match(tool('fast_select_option').description, /dropdown/);
  assert.match(tool('fast_batch').description, /steps you already know in one call/);
  assert.match(tool('fast_batch').description, /ifFound/);
  assert.match(tool('fast_screenshot').description, /Last resort/);
  for (const n of ['fast_tab', 'fast_nav']) assert.match(tool(n).description, /wait for it to load.*preview/, `${n}: waits and returns a preview`);
  assert.match(tool('fast_wait').description, /frames included/);
});

test('toolsets choose tools only: allow (and a comment), no describe / rename overrides', () => {
  for (const f of ['toolset.json', 'toolset.phase2.json', 'toolset.phase2-eval.json', 'toolset.no-cdp.json']) {
    const raw = JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(raw).filter(k => k !== '_comment'), ['allow'], f);
  }
  for (const name of ['default', 'phase2', 'phase2-eval', 'no-cdp']) {
    const { tools } = buildTools(TOOLS, loadToolset(name));
    for (const t of tools) if (!NATIVE.includes(t.name)) assert.equal(t.description, tool(t.name).description, `${name} ${t.name}: server text`);
  }
});

test('one short system prompt for every toolset, no server instructions essay', () => {
  const sys = buildSystem();
  assert.ok(sys.length < 1000, `system prompt ${sys.length} chars`);
  assert.match(sys, /fast_batch/); assert.match(sys, /report_done/); assert.match(sys, /ask_caller/);
  assert.match(sys, /When a step fails, read the error, fix the call, and continue\./);
  assert.match(sys, /omitted counts are normal/); assert.match(sys, /truncated:true means an explicit read was cut/);
  assert.doesNotMatch(sys, /do not re-snapshot|Tool guidance from FastLink/i);
  assert.match(sys, /Today is \w+ \d{4}-\d{2}-\d{2} \(America\/Chicago\)/, 'date + timezone');
});

test('default toolset = every server tool except hidden + native', () => {
  const ts = loadToolset();
  assert.equal(ts.name, 'default');
  const { tools, back } = buildTools(TOOLS, ts);
  assert.equal(tools.length, TOOLS.length - HIDDEN_TOOLS.size + NATIVE.length);
  assert.ok(TOOLS.some(t => t.name === 'fast_ext_reload'), 'ops tool fast_ext_reload is on the server');
  assert.ok(!names(tools).includes('fast_ext_reload') && !back.has('fast_ext_reload'), 'default "*" does not offer the operator reload');
  for (const t of tools.filter(t => !NATIVE.includes(t.name))) { assert.equal(back.get(t.name), t.name); assert.equal(t.input_schema, tool(t.name).inputSchema); }
});

test('hidden tools (scorer fast_frame_read, operator fast_ext_reload) are never model-facing, even when allowed', () => {
  assert.deepEqual([...HIDDEN_TOOLS].sort(), ['fast_ext_reload', 'fast_frame_read']);
  assert.ok(!HIDDEN_TOOLS.has('fast_evaluate'), 'phase2-eval offers fast_evaluate on purpose');
  for (const name of ['default', 'phase2', 'phase2-eval', 'no-cdp']) {
    const { tools, back } = buildTools(TOOLS, loadToolset(name));
    for (const h of HIDDEN_TOOLS) { assert.ok(!names(tools).includes(h), `${name}: ${h}`); assert.equal(back.has(h), false); }
  }
  const { tools } = buildTools(TOOLS, { name: 'x', allow: ['fast_snapshot', ...HIDDEN_TOOLS] });
  assert.deepEqual(names(tools), ['fast_snapshot', ...NATIVE]);
});

test('"default" and unset and FASTRUN_TOOLSET resolve the same file', () => {
  const a = loadToolset('default'), b = loadToolset(undefined);
  process.env.FASTRUN_TOOLSET = 'phase2';
  const c = loadToolset();
  delete process.env.FASTRUN_TOOLSET;
  assert.equal(a.file, b.file);
  assert.equal(c.name, 'phase2');
});

test('phase2 = its 12 allowed tools + 2 native; phase2-eval adds fast_evaluate; no-cdp has no debugger tool', () => {
  const p2 = loadToolset('phase2');
  const t2 = buildTools(TOOLS, p2).tools;
  assert.equal(t2.length, 14);
  assert.deepEqual([...names(t2).slice(0, -2)].sort(), [...p2.allow].sort());
  assert.deepEqual(names(t2).slice(-2), NATIVE);
  const ev = loadToolset('phase2-eval');
  assert.deepEqual(ev.allow, [...p2.allow, 'fast_evaluate']);
  assert.equal(buildTools(TOOLS, ev).tools.length, 15);
  const nc = buildTools(TOOLS, loadToolset('no-cdp')).tools;
  assert.equal(nc.length, 13);
  for (const n of names(nc)) assert.ok(!CDP.includes(n), `${n} needs CDP`);
});

test('bad toolset name or shape throws before any connect', () => {
  assert.throws(() => loadToolset('nope'), /toolset "nope": cannot read/);
  const dir = mkdtempSync(join(tmpdir(), 'fastrun-ts-'));
  const file = join(dir, 'empty.json');
  writeFileSync(file, JSON.stringify({ allow: [] }));
  assert.throws(() => loadToolset(file), /"allow" must be a non-empty array/);
});
