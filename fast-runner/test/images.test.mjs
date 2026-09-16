// node --test — screenshots in Grok's context: only `look` makes one, and only the newest stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepNewestImage, DROPPED_IMAGE, buildTools, loadToolset } from '../runner.mjs';
import { TOOLS } from '../../fast-dxt/server/tools.js';

const img = (n) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `IMG${n}`.padEnd(64, 'x') } });
const turn = (id, blocks) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: blocks }] });

test('only the newest image stays; older ones become a short stub, text around them is kept', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'TASK: x' }] },
    turn('a', [{ type: 'text', text: '{"url":"u1"}' }, img(1)]),
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    turn('b', [{ type: 'text', text: '{"url":"u2"}' }]),
    turn('c', [img(2), { type: 'text', text: 'after' }]),
  ];
  assert.equal(keepNewestImage(messages), 1);
  assert.deepEqual(messages[1].content[0].content, [{ type: 'text', text: '{"url":"u1"}' }, { type: 'text', text: DROPPED_IMAGE }]);
  assert.equal(messages[4].content[0].content[0].source.data.slice(0, 4), 'IMG2', 'newest kept');
  messages.push(turn('d', [img(3)]));
  assert.equal(keepNewestImage(messages), 1);
  assert.equal(messages[4].content[0].content[0].text, DROPPED_IMAGE);
  assert.equal(keepNewestImage(messages), 0, 'idempotent');
  assert.equal(JSON.stringify(messages).match(/"type":"image"/g).length, 1);
});

test('read cannot ask for a screenshot or overlay; look is the image tool, described in one line', () => {
  for (const name of ['default', 'phase2']) {
    const { tools } = buildTools(TOOLS, loadToolset(name));
    const read = tools.find(t => t.name === 'read');
    for (const k of ['screenshot', 'screenshotFormat', 'overlay']) assert.ok(!(k in read.input_schema.properties), `${name}: read.${k} hidden`);
    assert.ok('full' in read.input_schema.properties && 'frame' in read.input_schema.properties);
  }
  const look = buildTools(TOOLS, loadToolset('default')).tools.find(t => t.name === 'look');
  assert.ok(look && !look.description.includes('\n') && look.description.split(/(?<=\.)\s/).length === 1, look?.description);
  assert.match(look.description, /only for what read cannot show/);
  assert.ok(TOOLS.find(t => t.name === 'fast_snapshot').inputSchema.properties.screenshot, 'server keeps it');
});
