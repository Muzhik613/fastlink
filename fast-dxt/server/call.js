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
import { loadAgent } from './agentFile.js';
import { createRelayClient } from './relayClient.js';
import { CLIENT_NAME, HELPER_VERSION } from './helper.js';

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

  async function call(name, args = {}, { timeoutMs: ms = timeoutMs } = {}) {
    const a = browser && args.browser == null ? { ...args, browser } : args;
    const r = await withTimeout(relay.request('tools/call', { name, arguments: a }), ms, name);
    const served = r?._meta?.['fastlink/browser'] ?? null;
    const content = Array.isArray(r?.content) ? r.content : [];
    const images = content.filter((c) => c.type === 'image');
    const first = content.find((c) => c.type === 'text')?.text;
    let body = first ?? null;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* plain text */ } }
    const isObj = body && typeof body === 'object' && !Array.isArray(body);
    if (r?.isError || (isObj && 'error' in body)) return { ...(isObj ? body : { error: String(body) }), browser: served };
    return { result: body, ...(images.length ? { images } : {}), browser: served };
  }

  return { call };
}
