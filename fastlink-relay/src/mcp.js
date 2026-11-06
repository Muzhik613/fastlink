// src/mcp.js — minimal MCP JSON-RPC over Streamable HTTP (relay-core)
//
// Hand-rolled for Workers (no Node MCP SDK). Stateless: one POST in, one JSON
// response out — no SSE session, which is all a claude.ai custom connector needs
// for request/response tool calls.
//
// `relay` is the UserRelay DO instance; dispatchTool calls relay.callExtension(...)
// for each browser primitive.
//
// SCOPE: every tool routes straight to the extension (fast_batch runs its steps
// here). Image-returning tools come back as MCP image content (no /tmp on Workers).
// fast_evaluate is gated OFF by default.
//
// See SPEC.md §3e, §7.

import { TOOLS } from '../tools.js';
import { runBatch } from './batch.js';
import { resolveTraceSession, startTraceSession, recordTiming, traceClient } from './timing.js';
import { sanitizeDeviceName, getUserEmail, insertFeedback } from './db.js';

// Guidance the client sees in the initialize result — steers it toward the FAST
// tools instead of its default "screenshot + read it myself" instinct.
const INSTRUCTIONS = [
  'FastLink drives the user\'s own Chrome browsers through the FastLink relay. Each paired browser has a NAME. Browser tools act on the account default browser unless you pass `browser:"<name>"`; fast_status lists the browsers and which are connected. A browser that is offline is an error, never a silent switch to another one.',
  '',
  'FastLink drives the user\'s real Chrome tab. Use it efficiently:',
  '- READ a page with fast_snapshot — a fast, structured index of the DOM (readable text + clickable elements with coords). Do NOT take a screenshot to read content.',
  '- CROSS-ORIGIN FRAMES (embedded checkout/card forms, portal blades) are ordinary DOM targets: fast_snapshot lists their items under `frames`, and fast_click / fast_fill / fast_select_option act inside them directly. If a frame is still loading, snapshot again once it has rendered. Never use a screenshot to read ordinary page content — fast_snapshot does that.',
  '- CHAIN a known multi-step sequence in ONE call with fast_batch (e.g. navigate → fill → click → wait) to cut round-trips.',
  '- Fill multi-field forms with ONE fast_fill {fields:{label:value}} (or one fast_batch), never field-by-field.',
  '- Action results (fast_click / fast_fill / fast_wait) already include a snapshot — chain off THAT; do not issue a separate fast_snapshot right after.',
  '- Do NOT add artificial waits/sleeps — tabs load fast. Use fast_wait only when there is a real async signal (new view text, network idle), not as a reflex after every action.',
  '',
  'WHICH TOOL WHEN (rule of thumb: snapshot to read → DOM tools to act → vision only when the element is not in the DOM or the page is too heavy → batch when the path is known):',
  '- DEFAULT TO DOM TOOLS for normal HTML pages (the vast majority). Read with fast_snapshot; act with fast_click / fast_fill / fast_select_option. They are the fastest and most precise — TRY DOM FIRST.',
  '- USE the screenshot → fast_click_xy / fast_type path ONLY as a last resort, when DOM tools cannot reach the target at all: canvas/WebGL, image-only UIs, or a frame a snapshot\'s frameNotice names as unreadable. Coordinates you estimate from an image are often off, so prefer any DOM route first.',
  '- USE fast_batch when you already KNOW the full step sequence (navigate → fill → click → wait) to cut round-trips. DON\'T batch when you must SEE a step\'s result before deciding the next (exploratory/branching flows) — run those one at a time.',
].join('\n');

// ---- JSON-RPC plumbing ----------------------------------------------------

const json = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function handleMcpRequest(request, relay) {
  // Streamable HTTP: claude.ai may open a GET for a server→client SSE stream. We
  // are request/response only, so decline GET/other methods cleanly.
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
  }

  let rpc;
  try {
    rpc = await request.json();
  } catch {
    return json(rpcErr(null, -32700, 'parse error'));
  }

  // Timing trace (src/timing.js): one session per MCP connection. `initialize`
  // opens it (and captures who is driving); tools/call rows are appended to it.
  // sessionId stays `undefined` until a method actually needs it, so ping /
  // tools/list POSTs cost nothing. `minted` carries a new id into the response header.
  const trace = { request, sessionId: undefined, minted: null };

  // Batch support (claude.ai rarely batches, but the spec allows it).
  if (Array.isArray(rpc)) {
    const out = [];
    for (const one of rpc) {
      const r = await handleOne(one, relay, trace);
      if (r) out.push(r); // notifications produce no response
    }
    return out.length ? json(out, 200, traceHeaders(trace)) : new Response(null, { status: 202 });
  }

  const r = await handleOne(rpc, relay, trace);
  // A notification (no id) gets no body — just acknowledge.
  return r ? json(r, 200, traceHeaders(trace)) : new Response(null, { status: 202 });
}

