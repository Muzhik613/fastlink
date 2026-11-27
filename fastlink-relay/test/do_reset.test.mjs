// A Durable Object reset mid-call (deploy, runtime restart, tail attach) must not surface
// as a bare Cloudflare 1101: read-only calls are sent once more, others say "restarted".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardMcp, mcpRetrySafe } from '../src/index.js';

const reset = () => Object.assign(new Error('Durable Object reset because its code was updated.'), { retryable: true });
const req = (msg) => new Request('https://relay.test/__mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) });
const call = (name, args = {}) => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });

function env(fresh) { return { USER_RELAY: { idFromName: (n) => n, get: () => fresh } }; }
const okStub = (seen) => ({ fetch: async (r) => { seen.push(await r.text()); return new Response('{"ok":1}'); } });
const throwing = (err) => ({ fetch: async () => { throw err; } });

test('a read-only call is retried once on a fresh stub with the same body', async () => {
  const seen = [];
  const msg = call('fast_watch_read', { watchId: 'abcdefgh', after: 3 });
  const res = await forwardMcp(env(okStub(seen)), 'u', throwing(reset()), req(msg));
  assert.equal(await res.text(), '{"ok":1}');
  assert.deepEqual(JSON.parse(seen[0]), msg);
});

test('an action is not repeated: it answers a readable tool error', async () => {
  const seen = [];
  const res = await forwardMcp(env(okStub(seen)), 'u', throwing(reset()), req(call('fast_click', { text: 'Send' })));
  const body = await res.json();
  assert.equal(seen.length, 0);
  assert.equal(body.id, 7);
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /restarted/);
});

test('a second reset and a non-retryable throw still answer JSON, never throw', async () => {
  const b1 = await (await forwardMcp(env(throwing(reset())), 'u', throwing(reset()), req(call('fast_status')))).json();
  assert.match(b1.result.content[0].text, /twice/);
  const b2 = await (await forwardMcp(env(null), 'u', throwing(new Error('boom')), req({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).json();
  assert.equal(b2.error.data.relayRestarted, true);
});

test('retry-safe set', () => {
  assert.equal(mcpRetrySafe(call('fast_snapshot')), true);
  assert.equal(mcpRetrySafe(call('fast_nav')), false);
  assert.equal(mcpRetrySafe({ jsonrpc: '2.0', id: 1, method: 'initialize' }), true);
  assert.equal(mcpRetrySafe([call('fast_text')]), false);
});
