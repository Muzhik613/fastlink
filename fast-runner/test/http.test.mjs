// node --test — the HTTP entry (http.mjs) against a stubbed core: routes, auth, bodies, and that it is
// the same dispatch caller-mcp.mjs uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHttpServer } from '../http.mjs';

const TOKEN = 't0k3n';
async function withServer(fn) {
  const calls = [];
  const dispatch = async (op, args) => {
    calls.push({ op, args });
    if (op === 'run') return args.task ? { status: 'question', run_id: 'ab12cd34', question: 'Which region?', so_far: { tools: 3 } } : { status: 'error', error: 'task required' };
    if (op === 'answer') return { status: 'done', run_id: args.run_id, result: 'ok', evidence: '"ok" (https://x/)' };
    if (op === 'status') return args.run_id === 'ab12cd34' ? { status: 'running', run_id: 'ab12cd34', so_far: {} } : { status: 'error', run_id: args.run_id, error: 'unknown run_id' };
    if (op === 'cancel') return { status: 'cancelled', run_id: args.run_id };
    return { status: 'error', error: `unknown operation ${op}` };
  };
  const server = createHttpServer({ dispatch, token: TOKEN });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, path, body, { auth = true, raw } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), 'content-type': 'application/json' }, ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {}) });
    return { code: res.status, body: await res.json() };
  };
  try { await fn(req, calls); } finally { server.close(); }
}

test('POST /run passes the body to dispatch("run") and returns its result as is', () => withServer(async (req, calls) => {
  const r = await req('POST', '/run', { task: 'Open example.com', toolset: 'phase2', hold_ms: 1000 });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { status: 'question', run_id: 'ab12cd34', question: 'Which region?', so_far: { tools: 3 } });
  assert.deepEqual(calls, [{ op: 'run', args: { task: 'Open example.com', toolset: 'phase2', hold_ms: 1000 } }]);
  const e = await req('POST', '/run', {});
  assert.equal(e.code, 200); assert.equal(e.body.status, 'error', 'a core error is a result, not an HTTP error');
}));

test('POST /answer, POST /cancel, GET /status/:run_id', () => withServer(async (req, calls) => {
  assert.deepEqual((await req('POST', '/answer', { run_id: 'ab12cd34', answer: 'Japan East' })).body, { status: 'done', run_id: 'ab12cd34', result: 'ok', evidence: '"ok" (https://x/)' });
  assert.deepEqual((await req('GET', '/status/ab12cd34')).body, { status: 'running', run_id: 'ab12cd34', so_far: {} });
  assert.equal((await req('GET', '/status/nope')).body.error, 'unknown run_id');
  assert.deepEqual((await req('POST', '/cancel', { run_id: 'ab12cd34' })).body, { status: 'cancelled', run_id: 'ab12cd34' });
  assert.deepEqual(calls.map((c) => c.op), ['answer', 'status', 'status', 'cancel']);
}));

test('auth: every route but /health needs the bearer token; errors are 400/404/405/413', () => withServer(async (req, calls) => {
  assert.deepEqual(await req('GET', '/health', undefined, { auth: false }), { code: 200, body: { ok: true } });
  for (const [m, p] of [['POST', '/run'], ['POST', '/answer'], ['POST', '/cancel'], ['GET', '/status/ab12cd34']]) {
    assert.equal((await req(m, p, m === 'POST' ? { task: 'x' } : undefined, { auth: false })).code, 401, `${m} ${p}`);
  }
  assert.equal(calls.length, 0, 'nothing reached the core without auth');
  assert.equal((await req('POST', '/run', undefined, { raw: 'not json' })).code, 400);
  assert.equal((await req('POST', '/run', undefined, { raw: '[1,2]' })).code, 400);
  assert.equal((await req('GET', '/run')).code, 405);
  assert.equal((await req('POST', '/status/ab12cd34', {})).code, 405);
  assert.equal((await req('GET', '/nope')).code, 404);
  assert.equal((await req('POST', '/run', undefined, { raw: JSON.stringify({ task: 'x'.repeat(1 << 21) }) })).code, 413);
}));

test('no token, no server', () => {
  assert.throws(() => createHttpServer({ dispatch: async () => ({}), token: '' }), /FASTRUN_HTTP_TOKEN is required/);
});

test('one core: caller-mcp and http both go through runner.mjs dispatch, and neither calls runTask itself', () => {
  for (const f of ['../caller-mcp.mjs', '../http.mjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /dispatch/, f);
    assert.doesNotMatch(src, /runTask\(|answer\(a\.|status\(a\./, `${f} has no own copy of the run logic`);
  }
});

test('the real dispatch: unknown ops and run ids are results, never throws; a run without a task is refused before any connect', async () => {
  const { dispatch } = await import('../runner.mjs');
  assert.deepEqual(await dispatch('nope', {}), { status: 'error', error: 'unknown operation nope' });
  assert.deepEqual(await dispatch('status', { run_id: 'zzzz' }), { status: 'error', run_id: 'zzzz', error: 'unknown run_id' });
  assert.equal((await dispatch('answer', { run_id: 'zzzz', answer: 'x' })).error, 'unknown run_id');
  assert.equal((await dispatch('cancel', { run_id: 'zzzz' })).error, 'unknown run_id');
  assert.deepEqual(await dispatch('run', {}), { status: 'error', error: 'task required' });
});