// Hand the freshly-minted session id back on the initialize response. A client
// that echoes Mcp-Session-Id (Streamable HTTP) keeps the SAME trace across an
// access-token refresh; one that doesn't is still tracked by its token.
const traceHeaders = (trace) => (trace.minted ? { 'mcp-session-id': trace.minted } : {});

async function handleOne(rpc, relay, trace) {
  const { id, method, params } = rpc || {};

  // Notifications (e.g. notifications/initialized) carry no id and want no reply.
  if (typeof method === 'string' && method.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize':
      // Every initialize opens a FRESH trace session, stamped with the client's
      // self-reported identity (clientInfo.name/version) so a run is attributable
      // to claude / grok / gpt after the fact.
      trace.sessionId = await startTraceSession(relay, trace.request, params?.clientInfo);
      trace.minted = trace.sessionId;
      return ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fastlink-relay', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      // Bind to this connection's session — the one `initialize` just opened, the
      // one an earlier POST opened (looked up by Mcp-Session-Id or bearer token),
      // or a fresh one for a client that calls tools without initializing.
      if (trace.sessionId === undefined) {
        trace.sessionId = (await resolveTraceSession(relay, trace.request))
          ?? (await startTraceSession(relay, trace.request, null));
      }
      const startTs = Date.now();
      try {
        // WHICH BROWSER this call drives comes from the call itself (`browser`,
        // else the account default) and is resolved once in dispatchTool —
        // nothing about it is stored on the DO.
        return ok(id, await dispatchTool(params || {}, relay, trace));
      } finally {
        recordTiming(relay, trace.sessionId, params?.name || 'unknown', startTs, Date.now());
      }
    }
    case 'ping':
      return ok(id, {});
    default:
      // Unknown method with no id = unknown notification → silently drop.
      if (id === undefined || id === null) return null;
      return rpcErr(id, -32601, 'method not found');
  }
}

// ---- tool dispatch --------------------------------------------------------

// MCP result helpers. A tool ERROR is a normal result with isError:true (per the
// MCP spec), NOT a JSON-RPC error — so the model sees the message and can react.
const textResult = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const errorResult = (message) => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true });

// Raw tools that return a screenshot dataURL. On Workers there's no /tmp to save
// to, so we hand the image back as proper MCP image content instead.
const IMAGE_TOOLS = new Set(['fast_screenshot']);

// Mutating actions blocked when a site is in read-only consent mode (SAFETY §7).
const MUTATING_TOOLS = new Set([
  'fast_click', 'fast_click_xy', 'fast_fill', 'fast_type',
  'fast_key_press', 'fast_nav', 'fast_evaluate',
  'fast_select_option', 'fast_scroll', 'fast_tab', 'fast_close',
]);

// Diagnostic/orchestration tools that may NOT appear as a batch/macro step.
const DIAGNOSTIC_ONLY = new Set(['fast_status', 'fast_feedback', 'fast_batch']);

// Relay-native tools that never touch a page → exempt from the per-origin consent
// gate. (fast_batch's STEPS are gated individually inside runBatch.)
const CONSENT_EXEMPT = new Set(['fast_status', 'fast_feedback', 'fast_batch']);

// N2 kill-switch: tools still allowed while the user has PAUSED driving — only the
// relay-meta ones that never touch a page. Everything else (incl. fast_batch and
// all browser actions) is refused until the user resumes.
const PAUSE_EXEMPT = new Set(['fast_status', 'fast_feedback']);

// Browser-level tools that address tabs themselves: a fast_batch `tabId` is not
// pushed into these steps.
const TAB_LEVEL = new Set(['fast_list', 'fast_tab', 'fast_switch', 'fast_close']);

// The tab a call's gates must judge: its own tabId for page tools; tab-level
// tools (open/switch/close/list) are judged on the browser's target tab.
function gateTab(name, args) {
  return !TAB_LEVEL.has(name) && typeof args?.tabId === 'number' ? args.tabId : null;
}

