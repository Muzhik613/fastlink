// src/mcp.js — minimal MCP JSON-RPC over Streamable HTTP (relay-core)
//
// Hand-rolled for Workers (no Node MCP SDK). Stateless: one POST in, one JSON
// response out — no SSE session, which is all a claude.ai custom connector needs
// for request/response tool calls. Same spirit as fast-dxt/server/transports.js.
//
// `relay` is the UserRelay DO instance; dispatchTool calls relay.callExtension(...)
// for each browser primitive, mirroring fast-dxt/server/handlers.js's surface.
//
// SCOPE: every tool routes straight to the extension (fast_batch runs its steps
// here). Image-returning tools come back as MCP image content (no /tmp on Workers).
// fast_evaluate is gated OFF by default.
//
// See SPEC.md §3e, §7.

import { TOOLS } from '../tools.js';
import { runBatch } from './batch.js';
import { resolveTraceSession, startTraceSession, recordTiming } from './timing.js';
import { sanitizeDeviceName, RESERVED_DEVICE_NAMES } from './db.js';

// Guidance the client (Claude) sees in the initialize result — steers it toward
// the FAST tools instead of its default "screenshot + read it myself" instinct.
// Keep in sync with fast-dxt/server/transports.js INSTRUCTIONS.
const INSTRUCTIONS = [
  'THIS IS THE CLOUD relay connector (server "fastlink-relay", shown as "claude.ai Fastlink") — it drives the browser over the multi-tenant relay and needs the user\'s extension PAIRED to their relay account. If a separate LOCAL connector is ALSO listed (server "fastlink") — i.e. this is a Claude Code session on the user\'s own machine — PREFER THAT LOCAL ONE; it drives the browser directly with no pairing/token/OAuth. FASTLINK_TOKEN is NOT used by this connector either; never treat a missing FASTLINK_TOKEN as the cause of a problem here — this path authenticates with OAuth.',
  '',
  'FastLink drives the user\'s real Chrome tab. Use it efficiently:',
  '- READ a page with fast_snapshot — a fast, structured index of the DOM (readable text + clickable elements with coords). Do NOT take a screenshot to read content.',
  '- LOCATE/click something NOT in the DOM (canvas, opaque/cross-origin iframe, image, custom-rendered UI) by taking fast_screenshot, reading the element\'s position off the image, then acting with fast_click_xy (and fast_type to enter text). Never use a screenshot to read ordinary page content — fast_snapshot does that.',
  '- CHAIN a known multi-step sequence in ONE call with fast_batch (e.g. navigate → fill → click → wait) to cut round-trips.',
  '- Fill multi-field forms with ONE fast_fill {fields:{label:value}} (or one fast_batch), never field-by-field.',
  '- Action results (fast_click / fast_fill / fast_wait) already include a snapshot — chain off THAT; do not issue a separate fast_snapshot right after.',
  '- Do NOT add artificial waits/sleeps — tabs load fast. Use fast_wait only when there is a real async signal (new view text, network idle), not as a reflex after every action.',
  '',
  'WHICH TOOL WHEN (rule of thumb: snapshot to read → DOM tools to act → vision only when the element is not in the DOM or the page is too heavy → batch when the path is known):',
  '- DEFAULT TO DOM TOOLS for normal HTML pages (the vast majority). Read with fast_snapshot; act with fast_click / fast_fill / fast_select_option. They are the fastest and most precise — TRY DOM FIRST.',
  '- USE the screenshot → fast_click_xy / fast_type path ONLY when DOM can\'t see or reach the target: canvas/WebGL, cross-origin iframes, image-only or custom-rendered UIs, or when DOM tools return nothing / freeze on a very heavy page. It is a FALLBACK, not the default.',
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
        // WHICH BROWSER this call drives is resolved per REQUEST and threaded
        // down (see dispatchTool) — never re-picked mid-call, and never stored on
        // the DO instance, which two concurrent chat products would race over.
        const session = { clientKey: await relay.clientKey(trace.request), target: undefined };
        return ok(id, await dispatchTool(params || {}, relay, session));
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
const DIAGNOSTIC_ONLY = new Set(['fast_status', 'fast_profile', 'fast_batch']);

// Relay-native tools that never touch a page → exempt from the per-origin consent
// gate. (fast_batch's STEPS are gated individually inside runBatch.)
const CONSENT_EXEMPT = new Set(['fast_status', 'fast_profile', 'fast_batch']);

// N2 kill-switch: tools still allowed while the user has PAUSED driving — only the
// observable relay-meta ones, so the paused state can be reported. Everything else
// (incl. fast_batch and all browser actions) is refused until the user resumes.
const PAUSE_EXEMPT = new Set(['fast_status', 'fast_profile']);

// Per-origin consent gate (M4 / SIGNUP-SPEC §4.2). Returns null to PROCEED, or a
// plain blocking payload object to short-circuit (dispatchTool wraps it in
// textResult; runBatch folds it into the step result). Decision per origin:
//   allow    → proceed (reads + writes)
//   block    → refuse ALL tools for this origin
//   readonly → refuse MUTATING_TOOLS (reads pass)
//   prompt   → undecided origin under the multi-user default: reads pass, a write
//              returns the consent_required affordance so the human can approve.
async function consentVerdict(relay, name, ws) {
  if (CONSENT_EXEMPT.has(name)) return null;

  const def = relay.consentDefault();
  // Cheap path: use the stamped origin if we have it. With no stamped origin yet,
  // only pay for a probe when the default actually gates (prompt/readonly); in
  // allow-default (shared/operator) skip straight through.
  let origin = relay.lastOrigin || '';
  if (!origin) {
    if (def === 'allow') return null;
    origin = await relay.currentOrigin(ws);
  }
  if (!origin) return null; // no resolvable active-tab origin — let the call run (it'll fail naturally if disconnected)

  const mode = await relay.consentFor(origin); // 'allow'|'readonly'|'block'|'prompt'
  const mutating = MUTATING_TOOLS.has(name);

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
  relay.notifyExtension({ type: 'consent_required', origin, modesOffered, message }, ws);
  return { consentRequired: true, origin, modesOffered, message };
}

// Resolve (once per request) the browser this call drives. Memoized on `session`
// so a tool that probes several times still talks to ONE browser.
async function targetFor(relay, session) {
  if (session.target === undefined) session.target = await relay.resolveTarget(session.clientKey);
  return session.target;
}

async function dispatchTool(params, relay, session) {
  const name = params?.name;
  const args = params?.arguments || {};
  if (!name) return errorResult('missing tool name');

  // N2 kill-switch (SAFETY): if the user paused driving from the extension popup,
  // refuse every browser-touching tool until they resume. Human-only — there is no
  // tool to un-pause, so prompt-injection can't override it. fast_status/profile
  // stay available so the paused state is observable.
  if (!PAUSE_EXEMPT.has(name) && (await relay.isDrivingPaused())) {
    return textResult({
      error: 'Driving is paused by the user. Resume it from the FastLink extension popup to continue.',
      drivingPaused: true,
    });
  }

  // Relay-native tools that answer without touching a browser. Deliberately
  // BEFORE target resolution so they still work when the pinned browser is
  // offline — otherwise the only tool that can fix a bad pin would be unreachable.
  if (name === 'fast_status') return textResult(await relayStatus(relay, session));
  if (name === 'fast_profile') return textResult(await handleProfile(relay, args, session));

  // WHICH BROWSER: resolved once, then threaded through every sub-step below.
  // A pin that can't be honoured is a hard error naming the connected browsers —
  // NEVER a silent redirect to another browser. Everything past this point needs
  // a live browser; the relay-native tools that don't have already returned.
  const target = await targetFor(relay, session);
  if (target.error) return textResult(target);
  const ws = target.ws;

  // Per-origin consent gate (M4) — applies to every page-touching tool, incl. the
  // fast_evaluate (in MUTATING_TOOLS). Exempt relay-native
  // tools (status/profile/batch) pass through; batch steps are gated in runBatch.
  {
    const verdict = await consentVerdict(relay, name, ws);
    if (verdict) return textResult(verdict);
  }

  // fast_evaluate: arbitrary in-page JS. Per-user ALLOWLIST gate (db.getEvalPolicy
  // + active-tab origin): enabled AND (operator allow-all OR origin allowlisted).
  if (name === 'fast_evaluate') {
    const verdict = await relay.checkEvalAllowed(ws);
    if (!verdict.ok) return textResult({ error: verdict.error, evalBlocked: true });
  }

  if (name === 'fast_batch') return textResult(await runBatch(args, batchIo(relay, ws)));

  // Everything else: one straight passthrough to the extension.
  const payload = await relay.callExtension(name, args, undefined, ws);
  relay.audit(name, args, !(payload && typeof payload === 'object' && 'error' in payload)); // best-effort, fire-and-forget

  // Tool-level errors come back as resolved payloads with `error` set (+ extras
  // like diagnostics/available). Surface the whole thing so the model sees it.
  if (payload && typeof payload === 'object' && 'error' in payload) return textResult(payload);

  const result = payload?.result ?? null;

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

// ---- fast_profile: pick WHICH paired browser this connection drives --------
// Same tool name and argument shape as the LOCAL connector's fast_profile
// (fast-dxt/server/handlers.js handleUseInstall) so the two transports feel
// identical: install:"<name>" pins, install:"auto" releases.
//
// The pin is stored SERVER-SIDE in the user's DO, keyed by the chat product
// (relay.clientKey), NOT by MCP session — Grok opens a new MCP session for every
// single tool call, so a session-scoped pin would never survive to the next one.
async function handleProfile(relay, args, session) {
  const raw = String(args?.install ?? '').trim().toLowerCase();
  const devices = await relay.deviceList();
  const browsers = devices.map((d) => ({ name: d.name, connected: d.connected }));
  const known = devices.map((d) => d.name);
  const live = devices.filter((d) => d.connected).map((d) => d.name);
  const defaultBrowser = await relay.getDefaultDevice();

  if (raw === '' || RESERVED_DEVICE_NAMES.has(raw)) {
    await relay.setSelection(session.clientKey, null);
    return {
      selected: null,
      mode: 'auto',
      browsers,
      defaultBrowser,
      hint: `AUTO — calls go to the most recently connected browser. Connected: ${live.join(', ') || '(none)'}.`,
    };
  }

  const want = sanitizeDeviceName(raw);
  if (!want) {
    return {
      error: `Invalid browser name "${raw}". Names use [a-z0-9_-] (e.g. "work"), or pass "auto" to release the pin.`,
      browsers,
    };
  }
  const dev = devices.find((d) => d.name === want);
  if (!dev) {
    return {
      error: `No browser named "${want}" is paired to this account. Paired: ${known.join(', ') || '(none)'}. `
        + `Name a browser on its FastLink options page (Settings → Connection → "This browser's name"), then retry.`,
      browsers,
    };
  }
  await relay.setSelection(session.clientKey, want);
  return {
    selected: want,
    mode: 'pinned',
    connected: dev.connected,
    browsers,
    defaultBrowser,
    hint: dev.connected
      ? `Pinned to "${want}" — every later call from this connection drives that browser. fast_profile install:"auto" releases it.`
      : `Pinned to "${want}", but it is NOT connected right now. Calls will error (they will not silently go to another browser) until that Chrome profile reconnects. Connected now: ${live.join(', ') || '(none)'}.`,
  };
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

// Relay-aware status (replaces handlers.js's broker report). Tells the user
// whether their extension WS is attached to their DO.
async function relayStatus(relay, session) {
  const devices = await relay.deviceList();
  const browsers = devices.map((d) => ({ name: d.name, connected: d.connected, lastSeen: d.lastSeen }));
  const liveNames = devices.filter((d) => d.connected).map((d) => d.name);
  const sel = await relay.getSelection(session.clientKey);
  const defaultBrowser = await relay.getDefaultDevice();
  // "connected" = this connection can actually reach a browser right now, i.e.
  // the SELECTED one is live — not merely "some browser of mine is live".
  const target = await targetFor(relay, session);
  const connected = !!(target && target.ws);
  const policy = await relay.evalPolicy();
  // Per-origin consent (M4): report the decision for the current active-tab origin.
  const origin = relay.lastOrigin || '';
  const consentMode = origin ? await relay.consentFor(origin) : null;
  // N2 kill-switch: surface the pause state so the user/Claude can see driving is
  // stopped (and which browser is driving).
  const drivingPaused = await relay.isDrivingPaused();
  return {
    connected,
    transport: 'cloud-relay',
    userId: relay.userId || null,
    devicesConnected: relay.extSocketCount(),
    // MULTI-BROWSER: every paired browser of this account, which are live, and
    // which one THIS connection is driving. `selected` is null in auto mode.
    browsers,
    selected: sel.mode === 'pinned' ? sel.name : null,
    selectionMode: sel.mode,               // 'pinned' | 'auto'
    selectionSource: sel.source,           // 'pin' | 'default' | 'unset'
    defaultBrowser,
    routedBrowser: target && target.ws ? target.name : null,
    targetError: target && target.error ? target.error : null,
    drivingPaused,
    evaluateAllowed: policy.allowEvaluate,
    consentDefault: relay.consentDefault(),
    activeOrigin: origin || null,
    // Effective decision for activeOrigin: an explicit row ('allow'|'readonly'|
    // 'block') or the mode-bound default ('allow'|'prompt'|'readonly'); null when
    // no active-tab origin is known yet.
    consent: consentMode,
    readonly: consentMode === 'readonly',
    hint: [
      drivingPaused
        ? 'Driving is PAUSED by the user (FastLink extension popup → Resume to continue). All browser tools are refused until then.'
        : connected
        ? `Connected — this connection drives the browser "${target.name}". fast_snapshot / fast_click / fast_fill etc. work on its active tab.`
        : target?.error
        || 'No extension is connected to your relay. If you are running Claude Code on your own machine you are likely on the WRONG connector — prefer the LOCAL "fastlink" connector (local broker, no pairing/token/OAuth). To actually use the relay: open the FastLink extension, set it to "relay" mode and pair it (paste your code from the relay site), then retry. (FASTLINK_TOKEN is unrelated and not the fix.)',
      // Only nag about targeting when the choice actually matters.
      liveNames.length > 1 && sel.mode === 'auto'
        ? `${liveNames.length} browsers are connected (${liveNames.join(', ')}) and this connection is on AUTO (most recently connected wins). Call fast_profile install:"<name>" to pin one.`
        : '',
    ].filter(Boolean).join(' '),
  };
}

// fast_batch: the runner (every step runs, ifFound branches, one snapshot, BUG-2
// nav settle) is src/batch.js, mirrored from fast-dxt/server/batch.js. The relay
// wires its per-step gates (diagnostic-only, evaluate policy, origin consent)
// and audit into the hooks.
const batchIo = (relay, ws) => ({
  gate: async (step) => {
    if (DIAGNOSTIC_ONLY.has(step.name)) return { error: `"${step.name}" is a diagnostic/deferred tool (not allowed as a batch step)` };
    if (step.name === 'fast_evaluate') {
      const verdict = await relay.checkEvalAllowed(ws);
      if (!verdict.ok) return { error: verdict.error };
    }
    return consentVerdict(relay, step.name, ws);
  },
  call: async (name, args) => {
    const r = await relay.callExtension(name, args || {}, undefined, ws);
    const probe = name === 'fast_list' || (name === 'fast_evaluate' && args && args.fn === '() => document.readyState');
    if (!probe) relay.audit(name, args, !(r && r.error)); // best-effort
    return r;
  },
});
