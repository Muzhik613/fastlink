// connLog.js — the extension's connection log (fb#35): relay socket drops, redials,
// stale sockets, results that could not be delivered, and calls that hit the call
// watchdog. Kept in chrome.storage.local (last MAX entries) and echoed to the console;
// shown on the options page (Connection tab).
//
// No secrets: entries hold only an event name and short scalar fields (codes, counts,
// milliseconds, action names). Never pass a URL, token, tab address or call arguments;
// strings are cut to 80 chars and anything token-shaped is redacted anyway.

export const CONN_LOG_KEY = 'fastlink.connLog';
export const MAX = 200;
const SAVE_DELAY_MS = 1_000;

let pending = [];
let timer = null;
let chain = Promise.resolve();

function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v);
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v) out[k] = v.replace(/(token=)[^&\s]+/gi, '$1***').slice(0, 80);
  }
  return out;
}

function save() {
  timer = null;
  const batch = pending;
  pending = [];
  chain = chain.then(async () => {
    try {
      const old = (await chrome.storage.local.get(CONN_LOG_KEY))[CONN_LOG_KEY];
      const list = (Array.isArray(old) ? old : []).concat(batch).slice(-MAX);
      await chrome.storage.local.set({ [CONN_LOG_KEY]: list });
    } catch {}
  });
}

// connLog('close', {code: 1006, wasClean: false}) or connLog({ev: 'call_timeout', ...}).
export function connLog(ev, fields) {
  const entry = typeof ev === 'object' && ev ? { t: Date.now(), ...clean(ev) } : { t: Date.now(), ev: String(ev), ...clean(fields) };
  try { console.info('[fastlink/conn]', JSON.stringify(entry)); } catch {}
  pending.push(entry);
  if (!timer) timer = setTimeout(save, SAVE_DELAY_MS);
}
