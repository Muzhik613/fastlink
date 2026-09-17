// node --test — short tool names at the runner boundary: the model reads and writes read/click/select/…,
// the server, the run store and the gate keep fast_*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromModel, forModel, toModelText, toolResultContent, refusalText, gateProblems, recordResult, entryFacts, buildTools, loadToolset, keepNewestPreview } from '../runner.mjs';
import { TOOLS } from '../../fast-dxt/server/tools.js';

test('several calls in one response: only the last result keeps its page preview; batch is not model-facing', () => {
  const { tools, back } = buildTools(TOOLS, loadToolset('default'));
  assert.ok(!tools.some(t => t.name === 'batch' || t.name === 'fast_batch') && ![...back.values()].includes('fast_batch'), 'fast_batch hidden');
  const preview = (label) => ({ url: 'https://x/', omitted: { items: 3 }, items: [{ i: 'f1:1', label }] });
  const results = [
    { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: JSON.stringify({ clicked: 'Next', changed: ['now showing "Security"'], snapshot: preview('A'), snapshotStale: false }) }] },
    { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: JSON.stringify({ found: { text: 'Security' } }) }] },
    { type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text: JSON.stringify({ clicked: 'Next', changed: ['now showing "Boot volume"'], snapshot: preview('C') }) }] },
    { type: 'tool_result', tool_use_id: 'd', is_error: true, content: [{ type: 'text', text: 'not run: fast_click failed earlier in this response' }] },
  ];
  assert.equal(keepNewestPreview(results), 1);
  assert.deepEqual(JSON.parse(results[0].content[0].text), { clicked: 'Next', changed: ['now showing "Security"'] }, 'earlier preview (and its flags) dropped, the change kept');
  assert.equal(JSON.parse(results[2].content[0].text).snapshot.items[0].label, 'C', 'the last preview stays');
  assert.equal(results[3].content[0].text, 'not run: fast_click failed earlier in this response');
  assert.equal(keepNewestPreview([results[1]]), 0);
  assert.equal(fromModel('click', { id: 'f1:1' }).name, 'fast_click');
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
