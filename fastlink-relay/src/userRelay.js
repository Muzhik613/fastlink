// src/userRelay.js — the per-user Durable Object (relay-core)
//
// One UserRelay instance per userId (the DO name IS the userId). It is the
// meeting point between the two transports:
//   • '/__mcp'  — an MCP JSON-RPC POST forwarded from FastlinkApiHandler. Handled
//                 by mcp.js, which calls back into this.callExtension(...) for
//                 each browser primitive.
//   • '/__ext'  — the extension's outbound WebSocket upgrade, forwarded from
//                 auth.js after the device token resolved to THIS user. The DO is
//                 the WS *server* and accepts the socket *hibernatably*.
//
// WebSocket Hibernation is the cost model: while a paired browser is idle the WS
// stays open but the DO is evicted from memory (no duration billing). Pings are
// answered by setWebSocketAutoResponse WITHOUT waking the DO. A real tool call
// wakes it (the runtime delivers the frame to webSocketMessage), it does its
// work, then goes idle again.
//
// Protocol on the ext WS (docs/PIN-REDESIGN.md §2):
//   relay → ext :  { type:'call',    id, action, args }   (args.tabId passed through; `browser` stripped)
//   ext → relay :  { type:'queued',  id, position }       optional: waiting behind another call on that tab
//                  { type:'started', id }                 the call left the queue and runs
//                  { type:'result',  id, origin, tabId, ...reply }   reply = {result} | {error,...extras}
//   keepalive   :  ext sends {"ping":true} → DO auto-responds {"pong":true}
// A result is matched by id on ANY live socket of the device the call went to
// (the extension answers on its current socket, which may be a redial).
//
// See SPEC.md §3d.

import { DurableObject } from 'cloudflare:workers';
import { handleMcpRequest } from './mcp.js';
import { readTrace } from './timing.js';
import { getUserDevices, renameDevice, maskToken, sanitizeDeviceName, RESERVED_DEVICE_NAMES } from './db.js';

// Call deadlines: 30 s from send; a {type:'queued'} frame extends the deadline to
// QUEUE_MAX_MS after send; {type:'started'} resets it to 30 s from that moment.
// An extension that sends neither frame gets the plain 30 s.
const REQUEST_TIMEOUT_MS = 30_000;
const QUEUE_MAX_MS = 120_000;
// After a socket closes, its in-flight calls wait this long for the redialed
// socket to deliver their result before failing.
const CLOSE_GRACE_MS = 10_000;
// D1 device rows are cached in memory between calls so named routing costs no
// extra round-trip on the hot path. Explicitly invalidated on rename and whenever
// a live socket presents a token the cache doesn't know (a browser paired since
// the last read), so the TTL is only a backstop against out-of-band D1 edits.
const DEVICE_CACHE_TTL_MS = 60_000;

// Shown when the account has no live browser at all (nothing to target).
const NO_DEVICE_ERROR =
  'No browser is paired to this FastLink account, so there is no tab to drive. '
  + 'Open the FastLink extension and pair it (paste a code from https://relay.ytx.app/pair/new), then retry.';

// Never raise Chrome unless the caller asks (owner, 2026-10-08: "my cursor always ends up in
// chrome"). fast_tab opens in the background and fast_switch only pins, unless the call says
// background:false / focus:true. Reads, clicks and screenshots all work on a pinned background
// tab, so the default costs nothing. Every path (single tools and batch steps) goes through
// callExtension, so this is the one place.
function quietFocus(action, args) {
  if (action === 'fast_tab' && (!args || args.background === undefined)) return { ...(args || {}), background: true };
  if (action === 'fast_switch' && (!args || args.focus === undefined)) return { ...(args || {}), focus: false };
  return args;
}

// Origin cache key: one entry per (browser device, tab). `tabId` null = that
// browser's current target tab.
const TARGET_MOVERS = new Set(['fast_tab', 'fast_switch', 'fast_close']);
const originKey = (deviceToken, tabId) => `${deviceToken}#${tabId == null ? 'target' : tabId}`;

// The extension pings every 20 s; three missed pings = the socket is dead.
export const STALE_SOCKET_MS = 60_000;

