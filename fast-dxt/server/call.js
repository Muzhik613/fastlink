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
// Secure browsers (fast-ext/src/secure/): when this machine holds a lock code for
// `browser` (node index.js lock <browser>), every browser call is SEALED automatically:
// sent as `fast_sealed` ciphertext, the reply decrypted here. Callers see the same
// { result, browser } / { error, browser } shapes either way.
import { loadAgent } from './agentFile.js';
import { loadLockCode, SEALED_JS } from './lockFile.js';
import { createRelayClient } from './relayClient.js';
import { CLIENT_NAME, HELPER_VERSION } from './helper.js';

// Answered by the relay itself, never by the browser: not sealed.
const RELAY_NATIVE = new Set(['fast_status', 'fast_feedback']);

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

  // Secure browser: the sealed format and this browser's keys (null for a normal one).
  const lockCode = browser ? loadLockCode(browser) : null;
  const sealed = lockCode ? await import(SEALED_JS) : null;
  const keys = sealed ? await sealed.deriveKeys(lockCode) : null;
  let lastSeq = 0;
  // Unique and increasing in this process; time-based across processes (the browser keeps
  // a window of recent numbers, so two scripts at once are fine).
  const nextSeq = () => (lastSeq = Math.max(lastSeq + 1, Date.now() * 1000 + Math.floor(Math.random() * 1000)));

  async function send(name, args, ms) {
    const r = await withTimeout(relay.request('tools/call', { name, arguments: args }), ms, name);
    const content = Array.isArray(r?.content) ? r.content : [];
    let body = content.find((c) => c.type === 'text')?.text ?? null;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* plain text */ } }
    return { r, body, content, served: r?._meta?.['fastlink/browser'] ?? null };
  }

  async function sealedCall(name, args, ms) {
    const { browser: _routing, ...inner } = args;
    const seq = nextSeq();
    const frame = await sealed.seal(keys, 'req', { seq, ts: Date.now(), action: name, args: inner });
    const { body, served } = await send('fast_sealed', { ...frame, browser }, ms);
    // Relay-level errors (offline, timeout, refused) come back in clear and carry no content.
    if (!body || typeof body !== 'object' || !body.sealed) {
      return { ...(body && typeof body === 'object' ? body : { error: String(body) }), browser: served };
    }
    const reply = await sealed.unseal(keys, 'res', body.sealed, seq);
    if (reply && typeof reply === 'object' && 'error' in reply) return { ...reply, browser: served };
    return { result: reply?.result ?? null, ...(typeof reply?.tabId === 'number' ? { tabId: reply.tabId } : {}), browser: served };
  }

  async function call(name, args = {}, { timeoutMs: ms = timeoutMs } = {}) {
    if (keys && !RELAY_NATIVE.has(name)) return sealedCall(name, args, ms);
    const a = browser && args.browser == null ? { ...args, browser } : args;
    const { r, body, content, served } = await send(name, a, ms);
    const images = content.filter((c) => c.type === 'image');
    const isObj = body && typeof body === 'object' && !Array.isArray(body);
    if (r?.isError || (isObj && 'error' in body)) return { ...(isObj ? body : { error: String(body) }), browser: served };
    return { result: body, ...(images.length ? { images } : {}), browser: served };
  }

  return { call, sealed: !!keys };
}
