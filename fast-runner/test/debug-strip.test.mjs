// node --test — `_debug` (fast_click phase timings, c657fda) never reaches the model; it is kept for runs.jsonl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitDebug, toolResultContent, forModel } from '../runner.mjs';

const DEBUG = { phases: { changedBeforeMs: 3, resolveMs: 12, dispatchMs: 4, confirmWaitMs: 0, settleMs: 150, serializeMs: 20, actionMs: 190, changedAfterMs: 5, totalMs: 210 }, swTotalMs: 240 };

test('a click result: _debug is removed from the text and returned for the toolLog entry', () => {
  const raw = JSON.stringify({ clicked: 'Create new', changed: 'none', _debug: DEBUG, snapshot: { items: [] } });
  const { text, debug } = splitDebug(raw);
  assert.deepEqual(debug, DEBUG);
  assert.doesNotMatch(text, /_debug|swTotalMs|resolveMs/);
  assert.deepEqual(JSON.parse(text), { clicked: 'Create new', changed: 'none', snapshot: { items: [] } });
  const seen = forModel([{ type: 'tool_result', tool_use_id: 'u', content: toolResultContent({ content: [{ type: 'text', text }] }) }])[0].content[0].text;
  assert.doesNotMatch(seen, /_debug/);
});

test('a batch: every step\'s _debug is removed and kept per step', () => {
  const raw = JSON.stringify({ summary: '2/2 steps ok', results: [
    { step: 0, name: 'fast_click', ok: true, result: { clicked: 'A', _debug: DEBUG } },
    { step: 1, name: 'fast_fill', ok: true, result: { verified: true } },
    { step: 2, name: 'fast_click', ok: true, result: { clicked: 'B', _debug: { phases: { totalMs: 99 }, swTotalMs: 101 } } },
  ] });
  const { text, debug } = splitDebug(raw);
  assert.doesNotMatch(text, /_debug/);
  assert.deepEqual(debug, { steps: [{ step: 0, name: 'fast_click', ...DEBUG }, { step: 2, name: 'fast_click', phases: { totalMs: 99 }, swTotalMs: 101 }] });
  assert.equal(JSON.parse(text).results[0].result.clicked, 'A');
});

test('no _debug, not JSON, or a page that merely mentions the word: text passes through untouched', () => {
  for (const raw of [JSON.stringify({ clicked: 'x' }), 'Error: broker down', JSON.stringify({ content: [{ text: 'the "_debug" docs page' }] })]) {
    const { text, debug } = splitDebug(raw);
    assert.equal(text, raw);
    assert.equal(debug, null);
  }
});
