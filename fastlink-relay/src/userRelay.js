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
// Protocol on the ext WS (mirrors fast-dxt/broker/router.js):
//   relay → ext :  { type:'call',   id, action, args }
//   ext → relay :  { type:'result', id, ...reply }   reply = {result} | {error,...extras}
//   keepalive   :  ext sends {"ping":true} → DO auto-responds {"pong":true}
//
// See SPEC.md §3d.

import { DurableObject } from 'cloudflare:workers';
import { handleMcpRequest } from './mcp.js';
import { readTrace, fingerprint, tokenKey } from './timing.js';
import { getUserDevices, renameDevice, maskToken } from './db.js';

const REQUEST_TIMEOUT_MS = 30_000;
// D1 device rows are cached in memory between calls so named routing costs no
// extra round-trip on the hot path. Explicitly invalidated on rename and whenever
// a live socket presents a token the cache doesn't know (a browser paired since
// the last read), so the TTL is only a backstop against out-of-band D1 edits.
const DEVICE_CACHE_TTL_MS = 60_000;
// Storage sentinel for "this client explicitly chose auto" — distinct from "this
// client has never chosen", which falls through to the per-user default.
// 'auto' can never be a device NAME (db.RESERVED_DEVICE_NAMES), so no ambiguity.
const AUTO = 'auto';

// Shown when the account has no live browser at all (nothing to target).
const NO_DEVICE_ERROR =
  'No browser is paired to this relay account, so the cloud relay cannot reach a tab. '
  + 'If you are running Claude Code on your own machine, you are probably on the WRONG connector: '
  + 'use the LOCAL "fastlink" connector instead — it drives the browser directly through the local broker with no pairing, token, or OAuth. '
  + 'Only if you intend to use the cloud relay: open the FastLink extension, set it to "relay" mode, and pair it (paste your code from the relay site). '
  + 'Note: FASTLINK_TOKEN is unrelated and is NOT the fix.';

