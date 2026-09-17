// node --test — one model client, two endpoints: the request shaping xAI needs and the endpoint/auth choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeRequest, modelEndpoint, createMessage, ensureModel } from '../xai.mjs';

const TOOLS = [
  { name: 'read', description: 'r', input_schema: { type: 'object', properties: { full: { type: 'boolean' } } } },
  { name: 'wait', description: 'w', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'odd', description: 'o', input_schema: { type: 'string' } },
];

test('shapeRequest applies the fixups xAI needs and changes nothing else', () => {
  const body = { model: 'grok-4.6', max_tokens: 4096, system: 's', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, stop_sequences: ['x'], stop: ['y'] };
  const out = shapeRequest(body, { GROKCODE_EFFORT: 'medium' });
  assert.equal(out.stop_sequences, undefined); assert.equal(out.stop, undefined);
  assert.equal(out.reasoning_effort, 'medium');
  assert.deepEqual(out.tools[0].input_schema.required, [], 'object schema without required gets []');
  assert.deepEqual(out.tools[1].input_schema.required, ['text'], 'an existing required is kept');
  assert.deepEqual(out.tools[2], TOOLS[2], 'a non-object schema is untouched');
  assert.equal(out.model, 'grok-4.6', 'grok ids pass as is (no remap)');
  assert.deepEqual(out.messages, body.messages);
  assert.equal(body.stop_sequences[0], 'x', 'the caller\'s body is not mutated');
  assert.equal(TOOLS[0].input_schema.required, undefined);
  assert.equal(shapeRequest({ model: 'm' }, {}).reasoning_effort, undefined, 'no effort env: model default');
});

test('modelEndpoint: XAI_API_KEY means direct to api.x.ai with the key; otherwise the proxy with no real token', () => {
  assert.deepEqual(modelEndpoint({ XAI_API_KEY: 'k-123' }), { mode: 'direct', base: 'https://api.x.ai', authorization: 'Bearer k-123' });
  assert.equal(modelEndpoint({ XAI_API_KEY: 'k', XAI_BASE_URL: 'https://example.test/' }).base, 'https://example.test');
  assert.deepEqual(modelEndpoint({}), { mode: 'proxy', base: 'http://127.0.0.1:8790', authorization: 'Bearer grokcode-local' });
  assert.equal(modelEndpoint({ GROKCODE_URL: 'http://127.0.0.1:8791' }).base, 'http://127.0.0.1:8791');
});

test('createMessage sends the shaped body to the chosen endpoint with its auth (fetch stubbed)', async () => {
  const saved = { fetch: globalThis.fetch, key: process.env.XAI_API_KEY, url: process.env.XAI_BASE_URL, effort: process.env.GROKCODE_EFFORT };
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: {} }), { status: 200, headers: { 'x-metrics-ttft-ms': '100' } }); };
  try {
    process.env.XAI_API_KEY = 'k-test'; delete process.env.XAI_BASE_URL; process.env.GROKCODE_EFFORT = 'medium';
    const r = await createMessage({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, model: 'grok-4.6' });
    assert.equal(sent[0].url, 'https://api.x.ai/v1/messages');
    assert.equal(sent[0].headers.authorization, 'Bearer k-test');
    assert.equal(sent[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(sent[0].body.reasoning_effort, 'medium');
    assert.deepEqual(sent[0].body.tools[0].input_schema.required, []);
    assert.equal(r._timing.xaiTtftMs, 100);
    assert.deepEqual(await ensureModel(), { mode: 'direct', base: 'https://api.x.ai' }, 'direct mode needs no proxy');
    delete process.env.XAI_API_KEY; process.env.GROKCODE_URL = 'http://127.0.0.1:18790';
    await createMessage({ messages: [{ role: 'user', content: 'hi' }], model: 'grok-4.3' });
    assert.equal(sent[1].url, 'http://127.0.0.1:18790/v1/messages');
    assert.equal(sent[1].headers.authorization, 'Bearer grokcode-local');
  } finally {
    globalThis.fetch = saved.fetch;
    for (const [k, v] of [['XAI_API_KEY', saved.key], ['XAI_BASE_URL', saved.url], ['GROKCODE_EFFORT', saved.effort]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete process.env.GROKCODE_URL;
  }
});
