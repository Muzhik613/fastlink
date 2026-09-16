// node --test — short tool names at the runner boundary: the model reads and writes read/click/select/…,
// the server, the run store and the gate keep fast_*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromModel, forModel, toModelText, toolResultContent, refusalText, gateProblems, recordResult, entryFacts, buildTools, loadToolset } from '../runner.mjs';
import { runBatch } from '../../fast-dxt/server/batch.js';
import { TOOLS } from '../../fast-dxt/server/tools.js';

test('a batch the model writes with short step names runs as the canonical tools', async () => {
  const modelCall = { name: 'batch', input: { actions: [
    { name: 'fill', args: { match: 'Virtual machine name', value: 'fastlink-bench-vm' } },
    { ifFound: 'Resource group', then: [{ name: 'select', args: { field: 'Region', option: 'Japan East' } }], else: [{ name: 'click', args: { text: 'Create new' } }] },
    { name: 'key', args: { key: 'Enter' } },
  ] } };
  const { tools, back } = buildTools(TOOLS, loadToolset('phase2'));
  assert.ok(tools.some(t => t.name === 'batch') && back.get('batch') === 'fast_batch');
  const call = fromModel(modelCall.name, modelCall.input);
  assert.equal(call.name, 'fast_batch');
  assert.deepEqual(call.args.actions.map(a => a.name || 'ifFound'), ['fast_fill', 'ifFound', 'fast_key_press']);
  assert.equal(call.args.actions[1].then[0].name, 'fast_select_option');
  assert.equal(call.args.actions[1].else[0].name, 'fast_click');
  assert.equal(modelCall.input.actions[0].name, 'fill', 'the model\'s own input is not mutated');
  // and the server's batch runner executes exactly those canonical tools
  const ran = [];
  const out = await runBatch(call.args, { call: async (name, args) => {
    ran.push(name);
    if (name === 'fast_list') return { result: [{ targetTab: true, url: 'https://x/' }] };
    if (name === 'fast_evaluate') return { result: 'complete' };
    if (name === 'fast_wait') return { result: { found: { text: 'Resource group' } } };
    return { result: { ok: true, verified: true, snapshot: { items: [] } } };
  } });
  assert.deepEqual(ran.filter(n => !['fast_list', 'fast_evaluate', 'fast_wait'].includes(n)), ['fast_fill', 'fast_select_option', 'fast_key_press']);
  assert.match(out.summary, /3\/3 steps ok|steps ok/);
});

test('a result hint naming fast_select_option reaches the model as select; the run store keeps the original', () => {
  const hint = JSON.stringify({ error: 'No visible fillable element matching "Region". Nothing was filled.', hint: '"Region" is a dropdown: use fast_select_option {field:"Region"}; or fast_snapshot full:true' });
  const res = { content: [{ type: 'text', text: hint }] };
  const [block] = forModel([{ type: 'tool_result', tool_use_id: 't1', content: toolResultContent(res), is_error: true }]);
  const seen = block.content[0].text;
  assert.match(seen, /use select \{field:\\"Region\\"\}; or read full:true/);
  assert.doesNotMatch(seen, /fast_select_option|fast_snapshot/);
  // canonical in the toolLog preview (runs.jsonl), short in what the model can quote as evidence
  const run = { toolLog: [], corpus: [], urlTrail: [], gateRefusals: [] };
  const ok = recordResult(run, [toModelText(hint)], true);
  run.toolLog.push({ t: 0, name: 'fast_fill', args: { match: 'Region' }, ok, preview: hint.slice(0, 1200), ...entryFacts('fast_fill', { match: 'Region' }, hint, ok) });
  assert.match(run.toolLog[0].preview, /fast_select_option/);
  assert.equal(run.toolLog[0].name, 'fast_fill');
});

test('refusals, nudges and check notes reach the model with short names', () => {
  const run = { toolLog: [
    { t: 0, name: 'fast_tab', ok: true, args: { url: 'https://x/' } },
    { t: 1, name: 'fast_click', ok: false, args: { text: 'Create' } },
    { t: 2, name: 'fast_fill', ok: true, args: { match: 'Name', value: 'a' } },
  ], corpus: [], urlTrail: [], gateRefusals: [] };
  const problems = gateProblems(run, { result: 'x', evidence: 'nothing quoted' });
  assert.ok(problems.some(p => /fast_click/.test(p)), 'the gate itself speaks canonical names');
  const [block] = forModel([{ type: 'tool_result', tool_use_id: 'u', is_error: true, content: [{ type: 'text', text: refusalText(problems) }] }]);
  const text = block.content[0].text;
  assert.match(text, /^done refused: /);
  assert.match(text, /your last attempt to click "Create" failed/);
  assert.match(text, /no tool has read the page since your last fill; call read or text/);
  assert.match(text, /then call done again\.$/);
  assert.doesNotMatch(text, /fast_|report_done/);
  const [nudge] = forModel([{ type: 'text', text: 'You ended your turn without calling report_done or ask_caller. Continue the task, or call report_done now.' }]);
  assert.equal(nudge.text, 'You ended your turn without calling done or ask. Continue the task, or call done now.');
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fast_click' } };
  assert.deepEqual(forModel([img]), [img], 'images untouched');
});
