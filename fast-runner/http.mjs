#!/usr/bin/env node
// HTTP entry for fast-runner: a caller that is not an MCP client (frontdesk's Durable Object calling into a
// per-user browser container) dispatches Grok runs over plain JSON. It is a thin shell over runner.mjs
// `dispatch` — the same core caller-mcp.mjs uses — so both entries run, hold, answer and report identically.
//
//   POST /run            {task, toolset?, gate?, transport?, browser?, hold_ms?}  → dispatch('run')
//   POST /answer         {run_id, answer, hold_ms?}                               → dispatch('answer')
//   POST /cancel         {run_id}                                                 → dispatch('cancel')
//   GET  /status/:run_id                                                          → dispatch('status')
//   GET  /health         (no auth)                                                → {ok:true}
//
// Every route but /health needs `Authorization: Bearer <FASTRUN_HTTP_TOKEN>`. A dispatch result is always
// HTTP 200 with the run's JSON (including {status:"error", error}); HTTP errors are only 401 (auth),
// 400 (body not a JSON object), 404 (route), 405 (method), 413 (body over 1 MB).
// Env: FASTRUN_HTTP_TOKEN (required), FASTRUN_HTTP_PORT (default 8799), FASTRUN_HTTP_HOST (default 127.0.0.1).
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const MAX_BODY = 1 << 20;
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

function authorized(req, token) {
  const got = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });   // an oversized body is drained, then refused
    req.on('end', () => {
      if (size > MAX_BODY) return resolve({ tooLarge: true });
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); resolve(v && typeof v === 'object' && !Array.isArray(v) ? { body: v } : { bad: true }); }
      catch { resolve({ bad: true }); }
    });
    req.on('error', () => resolve({ bad: true }));
  });
}

/** The server, with its core injected (tests pass a stub). `dispatch(op, args)` resolves a JSON result. */
export function createHttpServer({ dispatch, token }) {
  if (!token) throw new Error('FASTRUN_HTTP_TOKEN is required');
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/health') return req.method === 'GET' ? json(res, 200, { ok: true }) : json(res, 405, { error: 'method not allowed' });
    const post = { '/run': 'run', '/answer': 'answer', '/cancel': 'cancel' }[path];
    const statusId = path.startsWith('/status/') ? decodeURIComponent(path.slice('/status/'.length)) : null;
    if (!post && !statusId) return json(res, 404, { error: 'not found' });
    if (!authorized(req, token)) return json(res, 401, { error: 'unauthorized' });
    if (statusId) return req.method === 'GET' ? json(res, 200, await dispatch('status', { run_id: statusId })) : json(res, 405, { error: 'method not allowed' });
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const { body, bad, tooLarge } = await readJson(req);
    if (tooLarge) return json(res, 413, { error: 'body over 1 MB' });
    if (bad) return json(res, 400, { error: 'body must be a JSON object' });
    return json(res, 200, await dispatch(post, body));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { dispatch, cancelAll } = await import('./runner.mjs');
  const port = Number(process.env.FASTRUN_HTTP_PORT || 8799);
  const host = process.env.FASTRUN_HTTP_HOST || '127.0.0.1';
  let server;
  try { server = createHttpServer({ dispatch, token: process.env.FASTRUN_HTTP_TOKEN }); }
  catch (e) { console.error(`fast-runner http: ${e.message}`); process.exit(2); }
  server.listen(port, host, () => console.error(`fast-runner http on ${host}:${port}`));
  // Stopped (container shutdown): end every run through finish() so rows and recordings are written.
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { server.close(); cancelAll(`http server stopped by ${sig}`).finally(() => process.exit(0)); });
}
