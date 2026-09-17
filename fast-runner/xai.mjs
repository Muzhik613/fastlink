// Anthropic-Messages client for Grok: xAI's Anthropic-compatible POST /v1/messages, one client, reached one of
// two ways, chosen by env on every call:
//   direct  XAI_API_KEY set: XAI_BASE_URL (default https://api.x.ai), Authorization: Bearer <key>.
//           No proxy (a container holds the key as a secret).
//   proxy   no key: GROKCODE_URL (default http://127.0.0.1:8790), a grokcode proxy, which injects its own grok
//           login token. The bearer sent to it is GROKCODE_TOKEN when set (e.g. a gate in front of a shared proxy,
//           which checks and strips it), else a placeholder the local proxy ignores.
// Proxy mode only, for a proxy this module starts when nothing answers:
//   GROKCODE_DIR             where proxy.mjs lives (default the owner's checkout)
//   GROKCODE_HOME            HOME the started proxy reads its login from (default this process's HOME)
//   FASTRUN_PROXY_AUTOSTART  "off" = never start one
// Both modes: GROKCODE_EFFORT = reasoning_effort sent with every request (low|medium|high|xhigh; unset = model
// default, which is xhigh for grok-4.6).
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';

export const MODEL = process.env.FASTRUN_MODEL || 'grok-4.6';
const PROXY_DIR = process.env.GROKCODE_DIR || '/home/yaakov/code/grokcode';

export function modelEndpoint(env = process.env) {
  if (env.XAI_API_KEY) return { mode: 'direct', base: (env.XAI_BASE_URL || 'https://api.x.ai').replace(/\/+$/, ''), authorization: `Bearer ${env.XAI_API_KEY}` };
  return { mode: 'proxy', base: (env.GROKCODE_URL || 'http://127.0.0.1:8790').replace(/\/+$/, ''), authorization: `Bearer ${env.GROKCODE_TOKEN || 'grokcode-local'}` };
}

// The request fixups xAI needs, as grokcode's proxy.mjs applies them; done here so the direct path is
// identical to the proxy path (the proxy re-applying them is a no-op). Of proxy.mjs's other behaviours none
// applies to this client: model remap (it maps claude-* ids; we send grok ids), system-role folding (we send
// only user/assistant), count_tokens stubbing (never called), SSE keepalive and block reindexing (we never stream).
export function shapeRequest(body, env = process.env) {
  const out = { ...body };
  delete out.stop_sequences;                 // grok-4.6 rejects stop / stop_sequences with a 400
  delete out.stop;
  if (env.GROKCODE_EFFORT) out.reasoning_effort = env.GROKCODE_EFFORT;   // xAI ignores thinking:{disabled}; this is the lever
  if (Array.isArray(out.tools)) {            // xAI rejects a tool whose object input_schema has no required array
    out.tools = out.tools.map((t) => {
      const sch = t?.input_schema;
      return sch && sch.type === 'object' && !Array.isArray(sch.required) ? { ...t, input_schema: { ...sch, required: [] } } : t;
    });
  }
  return out;
}

async function health({ base, authorization }) {
  try {
    const r = await fetch(`${base}/health`, { headers: { authorization }, signal: AbortSignal.timeout(5000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Make sure the model is reachable before a run connects anything: direct mode needs nothing; proxy mode
// starts proxy.mjs if nothing answers (unless FASTRUN_PROXY_AUTOSTART=off).
export async function ensureModel(env = process.env) {
  const ep = modelEndpoint(env);
  if (ep.mode === 'direct') return { mode: 'direct', base: ep.base };
  const h = await health(ep);
  if (h) return h;
  if (String(env.FASTRUN_PROXY_AUTOSTART || '').toLowerCase() === 'off') throw new Error(`no grokcode proxy answers on ${ep.base} (FASTRUN_PROXY_AUTOSTART=off; or set XAI_API_KEY to call xAI directly)`);
  const log = openSync(`${PROXY_DIR}/proxy.log`, 'a');
  const child = spawn(process.execPath, ['proxy.mjs'], {
    cwd: PROXY_DIR,
    env: { GROKCODE_EFFORT: 'low', ...env, ...(env.GROKCODE_HOME ? { HOME: env.GROKCODE_HOME } : {}) },
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    const h2 = await health(ep);
    if (h2) return h2;
  }
  throw new Error(`grokcode proxy did not come up on ${ep.base}; see ${PROXY_DIR}/proxy.log`);
}

// xAI reports its own timing on every response (passed through by the grokcode proxy in proxy mode): time to first
// token, end-to-end generation time, mean inter-token latency, and a request id. latencyMs minus e2e is
// time spent before xAI started generating (queue, proxy, network); a long TTFT with few output tokens
// is a queue stall, not reasoning (output_tokens already counts hidden reasoning tokens).
export function upstreamTiming(headers) {
  const num = (k) => { const v = Number(headers?.get?.(k)); return Number.isFinite(v) && headers.get(k) !== null ? Math.round(v) : null; };
  const u = { xaiTtftMs: num('x-metrics-ttft-ms'), xaiE2eMs: num('x-metrics-e2e-ms'), xaiItlMs: num('x-metrics-mean-itl-ms'), xaiRequestId: headers?.get?.('x-request-id') || null };
  return Object.fromEntries(Object.entries(u).filter(([, v]) => v !== null));
}

// One non-streaming turn. Returns the Messages response body ({content, stop_reason, usage})
// plus `_timing` = {latencyMs (whole call incl. retries), attempts, requestChars} for the run log.
// `model` overrides the run's driver model for ONE call — the visual note's checker
// is a different model on purpose, and the proxy passes any `grok*` id straight
// through (mapModel only rewrites claude-* ids), so grok-4.6 reaches api.x.ai as
// grok-4.6 even when the run itself is driving on grok-4.3.
export async function createMessage({ system, messages, tools, maxTokens = 4096, signal, model = MODEL }) {
  const ep = modelEndpoint();
  const payload = JSON.stringify(shapeRequest({ model, max_tokens: maxTokens, system, messages, tools }));
  const t0 = Date.now();
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(`${ep.base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: ep.authorization },
        body: payload,
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e; await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue;
    }
    const text = await res.text();
    if (res.ok) {
      const out = JSON.parse(text);
      out._timing = { latencyMs: Date.now() - t0, attempts: attempt + 1, requestChars: payload.length, ...upstreamTiming(res.headers) };
      return out;
    }
    lastErr = new Error(`xai ${res.status}: ${text.slice(0, 500)}`);
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    throw lastErr;
  }
  throw lastErr;
}