// The args a batch step actually runs with: a batch-level tabId fills page steps
// that name no tab. Used by BOTH the step's gate and its call, so the tab that is
// checked is the tab that is driven (security review 11-06).
function stepArgs(name, args, batchTabId) {
  const a = { ...(args || {}) };
  if (batchTabId != null && !TAB_LEVEL.has(name) && a.tabId == null) a.tabId = batchTabId;
  return a;
}

// tabId must be a number when present; anything else is refused, never guessed.
function badTabId(args) {
  return args && args.tabId != null && typeof args.tabId !== 'number'
    ? { error: `tabId must be a number (a tab id from fast_list); got ${JSON.stringify(args.tabId)}.` }
    : null;
}

// Page-touching writes carry the origin the gates approved; the extension checks
// the tab is still on it at execution time (closes the gate→act race).
function withExpectOrigin(relay, name, args, target) {
  if (!MUTATING_TOOLS.has(name) || TAB_LEVEL.has(name)) return args;
  const origin = relay.cachedOrigin(target, gateTab(name, args));
  return origin ? { ...args, expectOrigin: origin } : args;
}

const FEEDBACK_MAX = 4000;
const FEEDBACK_KINDS = new Set(['bug', 'idea', 'other']);

// Per-origin consent gate (M4 / SIGNUP-SPEC §4.2). Returns null to PROCEED, or a
// plain blocking payload object to short-circuit (dispatchTool wraps it in
// textResult; runBatch folds it into the step result). Decision per origin:
//   allow    → proceed (reads + writes)
//   block    → refuse ALL tools for this origin
//   readonly → refuse MUTATING_TOOLS (reads pass)
//   prompt   → undecided origin under the multi-user default: reads pass, a write
//              returns the consent_required affordance so the human can approve.
// `tabId` = the tab the call will act on (null = the browser's target tab): the
// gate reads THAT tab's origin, never another tab's (security review 11-06).
async function consentVerdict(relay, name, target, tabId = null) {
  if (CONSENT_EXEMPT.has(name)) return null;

  const def = relay.consentDefault();
  const mutating = MUTATING_TOOLS.has(name);
  // The stamped origin of that exact tab. With none yet, only pay for a probe of
  // that tab when the default actually gates (prompt/readonly); under the
  // allow-default an unvisited tab has nothing to check.
  let origin = relay.cachedOrigin(target, tabId);
  if (!origin && def !== 'allow') origin = await relay.currentOrigin(target, tabId);
  if (!origin) {
    // Unknown site: reads (and the allow-default) run; a write under a gating
    // default fails closed rather than acting on a site nobody approved.
    if (def === 'allow' || !mutating) return null;
    return { error: `Couldn't tell which site this tab is on, so "${name}" was not run. Read the page first, then retry.`, consentUnknown: true };
  }

  const mode = await relay.consentFor(origin); // 'allow'|'readonly'|'block'|'prompt'

  if (mode === 'allow') return null;
  if (mode === 'block') {
    return {
      error: `"${name}" is blocked: you've set ${origin} to "block" for your account. Change it in the FastLink extension popup.`,
      consentBlocked: true,
      origin,
    };
  }
  if (mode === 'readonly') {
    if (!mutating) return null;
    return {
      error: `"${name}" is blocked: ${origin} is in read-only mode for your account. Approve write access for this site in the FastLink extension popup.`,
      readonlyBlocked: true,
      origin,
    };
  }
  // mode === 'prompt' (undecided origin, multi-user default): reads pass; a write
  // surfaces the first-touch approval prompt and is NOT executed this turn.
  if (!mutating) return null;
  const modesOffered = ['allow', 'readonly'];
  const message = `FastLink needs your approval to act on ${origin}. Approve it in the extension popup (Allow / Read-only).`;
  // Also push an out-of-band frame so the extension popup can surface the Allow /
  // Read-only / Block control proactively (relayClient.js consent_required handler).
  relay.notifyExtension({ type: 'consent_required', origin, modesOffered, message }, target);
  return { consentRequired: true, origin, modesOffered, message };
}

