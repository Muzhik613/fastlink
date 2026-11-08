// helper.js — one Claude Code session's view of FastLink.
//
// Forwards MCP initialize / tools/list / tools/call to the relay. Browser choice
// lives here, never on the relay (docs/PIN-REDESIGN.md §1, §4):
//   pin       — the browser this session was told to drive (fast_profile), or null
//   lastUsed  — the browser that served this session's last call (else this
//               MACHINE's last one, from lastBrowserStore)
//   myTab     — per browser, the tab this session is working in
// A pinned call gets {browser: pin}. An unpinned call gets the soft hint
// {lastBrowser}: the relay uses the only online browser, else that hint if it's
// online, else errors with the online list. Calls also get {tabId: myTab}.
import { hostname } from 'node:os';
import { createRelayClient } from './relayClient.js';
import { PAIR_URL } from './agentFile.js';

export const HELPER_VERSION = '2.0.0';
export const CLIENT_NAME = `fastlink-helper@${hostname()}`;

// Tools whose own `tabId` argument names the tab to act on — shown to the model, never filled in.
const NATIVE_TAB_ARG = new Set(['fast_switch', 'fast_close']);
// Tools that don't act on an existing page: never get this session's tab.
const NO_TAB = new Set(['fast_status', 'fast_list', 'fast_tab', 'fast_feedback', ...NATIVE_TAB_ARG]);
// Results that tell us which tab this session now works in.
const LEARNS_TAB = new Set(['fast_tab', 'fast_nav', 'fast_switch']);
const TAB_GONE_RE = /no tab with id|tab (?:\S+ )?(?:not found|was closed|is closed|is gone|no longer exists|does not exist)|invalid tab/i;

const PROFILE_TOOL = {
  name: 'fast_profile',
  description: 'Choose which browser this session drives, by name (see fast_status), or "auto" to let FastLink pick (the only online browser, else the last one used here).',
  inputSchema: {
    type: 'object',
    properties: {
      install: { type: 'string', description: 'Browser name, or "auto".' },
    },
  },
};

const UNPAIRED_STATUS_TOOL = {
  name: 'fast_status',
  description: 'Shows whether FastLink is set up on this machine.',
  inputSchema: { type: 'object', properties: {} },
};

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });
const errorText = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

// The JSON a relay tool result carries in its first text item, or null.
function resultJson(result) {
  const t = result?.content?.find?.((c) => c.type === 'text')?.text;
  if (typeof t !== 'string') return null;
  try { return JSON.parse(t); } catch { return null; }
}

// Describe the routing args the helper fills in when they're omitted.
export function stripRoutingArgs(tool) {
  const schema = tool.inputSchema;
  if (!schema?.properties) return tool;
  // `browser` and `tabId` stay visible (the helper replaces the direct relay connector, so
  // a session can still name any browser or tab per call; bug #21). When omitted, the
  // helper fills them: this session's pinned / last-used browser, and its own tab.
  if (!('browser' in schema.properties) && !('tabId' in schema.properties)) return tool;
  const properties = { ...schema.properties };
  if (properties.browser) {
    properties.browser = { ...properties.browser, description: 'Browser name to drive (see fast_status). Omitted: this session\'s browser (fast_profile), else the one it used last, else the only one online.' };
  }
  if (properties.tabId && !NATIVE_TAB_ARG.has(tool.name)) {
    properties.tabId = { ...properties.tabId, description: 'Tab id to act on (from fast_tab / fast_list). Omitted: the tab this session opened or switched to last.' };
  }
  const out = { ...schema, properties };
  // Never required: the helper fills `tabId` (this session's tab) when the model omits it.
  if (Array.isArray(schema.required)) out.required = schema.required.filter((k) => k !== 'browser' && k !== 'tabId');
  return { ...tool, inputSchema: out };
}

/**
 * @param {object} o
 * @param {() => object|null} o.loadAgent  current pairing (re-read while unpaired, so pairing mid-session works)
 * @param {string} o.pairCommand           the exact command a user runs to pair
 * @param {{get():string|null, set(name:string):void}} [o.lastBrowserStore]  this machine's last-used browser
 */
