// call.js — FastLink calls from plain Node scripts (no MCP client needed).
//
//   const { connect } = await import('<fastlink>/fast-dxt/server/call.js');
//   const fl = await connect({ browser: 'mac2', client: 'costar-sweep' });
//   const r = await fl.call('fast_evaluate', { tabId: 123, fn: '() => location.href' });
//   // r = { result, browser } on success, { error, ...extras, browser } on failure
//
// Uses this machine's pairing (~/.fastlink/agent.json, made once with
// `node index.js pair <CODE>`) and the same relay client as the helper, so a
// script needs no token or broker of its own. `browser` is sent on every call
// (a script should always name its browser); `tabId` pins each call to one tab,
// so other sessions using the same browser can't move it.
import { loadAgent } from './agentFile.js';
import { createRelayClient } from './relayClient.js';
import { CLIENT_NAME, HELPER_VERSION } from './helper.js';

export async function connect({ browser = null, client = 'script' } = {}) {
  const agent = loadAgent();
  if (!agent) throw new Error('FastLink is not paired on this machine: run node <fastlink>/fast-dxt/server/index.js pair <CODE> (code from https://relay.ytx.app/pair/new)');
  const relay = createRelayClient(agent);
  await relay.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: `${HELPER_VERSION} (${client})` },
  });

  async function call(name, args = {}) {
    const a = browser && args.browser == null ? { ...args, browser } : args;
    const r = await relay.request('tools/call', { name, arguments: a });
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
