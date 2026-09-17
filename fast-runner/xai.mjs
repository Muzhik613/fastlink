// Anthropic-Messages client for Grok via the grokcode proxy (owns the xAI OAuth token).
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';

// Where the model is reached, all by env so a deployment points at its own proxy and login:
//   GROKCODE_URL             the grokcode proxy (default http://127.0.0.1:8790)
//   GROKCODE_DIR             where proxy.mjs lives, to start it when nothing answers (default the owner's checkout)
//   GROKCODE_HOME            HOME for a proxy this module starts: it reads and refreshes <home>/.grok/auth.json,
//                            the grok CLI's own login (`grok login`). Default: this process's HOME. No token is
//                            ever copied or passed by the runner.
//   FASTRUN_PROXY_AUTOSTART  "off" = never start a proxy (a deployment runs its own); default on
const PROXY_DIR = process.env.GROKCODE_DIR || '/home/yaakov/code/grokcode';
const BASE = process.env.GROKCODE_URL || 'http://127.0.0.1:8790';
export const MODEL = process.env.FASTRUN_MODEL || 'grok-4.6';

async function health() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Start proxy.mjs if nothing answers on :8790. Effort is fixed at proxy start (GROKCODE_EFFORT).
export async function ensureProxy() {
  const h = await health();
  if (h) return h;
  if (String(process.env.FASTRUN_PROXY_AUTOSTART || '').toLowerCase() === 'off') throw new Error(`no grokcode proxy answers on ${BASE} (FASTRUN_PROXY_AUTOSTART=off)`);
  const log = openSync(`${PROXY_DIR}/proxy.log`, 'a');
  const child = spawn(process.execPath, ['proxy.mjs'], {
    cwd: PROXY_DIR,
    env: { GROKCODE_EFFORT: 'low', ...process.env, ...(process.env.GROKCODE_HOME ? { HOME: process.env.GROKCODE_HOME } : {}) },
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    const h2 = await health();
    if (h2) return h2;
  }
  throw new Error(`grokcode proxy did not come up on ${BASE}; see ${PROXY_DIR}/proxy.log`);
}

// xAI reports its own timing on every response (passed through by the grokcode proxy): time to first
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
  const body = { model, max_tokens: maxTokens, system, messages, tools };
  const payload = JSON.stringify(body);
  const t0 = Date.now();
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          authorization: 'Bearer grokcode-local', // real token injected by the proxy
        },
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
