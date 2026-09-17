// node --test fast-runner/test/  — toolset selection and the ONE concise description set, no browser, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadToolset, buildTools, buildSystem, HIDDEN_TOOLS, SHORT_NAMES, shortName, canonicalName, toModelText, MODEL_SCHEMA, fromModel } from '../runner.mjs';
import { TOOLS } from '../../fast-dxt/server/tools.js';
import { TOOLS as RELAY_TOOLS } from '../../fastlink-relay/tools.js';

// Tools that attach chrome.debugger (fast-ext/src/actions/input.js tier + its importers).
const CDP = ['fast_click_xy', 'fast_type', 'fast_evaluate', 'fast_screenshot'];
const NATIVE = ['ask', 'done'];   // ask_caller / report_done as the model sees them
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
  assert.match(tool('fast_batch').description, /Chain steps you already know in one call/);
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
    for (const t of tools) if (!NATIVE.includes(t.name)) assert.equal(t.description, toModelText(MODEL_SCHEMA[canonicalName(t.name)]?.description || tool(canonicalName(t.name)).description), `${name} ${t.name}: server text (or the aim filter's), short names`);
  }
});

test('one short system prompt for every toolset, no server instructions essay', () => {
  const sys = buildSystem();
  assert.ok(sys.length < 1000, `system prompt ${sys.length} chars`);
  assert.match(sys, /several tool calls in one response: they run in order, stop at the first failure, and only the last returns a page preview/); assert.match(sys, /\bdone\b/); assert.match(sys, /\bask\b/);
  assert.doesNotMatch(sys, /fast_batch|fast_fill|report_done|ask_caller/, 'short names only');
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
  for (const t of tools.filter(t => !NATIVE.includes(t.name))) { assert.equal(back.get(t.name), canonicalName(t.name)); assert.equal(t.name, shortName(canonicalName(t.name))); }
});

test('hidden tools (scorer fast_frame_read, operator fast_ext_reload, fast_batch) are never model-facing, even when allowed', () => {
  assert.deepEqual([...HIDDEN_TOOLS].sort(), ['fast_batch', 'fast_ext_reload', 'fast_frame_read']);
  assert.ok(!HIDDEN_TOOLS.has('fast_evaluate'), 'phase2-eval offers fast_evaluate on purpose');
  for (const name of ['default', 'phase2', 'phase2-eval', 'no-cdp']) {
    const { tools, back } = buildTools(TOOLS, loadToolset(name));
    for (const h of HIDDEN_TOOLS) { assert.ok(!names(tools).map(canonicalName).includes(h), `${name}: ${h}`); assert.equal([...back.values()].includes(h), false); }
  }
  const { tools } = buildTools(TOOLS, { name: 'x', allow: ['fast_snapshot', ...HIDDEN_TOOLS] });
  assert.deepEqual(names(tools), ['read', ...NATIVE]);
});

test('short tool names: the model sees them in the list, descriptions, params and prompt; the server keeps fast_*', () => {
  assert.deepEqual(SHORT_NAMES, {
    fast_snapshot: 'read', fast_text: 'text', fast_click: 'click', fast_click_xy: 'click_at', fast_fill: 'fill',
    fast_select_option: 'select', fast_type: 'type', fast_key_press: 'key', fast_scroll: 'scroll', fast_wait: 'wait',
    fast_tab: 'open', fast_nav: 'go', fast_screenshot: 'look', report_done: 'done', ask_caller: 'ask',
  });
  const { tools, back } = buildTools(TOOLS, loadToolset('phase2'));
  assert.deepEqual(names(tools), ['read', 'click', 'fill', 'open', 'go', 'wait', 'text', 'select', 'key', 'scroll', 'click_at', 'ask', 'done']);
  const blob = JSON.stringify(tools);
  for (const long of Object.keys(SHORT_NAMES)) assert.ok(!blob.includes(long), `no ${long} anywhere the model reads`);
  assert.equal(back.get('select'), 'fast_select_option');
  assert.ok(TOOLS.every(t => t.name.startsWith('fast_')), 'MCP server names unchanged');
  assert.equal(toModelText('use fast_select_option; fast_click_xy then fast_type; fast_evaluate stays'), 'use select; click_at then type; fast_evaluate stays');
});

