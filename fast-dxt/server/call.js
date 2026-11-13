// call.js — FastLink calls from plain Node scripts (no MCP client needed).
//
//   const { connect } = await import('<fastlink>/fast-dxt/server/call.js');
//   const fl = await connect({ browser: 'mac2', client: 'costar-sweep' });
//   const r = await fl.call('fast_evaluate', { tabId: 123, fn: '() => location.href' }, { timeoutMs: 40000 });
//   // r = { result, browser } on success, { error, ...extras, browser } on failure
//   // a call that takes longer than its time limit throws Error('timeout <action>')
//
// Uses this machine's pairing (~/.fastlink/agent.json, made once with
// `node index.js pair <CODE>`) and the same relay client as the helper, so a
// script needs no token or broker of its own. `browser` is sent on every call
// (a script should always name its browser); `tabId` pins each call to one tab,
// so other sessions using the same browser can't move it.
//
// Secure browsers (fast-ext/secure-only/): when this machine holds a lock code for
// `browser` (node index.js lock <browser>), every browser call is SEALED automatically:
// sent as `fast_sealed` ciphertext, the reply decrypted here. Callers see the same
// { result, browser } / { error, browser } shapes either way.
import { loadAgent } from './agentFile.js';
import { loadLockCode, SEALED_JS } from './lockFile.js';
import { createRelayClient } from './relayClient.js';
import { CLIENT_NAME, HELPER_VERSION } from './helper.js';

// Answered by the relay itself, never by the browser: not sealed.
const RELAY_NATIVE = new Set(['fast_status', 'fast_feedback']);
// The relay gives up on a browser call after about 30 s; a sealed request is never run later.
const RELAY_CALL_CAP_MS = 30_000;

let sealedMod = null;
const sealedLib = async () => (sealedMod ??= await import(SEALED_JS));

// The same shapes the relay gives unsealed calls (mcp.js): a reply's tabId rides into an
// object result, and a screenshot's dataUrl becomes an MCP image.
function shapeResult(result, tabId) {
  let r = result;
  const images = [];
  const toImage = (dataUrl) => {
    const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(String(dataUrl || ''));
    if (m) images.push({ type: 'image', data: m[2], mimeType: m[1] });
    return !!m;
  };
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    if (r.dataUrl && toImage(r.dataUrl)) { const { dataUrl, ...rest } = r; r = rest; }
    else if (r.screenshot?.dataUrl && toImage(r.screenshot.dataUrl)) { const { dataUrl, ...shot } = r.screenshot; r = { ...r, screenshot: shot }; }
    if (typeof tabId === 'number' && r.tabId === undefined) r = { ...r, tabId };
  }
  return { result: r, ...(images.length ? { images } : {}) };
}

// The time limit per call unless the call sets its own (the old broker scripts' default).
export const DEFAULT_TIMEOUT_MS = 25000;

function withTimeout(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout ${label}`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export async function connect({ browser = null, client = 'script', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const agent = loadAgent();
  if (!agent) throw new Error('FastLink is not paired on this machine: run node <fastlink>/fast-dxt/server/index.js pair <CODE> (code from https://relay.ytx.app/pair/new)');
  const relay = createRelayClient(agent);
  await withTimeout(relay.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: `${HELPER_VERSION} (${client})` },
  }), timeoutMs, 'initialize');

  // Secure browsers: keys per browser this machine holds a lock code for (null = normal).
  const keyCache = new Map();
  async function keysFor(name) {
    if (!name) return null;
    if (!keyCache.has(name)) {
      const code = loadLockCode(name);
      keyCache.set(name, code ? await (await sealedLib()).deriveKeys(code) : null);
    }
    return keyCache.get(name);
  }
  let lastSeq = 0;
  // Seconds × 2^20 + 20 random bits: unique across processes in practice, increasing within
  // this one (the browser keeps a window of recent numbers, so order doesn't matter).
  const nextSeq = () => (lastSeq = Math.max(lastSeq + 1, Math.floor(Date.now() / 1000) * 2 ** 20 + Math.floor(Math.random() * 2 ** 20)));

  async function send(name, args, ms) {
    const r = await withTimeout(relay.request('tools/call', { name, arguments: args }), ms, name);
    const content = Array.isArray(r?.content) ? r.content : [];
    let body = content.find((c) => c.type === 'text')?.text ?? null;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* plain text */ } }
    return { r, body, content, served: r?._meta?.['fastlink/browser'] ?? null };
  }

  // A sealed call. A relay timeout means the outcome is unknown; the browser refuses the
  // request after its deadline, so a retry can't make it run twice later.
  async function sealedCall(name, args, ms, target, keys) {
    const { browser: _routing, ...inner } = args;
    const seq = nextSeq();
    const ts = Date.now();
    const sealed = await sealedLib();
    const frame = await sealed.seal(keys, 'req', { seq, ts, deadline: ts + Math.min(ms, RELAY_CALL_CAP_MS), action: name, args: inner });
    const { body, served } = await send('fast_sealed', { ...frame, browser: target }, ms);
    // In clear the relay may only report an error (offline, timeout, refused). Anything else
    // unsealed is refused: a result must come from the browser, sealed.
    if (!body || typeof body !== 'object' || !body.sealed) {
      const error = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : 'the relay sent an unsealed reply to a sealed call';
      // An error in clear keeps only its short code and hint (e.g. call_timeout from the
      // browser's call watchdog): text, never page content.
      const extra = {};
      if (typeof body?.error === 'string') for (const k of ['code', 'phase', 'hint']) if (typeof body[k] === 'string') extra[k] = body[k].slice(0, 400);
      return { error, ...extra, browser: served };
    }
    let reply;
    try { reply = await sealed.unseal(keys, 'res', body.sealed, seq); } catch (e) { return { error: e.message, browser: served }; }
    if (reply && typeof reply === 'object' && 'error' in reply) return { ...reply, browser: served };
    // fast_evaluate returns the function's value as is (no tabId merged into an object).
    return { ...shapeResult(reply?.result ?? null, name === 'fast_evaluate' ? undefined : reply?.tabId), browser: served };
  }

  async function call(name, args = {}, { timeoutMs: ms = timeoutMs } = {}) {
    const target = args.browser ?? browser;
    const keys = RELAY_NATIVE.has(name) ? null : await keysFor(target);
    if (keys) return sealedCall(name, args, ms, target, keys);
    const a = browser && args.browser == null ? { ...args, browser } : args;
    const { r, body, content, served } = await send(name, a, ms);
    const images = content.filter((c) => c.type === 'image');
    const isObj = body && typeof body === 'object' && !Array.isArray(body);
    if (r?.isError || (isObj && 'error' in body)) return { ...(isObj ? body : { error: String(body) }), browser: served };
    return { result: body, ...(images.length ? { images } : {}), browser: served };
  }

  return { call, sealed: !!(await keysFor(browser)) };
}