export function createHelper({ loadAgent, pairCommand, lastBrowserStore = { get: () => null, set() {} } }) {
  let agent = loadAgent();
  let relay = agent ? createRelayClient(agent) : null;
  let pin = null;
  let lastUsed = null;
  const hint = () => lastUsed ?? lastBrowserStore.get();
  const myTab = new Map();
  let downstreamClient = null; // what spawned us (claude-code etc.), folded into clientInfo.version

  const unpairedMessage = () =>
    `FastLink isn't paired on this machine yet. Get a pairing code at ${PAIR_URL}, then run:\n  ${pairCommand} <CODE>\nand reconnect FastLink (/mcp in Claude Code).`;

  function ensureRelay() {
    if (relay) return relay;
    agent = loadAgent();
    relay = agent ? createRelayClient(agent) : null;
    return relay;
  }

  const clientInfo = () => ({
    name: CLIENT_NAME,
    version: downstreamClient ? `${HELPER_VERSION} (${downstreamClient})` : HELPER_VERSION,
  });

  async function initialize(params) {
    const ci = params?.clientInfo;
    if (ci?.name) downstreamClient = `${ci.name}/${ci.version ?? '?'}`;
    const local = {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fastlink-helper', version: HELPER_VERSION },
    };
    if (!ensureRelay()) return { ...local, instructions: unpairedMessage() };
    try {
      const r = await relay.request('initialize', { ...params, clientInfo: clientInfo() });
      return { ...r, capabilities: { tools: {} }, serverInfo: local.serverInfo };
    } catch (e) {
      return { ...local, instructions: `FastLink relay unavailable at startup: ${e.message}` };
    }
  }

  async function listTools() {
    if (!ensureRelay()) return { tools: [UNPAIRED_STATUS_TOOL, PROFILE_TOOL] };
    const r = await relay.request('tools/list', {});
    const tools = (r?.tools || []).filter((t) => t.name !== 'fast_profile').map(stripRoutingArgs);
    return { ...r, tools: [...tools, PROFILE_TOOL] };
  }

  async function relayStatus() {
    const h = hint();
    const r = await relay.request('tools/call', { name: 'fast_status', arguments: h ? { lastBrowser: h } : {} });
    const s = resultJson(r);
    if (!s || !Array.isArray(s.browsers)) throw new Error(`fast_status gave no browser list: ${JSON.stringify(r).slice(0, 200)}`);
    return s;
  }

  async function profile(args) {
    const raw = String(args?.install ?? args?.browser ?? '').trim().toLowerCase();
    let status;
    try { status = await relayStatus(); } catch (e) { return errorText(`Couldn't read your browsers from the relay: ${e.message}`); }
    const browsers = status.browsers.map((b) => ({ name: b.name, connected: !!b.connected }));
    const list = browsers.map((b) => `${b.name}${b.connected ? '' : ' (offline)'}`).join(', ') || '(none paired)';

    if (raw === '' || raw === 'auto') {
      pin = null;
      const now = status.routedBrowser;
      return text({
        pinned: null,
        browsers,
        routedBrowser: now ?? null,
        hint: `No browser pinned: calls use the only online browser, else the one this session or machine used last${now ? ` (now "${now}")` : ''}. Browsers: ${list}.`,
      });
    }
    const hit = browsers.find((b) => b.name === raw);
    if (!hit) return text({ error: `No browser named "${raw}". Browsers: ${list}.`, pinned: pin, browsers });
    pin = hit.name;
    return text({
      pinned: pin,
      browsers,
      hint: hit.connected
        ? `This session now drives "${pin}". fast_profile "auto" lets FastLink pick again.`
        : `This session now drives "${pin}", but it's offline. Calls will fail until that browser reconnects. Browsers: ${list}.`,
    });
  }

  async function callTool(params) {
    const name = params?.name;
    const args = { ...(params?.arguments || {}) };
    if (!ensureRelay()) return text(unpairedMessage());
    if (name === 'fast_profile') return profile(args);

    // An explicit `browser` from the model wins; else the pin (hard); else the hint (soft).
    const h = hint();
    if (args.browser == null && pin) args.browser = pin;
    if (args.browser == null && h) args.lastBrowser = h;
    const key = args.browser ?? h ?? '?';
    // fast_tab is always scoped: the new tab becomes THIS session's tab (learned from the
    // result) and never the browser's shared target, which other sessions rely on (bug #21).
    if (name === 'fast_tab') args.scoped = true;
    let injectedTab = null;
    if (!NO_TAB.has(name) && args.tabId == null && myTab.has(key)) {
      injectedTab = myTab.get(key);
      args.tabId = injectedTab;
    }

    let result;
    try {
      result = await relay.request('tools/call', { name, arguments: args });
    } catch (e) {
      return errorText(`Error: ${e.message}`);
    }

    const body = resultJson(result);
    const failed = result?.isError || (body && typeof body === 'object' && 'error' in body);
    // The browser that actually served the call (relay _meta) becomes this
    // session's — and this machine's — last-used browser.
    const served = result?._meta?.['fastlink/browser'] || null;
    const tabKey = served ?? key;
    if (served && !failed) {
      lastUsed = served;
      try { lastBrowserStore.set(served); } catch { /* best-effort */ }
    }
    if (failed) {
      const msg = result?.content?.map?.((c) => c.text || '').join(' ') || '';
      if (injectedTab != null && TAB_GONE_RE.test(msg) && myTab.get(key) === injectedTab) myTab.delete(key);
    } else if (LEARNS_TAB.has(name) && typeof body?.tabId === 'number') {
      myTab.set(tabKey, body.tabId);
    } else if (name === 'fast_close' && args.tabId != null && myTab.get(tabKey) === args.tabId) {
      myTab.delete(tabKey);
    }
    return result;
  }

  // One JSON-RPC message in → the reply (or null for notifications).
  async function handle(msg) {
    const { id, method, params } = msg || {};
    const isRequest = id !== undefined && id !== null;
    try {
      let result;
      switch (method) {
        case 'initialize': result = await initialize(params); break;
        case 'tools/list': result = await listTools(); break;
        case 'tools/call': result = await callTool(params); break;
        case 'ping': result = {}; break;
        default:
          if (!isRequest) return null;
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
      }
      return isRequest ? { jsonrpc: '2.0', id, result } : null;
    } catch (e) {
      return isRequest ? { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } } : null;
    }
  }

  return { handle, get pin() { return pin; }, get lastUsed() { return lastUsed; }, myTab };
}