export class UserRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    // mcpCallId -> { resolve, timer, ws }. In-memory and short-lived: an entry
    // only exists while an MCP tools/call is awaiting the browser. See the
    // "Hibernation × pending map" note in SPEC.md §3d — the DO cannot hibernate
    // while a call is in flight (the /__mcp fetch promise is awaiting), so the
    // map is never lost mid-call; when fully idle there is nothing pending.
    this.pending = new Map();
    // Best-effort identity label for status/audit (set from the forwarded
    // X-Fastlink-User-Id header on /__mcp). NOT used for isolation.
    this.userId = null;
    // Active-tab origin of the most recent extension result (SIGNUP-SPEC §5.2).
    // The extension stamps `origin` on each result frame; we cache it here so the
    // per-origin consent gate (M4), the eval allowlist, and audit can read the
    // current origin WITHOUT an extra fast_list round-trip. Falls back to a
    // fast_list probe (activeOrigin) until the extension stamping lands.
    this.lastOrigin = null;
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
  #liveSockets() {
    const out = [];
    for (const ws of this.ctx.getWebSockets('ext')) {
      if (ws.readyState !== 1) continue; // WebSocket.OPEN
      let a = {};
      try { a = ws.deserializeAttachment() || {}; } catch { /* unstamped */ }
      out.push({ ws, at: a.connectedAt || 0, token: a.deviceToken || null });
    }
    return out;
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
  // and whether it has a live socket right now. fast_status, fast_profile, the
  // options page and the routing resolver all read this one function.
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
      lastSeen: r.lastSeen,
    }));
  }

  // --- browser SELECTION (which browser a chat product drives) --------------
  //
  // WHY NOT PER-MCP-SESSION: measured on the live relay, Grok's connector opens a
  // BRAND-NEW MCP session (full `initialize`) for EVERY tool call — 11 sessions
  // for 11 calls. A session-scoped pin would evaporate before the next call and
  // the feature would appear to work with Claude while silently failing with Grok.
  // So the selection is DURABLE, lives in this user's DO storage (survives
  // hibernation), and is keyed by the CHAT PRODUCT — see clientKey().

  // Stable id for the chat product driving this DO. It must survive BOTH (a) a
  // fresh MCP session per call and (b) the hourly access-token refresh, so it
  // prefers the OAuth CLIENT id carried in the grant props (stamped at
  // completeAuthorization, forwarded by index.js as X-Fastlink-Client-Id) — that
  // is per-connector and constant across refreshes. Grants minted before the
  // stamp landed fall back to the bearer-token fingerprint (same primitive,
  // src/timing.js), which is still per-product, just shorter-lived.
  async clientKey(request) {
    const cid = request.headers.get('X-Fastlink-Client-Id');
    if (cid) return `c${await fingerprint(`client:${cid}`)}`;
    return `t${await tokenKey(request)}`;
  }

  #pinKey(clientKey) { return `dev:pin:${clientKey}`; }

  // Resolve what this client should drive:
  //   { mode:'pinned', name, source:'pin'|'default' } | { mode:'auto', source }
  async getSelection(clientKey) {
    let pin;
    try { pin = await this.ctx.storage.get(this.#pinKey(clientKey)); } catch { pin = undefined; }
    if (pin === AUTO) return { mode: 'auto', source: 'pin' };
    if (pin) return { mode: 'pinned', name: pin, source: 'pin' };
    let def;
    try { def = await this.ctx.storage.get('dev:default'); } catch { def = undefined; }
    if (def) return { mode: 'pinned', name: def, source: 'default' };
    return { mode: 'auto', source: 'unset' };
  }

  // Pin this client to a browser name, or to AUTO (null/'' → auto).
  async setSelection(clientKey, name) {
    await this.ctx.storage.put(this.#pinKey(clientKey), name || AUTO);
  }

  // The account-wide default browser — used by any chat product that never calls
  // fast_profile. null clears it (back to most-recent-wins).
  async getDefaultDevice() {
    try { return (await this.ctx.storage.get('dev:default')) || null; } catch { return null; }
  }

  async setDefaultDevice(name) {
    if (name) await this.ctx.storage.put('dev:default', name);
    else await this.ctx.storage.delete('dev:default');
  }

  // RESOLVE THE TARGET SOCKET for one MCP request. This REPLACES the old
  // most-recent-wins extSocket(): with several browsers on one account,
  // most-recent-wins silently flipped which browser got driven every time an MV3
  // service worker redialled. There is therefore NO fallback — a pin that cannot
  // be honoured is a hard, named error, not a redirect to some other browser.
  // Most-recent-wins survives ONLY as the explicit "auto" mode.
  // Returns { ws, name, mode } | { error, ...diagnostics }.
  async resolveTarget(clientKey) {
    const devices = await this.deviceList();
    const connected = devices.filter((d) => d.connected);
    const names = devices.map((d) => d.name);
    const connectedNames = connected.map((d) => d.name);
    const sel = await this.getSelection(clientKey);

    if (sel.mode === 'auto') {
      if (!connected.length) return { error: NO_DEVICE_ERROR, noDeviceConnected: true, browsers: names };
      const best = connected.reduce((a, b) => ((b.connectedAt || 0) >= (a.connectedAt || 0) ? b : a));
      return { ws: this.#socketForToken(best.deviceToken), name: best.name, mode: 'auto' };
    }

    const want = sel.name;
    const dev = devices.find((d) => d.name === want);
    const via = sel.source === 'default' ? 'the account default browser' : 'this connection\'s fast_profile pin';
    if (!dev) {
      return {
        error: `No browser named "${want}" is paired to this account (${via} points at it). `
          + `Paired browsers: ${names.join(', ') || '(none)'}. `
          + `Rename a browser on its FastLink options page, or call fast_profile with a listed name (or "auto").`,
        wrongBrowser: true, selected: want, browsers: names, connected: connectedNames,
      };
    }
    if (!dev.connected) {
      return {
        error: `Browser "${want}" is not connected right now (${via} targets it), so nothing was done. `
          + `Connected now: ${connectedNames.join(', ') || '(none)'}. `
          + `Open Chrome in that profile so FastLink reconnects, or call fast_profile install:"<one of the connected names>" — or install:"auto" for whichever connected last.`,
        deviceNotConnected: true, selected: want, browsers: names, connected: connectedNames,
      };
    }
    return { ws: this.#socketForToken(dev.deviceToken), name: want, mode: 'pinned', source: sel.source };
  }

  // Selections are stored BY NAME, so a rename must carry them over — the account
  // default AND every chat product pinned to the old name. Without this, renaming
  // a browser would break live pins with "no browser named …" for no reason the
  // user could connect to what they just did.
  async #followRename(oldName, newName) {
    if (await this.getDefaultDevice() === oldName) await this.setDefaultDevice(newName);
    let entries;
    try { entries = await this.ctx.storage.list({ prefix: 'dev:pin:' }); } catch { return; }
    for (const [k, v] of entries) {
      if (v === oldName) { try { await this.ctx.storage.put(k, newName); } catch { /* best-effort */ } }
    }
  }

  // --- device management (options page, via auth.js /devices) ---------------

  // GET  → { devices:[{name,connected,lastSeen,deviceToken(masked),self}], self, default }
  // POST { name }               → rename THIS device (the token that authed)
  // POST { makeDefault:bool }   → set/clear the account default to THIS device
  async #devicesRequest(request) {
    const token = request.headers.get('X-Fastlink-Device-Token') || '';
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch { return reply({ error: 'invalid_json' }, 400); }
      if (typeof body.makeDefault === 'boolean') {
        const rows = await this.#deviceRows(true);
        const me = rows.find((r) => r.deviceToken === token);
        if (!me) return reply({ error: 'unknown_device' }, 404);
        await this.setDefaultDevice(body.makeDefault ? me.name : null);
      } else {
        // The account default is stored BY NAME, so read the old name BEFORE the
        // rename: if this browser was the default, the default must follow it,
        // otherwise it would dangle at a name nothing owns and every client
        // relying on it would start erroring.
        const oldName = (await this.#deviceRows()).find((r) => r.deviceToken === token)?.name;
        const res = await renameDevice(this.env.DB, this.userId, token, body.name);
        if (!res.ok) return reply({ error: res.error }, res.error === 'unknown_device' ? 404 : 400);
        this._devices = null; // names changed → drop the cache
        if (oldName && oldName !== res.name) await this.#followRename(oldName, res.name);
      }
    } else if (request.method !== 'GET') {
      return reply({ error: 'method_not_allowed' }, 405);
    }

    const devices = await this.deviceList();
    const self = devices.find((d) => d.deviceToken === token) || null;
    return reply({
      self: self ? self.name : null,
      default: await this.getDefaultDevice(),
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

    if (msg.type === 'result') {
      const entry = this.pending.get(msg.id);
      if (!entry) return; // unknown/late id — timed out already
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      // SIGNUP-SPEC §5.2: the extension stamps the active-tab origin on each
      // result. Cache it for the consent gate / eval check / audit (fixes T3/T4).
      if (typeof msg.origin === 'string' && msg.origin) this.lastOrigin = msg.origin;
      // Strip the routing envelope (incl. origin); hand the reply ({result} |
      // {error,...extras}) back to the awaiting callExtension — same fields
      // handlers.js relies on.
      const { type, id, origin, ...reply } = msg;
      entry.resolve(reply);
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
    this.#failPending(ws, 'Extension disconnected before response');
  }

  async webSocketError(ws) {
    this.#failPending(ws, 'Extension socket error');
  }

  // Fail (only) the pending requests that were sent on `ws`. Requests already
  // re-issued on a fresh socket are tagged with that socket and untouched.
  #failPending(ws, message) {
    for (const [id, entry] of this.pending) {
      if (entry.ws !== ws) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({ error: message });
    }
  }

  // --- the call primitive mcp.js builds on ----------------------------------

  // Push {type:'call'} to the ext WS and await the matching {type:'result'}.
  // Mirrors fast-dxt/broker/router.js dispatchCall: UUID-keyed pending map, 30s
  // timeout, never rejects — failures resolve to an {error} payload so the MCP
  // layer can surface them as a tool result.
  //
  // `ws` is REQUIRED and names WHICH browser to drive. It is resolved ONCE per
  // MCP request by resolveTarget() and threaded down, so every sub-step of a
  // multi-step tool (batch, nav settle) lands on the SAME browser
  // even if another browser redials mid-call. There is deliberately no "pick a
  // socket here" fallback: that was the most-recent-wins bug.
  callExtension(action, args, timeoutMs = REQUEST_TIMEOUT_MS, ws = null) {
    if (!ws || ws.readyState !== 1) return Promise.resolve({
      error: NO_DEVICE_ERROR,
      noDeviceConnected: true,
    });
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ error: `Timeout waiting for browser response (${timeoutMs}ms)` });
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, ws });
      try {
        ws.send(JSON.stringify({ type: 'call', id, action, args: args || {} }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ error: `Send to extension failed: ${e.message}` });
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
  async checkEvalAllowed(ws) {
    const p = await this.evalPolicy();
    if (!p.allowEvaluate) {
      return { ok: false, error: 'fast_evaluate is disabled for this account — enable it in relay settings (high-risk: it runs arbitrary JavaScript in your page).' };
    }
    if (p.allowAll) return { ok: true };
    const origin = await this.currentOrigin(ws);
    if (origin && p.origins.includes(origin)) return { ok: true };
    return { ok: false, error: `fast_evaluate is disabled for this site — enable it and allowlist this origin (${origin || 'unknown'}) in relay settings.` };
  }

  // The active tab's origin. Prefers the cheap stamped cache (this.lastOrigin,
  // set from each result frame per SIGNUP-SPEC §5.2); falls back to a fast_list
  // probe on the TARGET browser. '' if it truly can't be determined.
  async currentOrigin(ws) {
    if (this.lastOrigin) return this.lastOrigin;
    const o = await this.activeOrigin(ws);
    if (o) this.lastOrigin = o;
    return o;
  }

  // The active tab's origin via a cheap fast_list (no CDP/debugger attach → no
  // banner flicker). '' if it can't be determined.
  async activeOrigin(ws) {
    try {
      const r = await this.callExtension('fast_list', {}, REQUEST_TIMEOUT_MS, ws);
      const tabs = r?.result;
      const active = Array.isArray(tabs) ? tabs.find((t) => t.active) : null;
      if (active?.url) { try { return new URL(active.url).origin; } catch {} }
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
  notifyExtension(obj, ws) {
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
  async audit(action, args, ok) {
    try {
      if (!this.env.DB || !this.userId) return;
      const { logAudit } = await import('./db.js');
      // Log argument KEYS only, never their values (could carry secrets/PII).
      // Include the active-tab origin (T4) so the log answers "what, and where".
      const detail = JSON.stringify({ args: Object.keys(args || {}), origin: this.lastOrigin || null, ok: !!ok });
      await logAudit(this.env.DB, this.userId, action, detail);
    } catch { /* auditing must never break a tool call */ }
  }
}