async function dispatchTool(params, relay, trace) {
  const name = params?.name;
  // `browser` is routing-only: consumed here, never forwarded to the extension.
  const { browser, ...args } = params?.arguments || {};
  if (!name) return errorResult('missing tool name');

  // N2 kill-switch (SAFETY): if the user paused driving from the extension popup,
  // refuse every browser-touching tool until they resume. Human-only — there is no
  // tool to un-pause, so prompt-injection can't override it.
  if (!PAUSE_EXEMPT.has(name) && (await relay.isDrivingPaused())) {
    return textResult({
      error: 'Driving is paused by the user. Resume it from the FastLink extension popup to continue.',
      drivingPaused: true,
    });
  }

  // Relay-native tools that answer without needing a live browser.
  if (name === 'fast_status') return textResult(await relayStatus(relay, browser));
  if (name === 'fast_feedback') return textResult(await handleFeedback(relay, args, browser, trace));

  // WHICH BROWSER: the named one, else the account default — resolved once and
  // threaded through every sub-step below. An unset default, unknown name or
  // offline browser is a hard error naming the connected browsers.
  const target = await relay.resolveTarget(browser);
  if (target.error) return textResult(target);
  {
    const bad = badTabId(args);
    if (bad) return textResult(bad);
  }

  // Per-origin consent gate (M4) — applies to every page-touching tool, incl.
  // fast_evaluate (in MUTATING_TOOLS). Batch steps are gated in runBatch.
  {
    const verdict = await consentVerdict(relay, name, target, gateTab(name, args));
    if (verdict) return textResult(verdict);
  }

  // fast_evaluate: arbitrary in-page JS. Per-user ALLOWLIST gate (db.getEvalPolicy
  // + the target browser's origin): enabled AND (operator allow-all OR allowlisted).
  if (name === 'fast_evaluate') {
    const verdict = await relay.checkEvalAllowed(target, gateTab(name, args));
    if (!verdict.ok) return textResult({ error: verdict.error, evalBlocked: true });
  }

  if (name === 'fast_batch') {
    const { tabId, ...batchArgs } = args;
    return textResult(await runBatch(batchArgs, batchIo(relay, target, tabId)));
  }

  // Everything else: one straight passthrough to the extension (tabId included),
  // pinned to the origin the gates just approved (the extension refuses if the
  // tab moved to another site in between).
  const payload = await relay.callExtension(name, withExpectOrigin(relay, name, args, target), undefined, target);
  relay.audit(name, args, !(payload && typeof payload === 'object' && 'error' in payload), target); // best-effort, fire-and-forget

  // Tool-level errors come back as resolved payloads with `error` set (+ extras
  // like diagnostics/available). Surface the whole thing so the model sees it.
  if (payload && typeof payload === 'object' && 'error' in payload) return textResult(payload);

  const result = payload?.result ?? null;
  // The result envelope's `tabId` (the tab acted on) rides into an object result
  // so the helper can learn its session's tab (PIN-REDESIGN §2/§3).
  if (payload && payload.tabId != null && result && typeof result === 'object' && !Array.isArray(result) && result.tabId == null) {
    result.tabId = payload.tabId;
  }

  // Image-returning tools → MCP image content (no /tmp on Workers).
  if (IMAGE_TOOLS.has(name) && result && typeof result === 'object' && result.dataUrl) {
    return imageResult(result);
  }

  // Opt-in inline screenshots on other tools (e.g. fast_click screenshot:true):
  // the dataURL would bomb context and we can't save it to /tmp, so replace it
  // with a short note while keeping the rest of the result.
  if (result && typeof result === 'object' && result.screenshot?.dataUrl) {
    const { dataUrl, ...rest } = result.screenshot;
    result.screenshot = { ...rest, note: 'screenshot captured; inline image omitted in cloud relay v1 (use fast_screenshot to receive it as an image)' };
  }

  return textResult(result);
}

// ---- fast_feedback: store a note for the FastLink operators ----------------
// Works with no browser connected. `browser` = the named browser, else the
// account default (may be null). `client` = the MCP clientInfo from this
// connection's initialize, else the User-Agent.
async function handleFeedback(relay, args, browser, trace) {
  const text = typeof args?.text === 'string' ? args.text.trim() : '';
  if (!text) return { error: 'fast_feedback needs `text`.' };
  if (text.length > FEEDBACK_MAX) return { error: `fast_feedback \`text\` is ${text.length} characters; the limit is ${FEEDBACK_MAX}.` };
  const kind = args?.kind == null || args.kind === '' ? 'other' : String(args.kind);
  if (!FEEDBACK_KINDS.has(kind)) return { error: `fast_feedback \`kind\` must be one of: ${[...FEEDBACK_KINDS].join(', ')}.` };
  if (!relay.env.DB || !relay.userId) return { error: 'Feedback storage is unavailable on this relay.' };

  const name = browser != null && browser !== '' ? (sanitizeDeviceName(String(browser)) || null) : await relay.getDefaultDevice();
  let client = await traceClient(relay, trace.sessionId);
  if (!client) client = (trace.request.headers.get('user-agent') || '').slice(0, 200) || null;
  let email = null;
  try { email = await getUserEmail(relay.env.DB, relay.userId); } catch { /* non-fatal */ }
  const id = await insertFeedback(relay.env.DB, { userId: relay.userId, email, browser: name, client, kind, text });
  return { ok: true, id };
}