test('aim only by id or text: the model-facing click takes id, text, frame; fill and select lose their extra knobs; the server keeps them', () => {
  for (const name of ['default', 'phase2', 'no-cdp']) {
    const { tools } = buildTools(TOOLS, loadToolset(name));
    const m = (n) => tools.find(t => t.name === n);
    assert.deepEqual(Object.keys(m('click').input_schema.properties).sort(), ['frame', 'id', 'text'], `${name}: click`);
    for (const n of ['fill', 'select']) for (const k of ['index', 'section', 'near', 'role', 'tag', 'selector']) assert.ok(!(k in m(n).input_schema.properties), `${name}: ${n}.${k} hidden`);
    assert.ok(m('fill').input_schema.properties.fields && m('select').input_schema.properties.selections);
    const text = JSON.stringify([m('click'), m('fill'), m('select')]);
    assert.doesNotMatch(text, /`role`|`tag`|`index`|`section`|\bindex\b|\bsection\b/, `${name}: no text names a hidden knob`);
    assert.match(m('click').description, /`id`.*f7:42.*`text`/);
  }
  for (const k of ['role', 'tag', 'index']) assert.ok(tool('fast_click').inputSchema.properties[k], `server fast_click still takes ${k}`);
  for (const k of ['index', 'section']) assert.ok(tool('fast_fill').inputSchema.properties[k] && tool('fast_select_option').inputSchema.properties[k], `server keeps ${k}`);
  // a hidden knob the model still sends is passed on unchanged: the server's own refusal answers it
  assert.deepEqual(fromModel('click', { role: 'button', tag: 'button', index: 0 }), { name: 'fast_click', args: { role: 'button', tag: 'button', index: 0 } });
});

test('the model-facing wait cannot be empty: text is required and the other knobs are hidden (dd2cf71c, 5f8343a0)', () => {
  for (const name of ['default', 'phase2', 'no-cdp']) {
    const w = buildTools(TOOLS, loadToolset(name)).tools.find(t => t.name === 'wait');
    assert.deepEqual(Object.keys(w.input_schema.properties).sort(), ['frame', 'text', 'timeoutMs'], `${name}: wait params`);
    assert.deepEqual(w.input_schema.required, ['text'], `${name}: text required`);
    assert.match(w.description, /`text` \(required\)/);
    assert.doesNotMatch(w.description, /selector|networkIdle/);
    // the two empty waits the model actually sent both miss a required property
    for (const sent of [{ timeoutMs: 10000 }, { timeoutMs: 2000 }, { timeoutMs: 8000, networkIdle: true }]) {
      assert.ok(w.input_schema.required.some(k => !(k in sent)), `${JSON.stringify(sent)} violates the schema`);
    }
  }
  for (const k of ['selector', 'networkIdle', 'idleMs', 'noSnapshot']) assert.ok(tool('fast_wait').inputSchema.properties[k], `server keeps ${k}`);
});

test('"default" and unset and FASTRUN_TOOLSET resolve the same file', () => {
  const a = loadToolset('default'), b = loadToolset(undefined);
  process.env.FASTRUN_TOOLSET = 'phase2';
  const c = loadToolset();
  delete process.env.FASTRUN_TOOLSET;
  assert.equal(a.file, b.file);
  assert.equal(c.name, 'phase2');
});

test('phase2 = its 11 allowed tools + 2 native; phase2-eval adds fast_evaluate; no-cdp has no debugger tool', () => {
  const p2 = loadToolset('phase2');
  const t2 = buildTools(TOOLS, p2).tools;
  assert.equal(t2.length, 13);
  assert.deepEqual([...names(t2).slice(0, -2)].map(canonicalName).sort(), [...p2.allow].sort());
  assert.deepEqual(names(t2).slice(-2), NATIVE);
  const ev = loadToolset('phase2-eval');
  assert.deepEqual(ev.allow, [...p2.allow, 'fast_evaluate']);
  assert.equal(buildTools(TOOLS, ev).tools.length, 14);
  const nc = buildTools(TOOLS, loadToolset('no-cdp')).tools;
  assert.equal(nc.length, 12);
  for (const n of names(nc)) assert.ok(!CDP.includes(canonicalName(n)), `${n} needs CDP`);
});

test('bad toolset name or shape throws before any connect', () => {
  assert.throws(() => loadToolset('nope'), /toolset "nope": cannot read/);
  const dir = mkdtempSync(join(tmpdir(), 'fastrun-ts-'));
  const file = join(dir, 'empty.json');
  writeFileSync(file, JSON.stringify({ allow: [] }));
  assert.throws(() => loadToolset(file), /"allow" must be a non-empty array/);
});