// Per-call tabId is honoured from this extension version on (PIN-REDESIGN §3).
export const TABID_MIN_VERSION = '0.4.8';
const NATIVE_TAB_ACTIONS = new Set(['fast_switch', 'fast_close']);
// The version the extension announced in its hello on this socket ('' if none yet).
function extVersion(ws) {
  try { return String((ws.deserializeAttachment() || {}).version || ''); } catch { return ''; }
}
// true when `v` (x.y.z) >= TABID_MIN_VERSION; unknown/garbled → false (fail safe).
export function supportsTabId(v) {
  const p = (x) => String(x).split('.').map((n) => parseInt(n, 10));
  const a = p(v), b = p(TABID_MIN_VERSION);
  if (!v || a.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
  return true;
}

export class UserRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    // mcpCallId -> { resolve, timer, grace, ws, deviceToken, sentAt, timeoutMs }.
    // In-memory and short-lived: an entry
    // only exists while an MCP tools/call is awaiting the browser. See the
    // "Hibernation × pending map" note in SPEC.md §3d — the DO cannot hibernate
    // while a call is in flight (the /__mcp fetch promise is awaiting), so the
    // map is never lost mid-call; when fully idle there is nothing pending.
    this.pending = new Map();
    // Best-effort identity label for status/audit (set from the forwarded
    // X-Fastlink-User-Id header on /__mcp). NOT used for isolation.
    this.userId = null;
    // deviceToken -> origin of the tab that device last acted on (SIGNUP-SPEC §5.2).
    // The extension stamps `origin` on each result frame; caching it PER DEVICE
    // lets the consent gate (M4), the eval allowlist, and audit read the TARGET
    // browser's origin without an extra fast_list round-trip — one browser's page
    // never stands in for another's. Falls back to a fast_list probe on a miss.
    this.origins = new Map();
    // N2 kill-switch (SAFETY): "Stop driving" pause state. Lazy in-memory cache of
    // the DURABLE flag in ctx.storage — it MUST be durable because the DO hibernates
    // between tool calls and would otherwise forget a pause. undefined = not yet read.
    this._paused = undefined;
    // Cached D1 device rows for named targeting: { at, rows:[{deviceToken,name,…}] }.
    // Rebuilt after a hibernation wake (D1 is the source of truth for names).
    this._devices = null;

    // Answer ext keepalive pings without waking the DO from hibernation. The
    // match is an EXACT string compare, so the extension's relay ping frame must
    // be byte-for-byte '{"ping":true}' (same payload as the local broker uses).
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"ping":true}', '{"pong":true}'),
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    // Remember the caller's userId for status/audit (best-effort).
    const hdrUser = request.headers.get('X-Fastlink-User-Id');
    if (hdrUser) this.userId = hdrUser;

    if (url.pathname === '/__ext') return this.#acceptExtension(request);
    if (url.pathname === '/__mcp') return handleMcpRequest(request, this);
    if (url.pathname === '/__revoke') return this.#revokeDevice(request);
    // Named-browser management for the extension options page. Reached only via
    // auth.js's device-token-authed /devices, which resolves the token to THIS
    // user before forwarding — the DO never sees an unauthenticated request and
    // never takes a userId from a request parameter.
    if (url.pathname === '/__devices') return this.#devicesRequest(request);
    // Per-session tool-call timing trace (src/timing.js). Only reachable via
    // auth.js's device-token-authed /trace, which resolves the token to THIS user
    // before forwarding — the DO never sees an unauthenticated trace read.
    if (url.pathname === '/__trace') {
      const body = await readTrace(this, url);
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }

  // --- extension WebSocket (hibernatable server side) -----------------------

  // MULTI-DEVICE (SPEC §3d): a user may pair several browsers; ALL attach to this
  // same DO under the 'ext' tag and stay connected. We do NOT close older sockets
  // — closing one would drop that user's other browser. Each socket is stamped
  // (connectedAt + its device token) via serializeAttachment so the stamp survives
  // hibernation; the device token is what makes a socket ADDRESSABLE by name
  // (token → devices.label in D1), and it is also what a targeted revoke matches.
  #acceptExtension(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }
    const token = new URL(request.url).searchParams.get('token') || null;
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ['ext']); // tag 'ext' survives hibernation
    try { server.serializeAttachment({ connectedAt: Date.now(), deviceToken: token }); } catch { /* non-fatal */ }
    return new Response(null, { status: 101, webSocket: client });
  }

  // Merge into a socket's hibernation-surviving attachment. serializeAttachment
  // REPLACES the whole value, so anything writing to it must merge — otherwise a
  // later write (e.g. the `hello` diagnostics) would erase the deviceToken stamp
  // and make the socket unroutable-by-name and un-revokable.
  #stamp(ws, patch) {
    let cur = {};
    try { cur = ws.deserializeAttachment() || {}; } catch { /* unstamped */ }
    try { ws.serializeAttachment({ ...cur, ...patch }); } catch { /* non-fatal */ }
  }

  // Every LIVE extension socket with its identity stamp:
  // [{ ws, at: connectedAt, token: deviceToken }]. A half-dead socket left over
  // from an MV3 service-worker death is filtered out by readyState; a same-device
  // redial appears as a second entry with a newer `at`.
  //
  // LIVENESS (11-06): a socket can stay OPEN here long after its browser is gone (a
  // force-killed Chrome, a profile whose window was closed) and every call to it then
  // times out. The extension pings every 20 s and the runtime answers without waking
  // us, but it records WHEN it last answered. A socket with no ping for STALE_SOCKET_MS
  // is dead: it is closed (its pending calls fail fast) and never routed to. The
  // extension's own watchdog reconnects when it is still alive.
  #liveSockets() {
    const out = [];
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets('ext')) {
      if (ws.readyState !== 1) continue; // WebSocket.OPEN
      let a = {};
      try { a = ws.deserializeAttachment() || {}; } catch { /* unstamped */ }
      const seen = Math.max(a.connectedAt || 0, this.#lastPing(ws));
      if (now - seen > STALE_SOCKET_MS) {
        try { ws.close(1011, 'no keepalive'); } catch { /* already closing */ }
        for (const [id, e] of this.pending) if (e.ws === ws) this.#settle(id, { error: 'The browser stopped answering (no keepalive), so the relay disconnected it. It reconnects by itself when it is still running.' });
        continue;
      }
      out.push({ ws, at: a.connectedAt || 0, token: a.deviceToken || null });
    }
    return out;
  }

  // ms timestamp of the runtime's last auto-answered ping on `ws` (0 = none yet).
  #lastPing(ws) {
    try { const t = this.ctx.getWebSocketAutoResponseTimestamp(ws); return t ? t.getTime() : 0; } catch { return 0; }
  }

  // Newest live socket carrying `token` (a redial supersedes its own stale socket).
  #socketForToken(token) {
    let best = null;
    for (const s of this.#liveSockets()) {
      if (s.token !== token) continue;
      if (!best || s.at >= best.at) best = s;
    }
    return best ? best.ws : null;
  }

  // How many extension browsers are currently paired+live to this user's DO.
  extSocketCount() {
    return this.#liveSockets().length;
  }

  // --- named browsers: D1 rows + live state ---------------------------------

  // Cached D1 device rows for this user (names are stored in D1, migration 0006).
  async #deviceRows(force = false) {
    if (!force && this._devices && Date.now() - this._devices.at < DEVICE_CACHE_TTL_MS) {
      return this._devices.rows;
    }
    let rows = [];
    try {
      if (this.env.DB && this.userId) rows = await getUserDevices(this.env.DB, this.userId);
    } catch { rows = this._devices ? this._devices.rows : []; }
    this._devices = { at: Date.now(), rows };
    return rows;
  }

  // THE view of this account's browsers: every non-revoked device with its name
  // and whether it has a live socket right now. fast_status, the options page and
  // the routing resolver all read this one function.
  async deviceList() {
    let rows = await this.#deviceRows();
    const live = this.#liveSockets();
    // A live socket whose token the cache doesn't know = a browser paired since
    // the last read. Refresh rather than render it as "unknown".
    if (live.some((s) => s.token && !rows.some((r) => r.deviceToken === s.token))) {
      rows = await this.#deviceRows(true);
    }
    const newestByToken = new Map();
    for (const s of live) {
      const cur = newestByToken.get(s.token);
      if (!cur || s.at >= cur.at) newestByToken.set(s.token, s);
    }
    return rows.map((r) => ({
      name: r.name,
      deviceToken: r.deviceToken,
      connected: newestByToken.has(r.deviceToken),
      connectedAt: newestByToken.get(r.deviceToken)?.at || null,
      // FastLink extension version from that browser's hello (null when offline).
      version: newestByToken.has(r.deviceToken) ? (extVersion(newestByToken.get(r.deviceToken).ws) || null) : null,
      lastSeen: r.lastSeen,
    }));
  }

  // --- browser ROUTING (stateless) -------------------------------------------
  //
  // Which browser a call drives is decided per request; the relay stores NO
  // selection and NO account default (Yaakov 11-06, docs/PIN-REDESIGN.md §1):
  //   1. `browser` named → that browser (hard: offline/unknown is an error).
  //   2. none named, exactly ONE of the account's browsers online → it.
  //   3. several online → `lastBrowser` (a hint the helper sends: the browser
  //      this session/machine used most recently) if it is online.
  //   4. else a clear error listing the online browsers. Never a guess.
  // claude.ai / Grok send no hint, so for them it's rule 2 or name one.
  // Returns { ws, name, deviceToken } | { error, ...diagnostics }.
  async resolveTarget(browser, lastBrowser = null) {
    const devices = await this.deviceList();
    const names = devices.map((d) => d.name);
    const online = devices.filter((d) => d.connected);
    const connectedNames = online.map((d) => d.name);
    const diag = { browsers: names, connected: connectedNames };
    const pick = (dev) => ({ ws: this.#socketForToken(dev.deviceToken), name: dev.name, deviceToken: dev.deviceToken });

    const given = browser !== undefined && browser !== null && browser !== '';
    if (!given) {
      if (!online.length) return { error: NO_DEVICE_ERROR, noDeviceConnected: true, ...diag };
      if (online.length === 1) return pick(online[0]);
      const hint = lastBrowser ? sanitizeDeviceName(String(lastBrowser)) : '';
      const last = hint && online.find((d) => d.name === hint);
      if (last) return pick(last);
      return {
        error: `Several browsers are online (${connectedNames.join(', ')}) and none was named, so nothing was done. `
          + 'Pass `browser` with one of those names (in Claude Code: fast_profile picks one for this session).',
        browserNotChosen: true, ...diag,
      };
    }
    const want = sanitizeDeviceName(String(browser));
    if (!want || RESERVED_DEVICE_NAMES.has(want)) {
      return {
        error: `Invalid browser name "${browser}". Online browsers: ${connectedNames.join(', ') || '(none)'}. Pass one of those as \`browser\`.`,
        invalidBrowser: true, ...diag,
      };
    }
    const dev = devices.find((d) => d.name === want);
    if (!dev) {
      return {
        error: `No browser named "${want}" is paired to this account. `
          + `Paired browsers: ${names.join(', ') || '(none)'}; online: ${connectedNames.join(', ') || '(none)'}.`,
        wrongBrowser: true, selected: want, ...diag,
      };
    }
    if (!dev.connected) {
      return {
        error: `Browser "${want}" is not connected right now, so nothing was done. `
          + `Online now: ${connectedNames.join(', ') || '(none)'}. `
          + 'Open Chrome in that profile so FastLink reconnects, or pass `browser` with an online name.',
        deviceNotConnected: true, selected: want, ...diag,
      };
    }
    return pick(dev);
  }

  // --- device management (options page, via auth.js /devices) ---------------

  // GET  → { devices:[{name,connected,lastSeen,deviceToken(masked),self}], self }
  // POST { name }               → rename THIS device (the token that authed)
  async #devicesRequest(request) {
    const token = request.headers.get('X-Fastlink-Device-Token') || '';
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { return reply({ error: 'invalid_json' }, 400); }
      const res = await renameDevice(this.env.DB, this.userId, token, body.name);
      if (!res.ok) return reply({ error: res.error }, res.error === 'unknown_device' ? 404 : 400);
      this._devices = null; // names changed → drop the cache
    } else if (request.method !== 'GET') {
      return reply({ error: 'method_not_allowed' }, 405);
    }

    const devices = await this.deviceList();
    const self = devices.find((d) => d.deviceToken === token) || null;
    return reply({
      self: self ? self.name : null,
      devices: devices.map((d) => ({
        name: d.name,
        connected: d.connected,
        lastSeen: d.lastSeen,
        self: d.deviceToken === token,
        deviceToken: maskToken(d.deviceToken),
      })),
    });
  }

  // Targeted revoke (SPEC §7 + extension 4401 contract): oauth's revokeDevice
  // POSTs here with ?token=<deviceToken> after marking it revoked in D1. We close
  // the matching live socket(s) with code 4401 so the extension clears its stored
  // token and shows the re-pair UI (any other close code = ordinary drop →
  // reconnect). A *cold* revoke (token already offline) can't be signalled this
  // way — that's an accepted browser limitation (the next upgrade 401s → 1006).
  async #revokeDevice(request) {
    const token = new URL(request.url).searchParams.get('token');
    let closed = 0;
    if (token) {
      for (const ws of this.ctx.getWebSockets('ext')) {
        let dt = null;
        try { dt = (ws.deserializeAttachment() || {}).deviceToken; } catch { /* unstamped */ }
        if (dt === token) { try { ws.close(4401, 'device token revoked'); } catch {} closed++; }
      }
    }
    return new Response(JSON.stringify({ closed }), { headers: { 'content-type': 'application/json' } });
  }

  // Runtime delivers ext frames here (waking the DO from hibernation as needed).
  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return; // ignore non-JSON
    }

    if (msg.type === 'result' || msg.type === 'queued' || msg.type === 'started') {
      const entry = this.pending.get(msg.id);
      if (!entry) return; // unknown/late id — settled already
      // Matched by id on ANY socket of the device the call went to (the extension
      // answers on its current live socket, which may be a redial). A frame from a
      // different browser can never settle this call.
      if (this.#tokenOf(ws) !== entry.deviceToken) return;

      if (msg.type === 'queued') {
        this.#arm(msg.id, entry, entry.sentAt + Math.max(QUEUE_MAX_MS, entry.timeoutMs));
        return;
      }
      if (msg.type === 'started') {
        this.#arm(msg.id, entry, Date.now() + entry.timeoutMs);
        return;
      }
      // SIGNUP-SPEC §5.2: the extension stamps the acted-on tab's origin on each
      // result. Cache it for THAT device (consent gate / eval check / audit).
      if (typeof msg.origin === 'string' && msg.origin && entry.deviceToken) {
        this.origins.set(originKey(entry.deviceToken, entry.tabKey), msg.origin);
        if (msg.tabId != null) this.origins.set(originKey(entry.deviceToken, msg.tabId), msg.origin);
      }
      // Tab actions can move the browser's target tab: forget its cached origin so
      // the next untargeted call re-reads it instead of gating on the old page.
      if (TARGET_MOVERS.has(entry.action) && entry.deviceToken) this.origins.delete(originKey(entry.deviceToken, null));
      // Strip the routing envelope (origin too); `tabId` stays in the reply so the
      // MCP layer can surface which tab was acted on.
      const { type, id, origin, ...reply } = msg;
      this.#settle(msg.id, reply);
      return;
    }

    if (msg.type === 'hello') {
      // Diagnostics only. MERGE (never replace) — the attachment also carries the
      // connectedAt/deviceToken identity stamp that named routing and targeted
      // revoke depend on.
      this.#stamp(ws, { installId: msg.installId, version: msg.version });
      // The extension re-asserts the user's pause toggle on (re)connect when it
      // carries one, so the durable relay flag converges with the popup's state.
      if (typeof msg.drivingPaused === 'boolean') {
        try { await this.setDrivingPaused(msg.drivingPaused); } catch { /* non-fatal */ }
      }
      return;
    }

    // N2 kill-switch (SAFETY): the user toggled "Stop / Resume driving" in the
    // extension popup. Human-only — there is NO MCP tool to un-pause, so a
    // prompt-injection can't resume it. Persisted durably (survives hibernation).
    // Tolerant of both frame shapes: the canonical event envelope
    // {type:'event', event:'driving_paused'} (sendRelayEvent wraps payloads as
    // {type:'event',...}) AND a bare {type:'driving_paused'}.
    const evt = msg.type === 'event' ? msg.event : msg.type;
    if (evt === 'driving_paused' || evt === 'driving_resumed') {
      try { await this.setDrivingPaused(evt === 'driving_paused'); } catch { /* non-fatal */ }
      return;
    }

    // {type:'pong'} and any other event are ignored. The {"ping":true} keepalive
    // never reaches here — it's handled by the auto-response pair without waking
    // the DO.
  }

  async webSocketClose(ws) {
    this.#graceOnClose(ws);
  }

  async webSocketError(ws) {
    this.#graceOnClose(ws);
  }

  // The socket a call went out on died. Its result may still arrive on the
  // device's redialed socket, so give each such call CLOSE_GRACE_MS before failing it.
  #graceOnClose(ws) {
    for (const [id, entry] of this.pending) {
      if (entry.ws !== ws || entry.grace) continue;
      entry.grace = setTimeout(() => this.#settle(id, { error: 'Extension disconnected before response' }), CLOSE_GRACE_MS);
    }
  }

  // (Re)arm a pending call's deadline to the absolute time `at`.
  #arm(id, entry, at) {
    clearTimeout(entry.timer);
    const ms = Math.max(0, at - Date.now());
    entry.timer = setTimeout(() => this.#settle(id, { error: `Timeout waiting for browser response (${ms}ms)` }), ms);
  }

  // Resolve a pending call exactly once and drop its timers.
  #settle(id, reply) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    clearTimeout(entry.grace);
    entry.resolve(reply);
  }

  #tokenOf(ws) {
    try { return (ws.deserializeAttachment() || {}).deviceToken || null; } catch { return null; }
  }

  // --- the call primitive mcp.js builds on ----------------------------------

  // Push {type:'call'} to the target browser and await the matching
  // {type:'result'}. UUID-keyed pending map; deadline 30 s, extended by
  // queued/started frames (see #arm). Never rejects — failures resolve to an
  // {error} payload so the MCP layer can surface them as a tool result.
  //
  // `target` ({ws, deviceToken} from resolveTarget) is REQUIRED and is resolved
  // ONCE per MCP request, so every sub-step of a multi-step tool (batch, nav
  // settle) lands on the SAME browser. `browser` is routing-only and is stripped;
  // `tabId` passes through to the extension.
  callExtension(action, args, timeoutMs = REQUEST_TIMEOUT_MS, target = null) {
    const { browser, ...rest } = quietFocus(action, args) || {};
    const ws = target && target.ws;
    if (!ws || ws.readyState !== 1) return Promise.resolve({
      error: NO_DEVICE_ERROR,
      noDeviceConnected: true,
    });
    // SAFETY (11-06): extensions before 0.4.8 ignore a per-call tabId and act on
    // whatever tab is current. A call that names a tab must never land on another
    // one, so it is refused for those browsers (unknown version = refused too).
    // fast_switch / fast_close always honoured their own tabId argument.
    if (typeof rest.tabId === 'number' && !NATIVE_TAB_ACTIONS.has(action) && !supportsTabId(extVersion(ws))) {
      const v = extVersion(ws) || 'an unknown version';
      return Promise.resolve({
        error: `Browser "${target.name || '?'}" runs FastLink ${v}, which can't act on a specific tab (needs ${TABID_MIN_VERSION} or newer), so "${action}" was not run. Reload the FastLink extension in that browser (click its toolbar icon) to load the update, then retry.`,
        extensionTooOld: true,
        extensionVersion: extVersion(ws) || null,
      });
    }
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      // tabKey: which tab's origin this result reports — the call's own tabId, else
      // the browser's current target tab.
      const tabKey = typeof rest.tabId === 'number' ? rest.tabId : null;
      const entry = { resolve, timer: null, grace: null, ws, deviceToken: target.deviceToken || null, tabKey, action, sentAt: Date.now(), timeoutMs };
      this.pending.set(id, entry);
      this.#arm(id, entry, entry.sentAt + timeoutMs);
      try {
        ws.send(JSON.stringify({ type: 'call', id, action, args: rest }));
      } catch (e) {
        this.#settle(id, { error: `Send to extension failed: ${e.message}` });
      }
    });
  }

  // --- SAFETY hooks (SPEC.md §7) --------------------------------------------

  // fast_evaluate is high-risk (arbitrary in-page JS). ALLOWLIST gate (SPEC §7/§12):
  // resolve the user's eval policy, then allow only when enabled AND (operator
  // test allow-all OR the active tab's origin is explicitly allowlisted).
  //
  // Policy shape (from db.getEvalPolicy): { allowEvaluate, allowAll, isOperator,
  // origins:[...] }. Without D1/userId (v1 test loop), fall back to the
  // ALLOW_EVALUATE env flag treated as operator allow-all.
  async evalPolicy() {
    try {
      if (this.env.DB && this.userId) {
        const { getEvalPolicy } = await import('./db.js');
        if (typeof getEvalPolicy === 'function') {
          const p = await getEvalPolicy(this.env.DB, this.userId);
          if (p) return { allowEvaluate: !!p.allowEvaluate, allowAll: !!p.allowAll, isOperator: !!p.isOperator, origins: Array.isArray(p.origins) ? p.origins : [] };
        }
      }
    } catch { /* fall through to env default */ }
    const v = this.env.ALLOW_EVALUATE;
    const on = v === 'true' || v === '1' || v === true;
    return { allowEvaluate: on, allowAll: on, isOperator: on, origins: [] };
  }

  // Resolve {ok} | {ok:false,error} for a fast_evaluate attempt. Reads the active
  // tab's origin (cheap fast_list, no debugger attach) only when needed to check
  // the allowlist.
  async checkEvalAllowed(target, tabId = null) {
    const p = await this.evalPolicy();
    if (!p.allowEvaluate) {
      return { ok: false, error: 'fast_evaluate is disabled for this account — enable it in relay settings (high-risk: it runs arbitrary JavaScript in your page).' };
    }
    if (p.allowAll) return { ok: true };
    // The origin of the EXACT tab the call acts on. Unknown = denied (fail closed).
    const origin = await this.currentOrigin(target, tabId);
    if (origin && p.origins.includes(origin)) return { ok: true, origin };
    return { ok: false, error: `fast_evaluate is disabled for this site — enable it and allowlist this origin (${origin || 'unknown'}) in relay settings.` };
  }

  // Last-known origin of ONE tab on the target browser: `tabId`, or (null) the
  // browser's current target tab. Cached per (device, tab) from result frames
  // (SIGNUP-SPEC §5.2). '' when nothing is cached yet.
  cachedOrigin(target, tabId = null) {
    if (!target || !target.deviceToken) return '';
    return this.origins.get(originKey(target.deviceToken, tabId)) || '';
  }

  // That tab's origin: the cache, else a fast_list probe on THAT browser.
  // '' if it truly can't be determined (callers fail closed where it matters).
  async currentOrigin(target, tabId = null) {
    const cached = this.cachedOrigin(target, tabId);
    if (cached) return cached;
    const o = await this.activeOrigin(target, tabId);
    if (o && target?.deviceToken) this.origins.set(originKey(target.deviceToken, tabId), o);
    return o;
  }

  // A tab's origin via a cheap fast_list (no CDP/debugger attach → no banner
  // flicker): the tab with id `tabId`, else the extension's target tab, else the
  // active one.
  async activeOrigin(target, tabId = null) {
    try {
      const r = await this.callExtension('fast_list', {}, REQUEST_TIMEOUT_MS, target);
      const tabs = r?.result;
      const t = !Array.isArray(tabs) ? null
        : tabId != null ? tabs.find((x) => x.id === tabId)
        : (tabs.find((x) => x.targetTab) || tabs.find((x) => x.active));
      if (t?.url) { try { return new URL(t.url).origin; } catch {} }
    } catch { /* ignore */ }
    return '';
  }

  // --- per-origin consent (M4 / SIGNUP-SPEC §4.2, §5.2) ---------------------

  // The default decision for an origin with NO stored consent row, bound to the
  // identity mode unless CONSENT_DEFAULT overrides it:
  //   shared/operator ⇒ 'allow'  (single trusted user — current behavior)
  //   magic           ⇒ 'prompt' (multi-user — first-touch approval required)
  // 'readonly' is also accepted (silent read-only default, no prompt affordance).
  consentDefault() {
    const raw = String(this.env.CONSENT_DEFAULT || '').toLowerCase();
    if (raw === 'allow' || raw === 'prompt' || raw === 'readonly') return raw;
    return this.#identityMode() === 'magic' ? 'prompt' : 'allow';
  }

  // Resolve the effective consent for an origin: an explicit stored row
  // ('allow'|'readonly'|'block') wins; otherwise the mode-bound default
  // ('allow'|'prompt'|'readonly'). Best-effort — falls back to the default on any
  // DB error or when identity/DB are absent (v1 test loop).
  async consentFor(origin) {
    if (origin && this.env.DB && this.userId) {
      try {
        const { getSiteConsent } = await import('./db.js');
        const mode = await getSiteConsent(this.env.DB, this.userId, origin);
        if (mode === 'allow' || mode === 'readonly' || mode === 'block') return mode;
      } catch { /* fall through to default */ }
    }
    return this.consentDefault();
  }

  // --- N2 kill-switch: "Stop driving" pause (SAFETY) ------------------------

  // Is driving paused? Reads the durable flag (cached in-memory after first read;
  // the cache is rebuilt after a hibernation wake). Fail-safe: on a storage error
  // returns the last-known value (defaulting to NOT paused).
  async isDrivingPaused() {
    if (this._paused === undefined) {
      try { this._paused = !!(await this.ctx.storage.get('drivingPaused')); }
      catch { this._paused = false; }
    }
    return this._paused;
  }

  // Set + persist the pause flag (human-initiated via the extension popup).
  async setDrivingPaused(paused) {
    this._paused = !!paused;
    try { await this.ctx.storage.put('drivingPaused', this._paused); } catch { /* non-fatal: in-memory cache still gates this warm DO */ }
  }

  // Best-effort push of an out-of-band frame to the TARGET extension socket (e.g.
  // a {type:'consent_required',...} prompt so the toolbar popup can surface Allow
  // / Read-only / Block without waiting for the user to look at Claude). The
  // prompt must land in the browser the call was aimed at — not "whichever
  // connected last". Never throws into the call path.
  notifyExtension(obj, target) {
    const ws = target && target.ws;
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch { /* non-fatal */ }
  }

  // IDENTITY_MODE reader (mirrors auth.js identityMode; kept local so the DO stays
  // decoupled from the auth handler module). 'magiclink' is an alias of 'magic'.
  #identityMode() {
    const raw = this.env.IDENTITY_MODE || (this.env.UPSTREAM_OAUTH_CLIENT_ID ? 'google' : 'shared');
    return raw === 'magiclink' ? 'magic' : raw;
  }

  // Append-only audit of every tool call. Best-effort: a no-op until oauth's
  // db.js + the DB binding exist, so the v1 test loop runs without D1. Never
  // throws into the call path.
  async audit(action, args, ok, target = null) {
    try {
      if (!this.env.DB || !this.userId) return;
      const { logAudit } = await import('./db.js');
      // Log argument KEYS only, never their values (could carry secrets/PII).
      // Include the active-tab origin (T4) so the log answers "what, and where".
      const detail = JSON.stringify({ args: Object.keys(args || {}), browser: target?.name || null, origin: this.cachedOrigin(target, typeof args?.tabId === 'number' ? args.tabId : null) || null, ok: !!ok });
      await logAudit(this.env.DB, this.userId, action, detail);
    } catch { /* auditing must never break a tool call */ }
  }
}
