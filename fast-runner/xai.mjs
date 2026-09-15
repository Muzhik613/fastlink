// Anthropic-Messages client for Grok via the grokcode proxy (owns the xAI OAuth token).
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';

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
  const log = openSync(`${PROXY_DIR}/proxy.log`, 'a');
  const child = spawn(process.execPath, ['proxy.mjs'], {
    cwd: PROXY_DIR,
    env: { GROKCODE_EFFORT: 'low', ...process.env },
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

// One non-streaming turn. Returns the Messages response body ({content, stop_reason, usage})
// plus `_timing` = {latencyMs (whole call incl. retries), attempts, requestChars} for the run log.
export async function createMessage({ system, messages, tools, maxTokens = 4096, signal }) {
  const body = { model: MODEL, max_tokens: maxTokens, system, messages, tools };
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
      out._timing = { latencyMs: Date.now() - t0, attempts: attempt + 1, requestChars: payload.length };
      return out;
    }
    lastErr = new Error(`xai ${res.status}: ${text.slice(0, 500)}`);
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    throw lastErr;
  }
  throw lastErr;
}