// Turn an extension { dataUrl, ...meta } payload into MCP image + text content.
function imageResult(result) {
  const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(result.dataUrl);
  const content = [];
  if (m) content.push({ type: 'image', data: m[2], mimeType: m[1] });
  // Preserve any non-image metadata (marks index, dpr, dims) as text.
  const { dataUrl, ...meta } = result;
  if (Object.keys(meta).length) content.push({ type: 'text', text: JSON.stringify(meta) });
  if (!content.length) content.push({ type: 'text', text: JSON.stringify(result) });
  return { content };
}

// Relay-aware status: every browser of the account, the default, and where a
// call with this `browser` (or none → the default) would be routed.
async function relayStatus(relay, browser) {
  const devices = await relay.deviceList();
  const browsers = devices.map((d) => ({ name: d.name, connected: d.connected, lastSeen: d.lastSeen }));
  const defaultBrowser = await relay.getDefaultDevice();
  const target = await relay.resolveTarget(browser);
  const connected = !!(target && target.ws);
  const policy = await relay.evalPolicy();
  // Per-origin consent (M4): the decision for the ROUTED browser's last-known origin.
  const origin = connected ? relay.cachedOrigin(target, null) : '';
  const consentMode = origin ? await relay.consentFor(origin) : null;
  const drivingPaused = await relay.isDrivingPaused();
  return {
    connected,
    transport: 'cloud-relay',
    userId: relay.userId || null,
    browsers,
    defaultBrowser,
    routedBrowser: connected ? target.name : null,
    targetError: target && target.error ? target.error : null,
    drivingPaused,
    evaluateAllowed: policy.allowEvaluate,
    consentDefault: relay.consentDefault(),
    activeOrigin: origin || null,
    // Effective decision for activeOrigin: an explicit row ('allow'|'readonly'|
    // 'block') or the mode-bound default ('allow'|'prompt'|'readonly'); null when
    // no origin is known yet.
    consent: consentMode,
    readonly: consentMode === 'readonly',
    hint: drivingPaused
      ? 'Driving is PAUSED by the user (FastLink extension popup → Resume to continue). All browser tools are refused until then.'
      : connected
        ? `Calls ${browser ? `with browser:"${target.name}"` : 'without `browser`'} drive "${target.name}".`
        : target.error,
  };
}

// fast_batch: the runner (every step runs, ifFound branches, one snapshot, BUG-2
// nav settle) is src/batch.js. The relay
// wires its per-step gates (diagnostic-only, evaluate policy, origin consent)
// and audit into the hooks.
// A batch-level `tabId` is pushed into every page step that names no tab of its
// own, and marks that tab as the target in the runner's fast_list probes so its
// navigation settle watches the right tab.
const batchIo = (relay, target, tabId) => ({
  gate: async (step) => {
    if (DIAGNOSTIC_ONLY.has(step.name)) return { error: `"${step.name}" is a diagnostic/deferred tool (not allowed as a batch step)` };
    const eff = stepArgs(step.name, step.args, tabId);
    const bad = badTabId(eff);
    if (bad) return bad;
    const stepTab = gateTab(step.name, eff);
    if (step.name === 'fast_evaluate') {
      const verdict = await relay.checkEvalAllowed(target, stepTab);
      if (!verdict.ok) return { error: verdict.error };
    }
    return consentVerdict(relay, step.name, target, stepTab);
  },
  call: async (name, args) => {
    const a = stepArgs(name, args, tabId);
    const r = await relay.callExtension(name, withExpectOrigin(relay, name, a, target), undefined, target);
    if (tabId != null && name === 'fast_list' && Array.isArray(r?.result)) {
      r.result = r.result.map((t) => ({ ...t, targetTab: t.id === tabId }));
    }
    const probe = name === 'fast_list' || (name === 'fast_evaluate' && a.fn === '() => document.readyState');
    if (!probe) relay.audit(name, a, !(r && r.error), target); // best-effort
    return r;
  },
});
