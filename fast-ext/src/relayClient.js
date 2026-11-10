// relayClient.js — outbound WSS client to the FastLink cloud relay's /ext endpoint.
//
// The relay is FastLink's only transport: every client (claude.ai, Grok, the
// per-session fastlink helper for Claude Code) reaches this browser through it.
// The extension dials OUT over WSS to the relay's Durable Object, which is the
// WebSocket *server*; the extension is the *client*.
//
// Auth: a long-lived deviceToken (minted once via POST /pair/claim — see
// claimPairingCode below) is presented in the upgrade URL query string. Browsers
// cannot set custom headers on a WebSocket handshake, so the token rides the URL.
//
// Wire protocol (fastlink-relay/SPEC.md §3d, §5a):
//   inbound   {type:'call', id, action, args}   -> per-tab queue (tabQueue.js) -> dispatchAction
//   outbound  {type:'queued', id, position}     the call waits behind another on its tab
//             {type:'started', id}              the call left its queue and runs
//             {type:'result', id, origin, tabId, ...reply}  (reply = {result} | {error, ...extras}),
//             sent on the CURRENT live socket (replySender.js), held ≤10 s if none is open
//   keepalive: the ext SENDS {"ping":true} every 20s; the DO auto-responds
//              {"pong":true} WITHOUT waking from hibernation (exact string match
//              via setWebSocketAutoResponse). So the ping must be EXACTLY
//              {"ping":true} with no extra fields. Inbound {"pong":true} is ignored.
//   on open:  {type:'hello', version} — diagnostics only; auth is the URL token.
//   close 4401: device token rejected/revoked -> clear token, stop, prompt re-pair.
//
// Lifecycle: a 30s chrome.alarms tick survives MV3 service-worker death, plus
// capped exponential backoff for fast reconnects while alive.
// background.js registers the alarm/window listeners synchronously and delegates
// to the handlers returned by startRelayConnection (MV3 requires synchronous
// listener registration so a fired alarm can revive a dead worker).

import { createTabQueue } from './tabQueue.js';
import { createReplySender } from './replySender.js';
import { defaultBaseName } from './browserName.js';
import { initCallHooks, whenReady, helloFields, runCall } from './callHooks.js';

// The target-tab resolver background.js passes in (the same one every call uses).
let resolveTarget = async () => null;
initCallHooks(() => { if (socket && socket.readyState === WebSocket.OPEN) sendHello(socket); });

function sendHello(ws) {
  try { ws.send(JSON.stringify({ type: 'hello', version: VERSION, drivingPaused, ...helloFields() })); } catch {}
}

const RECONNECT_ALARM = 'fastlink-relay-reconnect';
const PING_MS = 20_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
// A socket stuck in CONNECTING this long never completed the upgrade — recycle
// it instead of letting the connect()-guard treat the zombie as "connecting".
const CONNECT_TIMEOUT_MS = 12_000;
// The relay DO auto-responds {pong:true} to every {ping:true}, so a live socket
// yields inbound traffic at least every PING_MS. Silence past this → half-open
// path (network blip / DO recycle without a clean close) → recycle and redial.
const STALE_MS = 50_000;
const AUTH_FAIL_CODE = 4401;   // relay closes with this when the device token is rejected/revoked
const DEFAULT_RELAY_BASE = 'https://relay.ytx.app';

// Redact the device token from any string we log. The token rides the wss URL
// query (`?token=…`) because browsers can't set Authorization headers on a WS
// handshake. NEVER print the raw token: route every URL/diagnostic string that
// could contain it through redact() first. Shows at most the first 4 chars so a
// log is still useful for telling two tokens apart while leaking nothing usable.
// (Note: the browser's OWN "WebSocket connection failed" console error still
// prints the full handshake URL and cannot be intercepted from JS — see
// docs/TOKEN-SECURITY.md for the real fix: move the token out of the URL.)
const redact = (s) =>
  String(s).replace(/(token=)([^&\s]+)/gi, (_, k, v) => `${k}${v.slice(0, 4)}***`);
const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch { return '0'; } })();

let socket = null;
let pingTimer = null;
let reconnectTimer = null;
let backoffMs = BACKOFF_MIN_MS;
let connectStartedAt = 0;  // when the current socket entered CONNECTING
let lastRxTs = 0;          // last inbound frame (proof the path is alive)
let cfg = null;            // { wssUrl, deviceToken }
let queue = null;          // per-tab FIFO in front of dispatchAction (tabQueue.js)
let stopped = false;       // set on auth failure — no reconnect until the user re-pairs
// State reporter injected by background.js, the sole owner of the toolbar icon
// and `fastlinkConn` storage.
let report = null;         // (payload:{state}) => void
// Results go out on the live socket, never only the one the call arrived on.
const replies = createReplySender({ getCurrent: () => socket });

// Mirror of the user "Stop" pause flag (chrome.storage.session). Re-asserted in
// the hello frame on every (re)connect so the relay DO converges its DURABLE
// pause state with the popup toggle after an SW restart / reconnect — prevents a
// stale-pause mismatch. Kept fresh via storage.onChanged.
const PAUSE_KEY = 'fastlink.drivingPaused';
let drivingPaused = false;
try {
  chrome.storage.session.get(PAUSE_KEY).then((o) => { drivingPaused = !!o?.[PAUSE_KEY]; }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[PAUSE_KEY]) drivingPaused = !!changes[PAUSE_KEY].newValue;
  });
} catch {}

// A tab the queue marked stuck is cleared when it commits a new page or closes.
try {
  chrome.webNavigation.onCommitted.addListener((d) => { if (d.frameId === 0) queue?.resetTab(d.tabId); });
  chrome.tabs.onRemoved.addListener((tabId) => queue?.resetTab(tabId));
} catch {}

// Start the relay transport. `handle(action, args)` runs one call;
// `resolveTabId()` names the current target tab (the queue key for calls without
// args.tabId). Returns handler hooks for background.js to wire to the
// synchronously-registered alarm/window listeners.
export function startRelayConnection(handle, { wssUrl, deviceToken, onState, resolveTabId } = {}) {
  resolveTarget = resolveTabId || (async () => null);
  queue = createTabQueue({ run: handle, resolveTabId, send: (f) => replies.sendProgress(f) });
  cfg = { wssUrl, deviceToken };
  report = onState || null;
  stopped = false;
  backoffMs = BACKOFF_MIN_MS;

  ensureAlarm();
  setBadgeForState('connecting');
  connect();

  return {
    onAlarm: (a) => { if (a && a.name === RECONNECT_ALARM) { checkHealth(); connect(); } },
    onWindowCreated: () => { ensureAlarm(); connect(); },
    onWindowRemoved: () => disconnectIfIdle(),
    // Generic "the worker just woke" hook (onStartup/onInstalled).
    wake: () => { ensureAlarm(); checkHealth(); connect(); },
  };
}

function ensureAlarm() { chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 }); }

async function connect() {
  if (stopped) return;
  if (socket && socket.readyState === WebSocket.OPEN) return;
  if (socket && socket.readyState === WebSocket.CONNECTING && Date.now() - connectStartedAt < CONNECT_TIMEOUT_MS) return;
  // Only hold the relay socket open when this profile actually has a window, so
  // a windowless, alarm-kept-alive worker doesn't hold the relay connection with
  // no tab to serve.
  if (!await hasAnyWindow()) return;
  if (!cfg?.wssUrl || !cfg?.deviceToken) return;
  recycle();   // drop any stale/zombie socket before dialing a fresh one

  const sep = cfg.wssUrl.includes('?') ? '&' : '?';
  const url = `${cfg.wssUrl}${sep}token=${encodeURIComponent(cfg.deviceToken)}`;

  let ws;
  // The live socket dials the REAL token in the URL; only the LOGGED string is
  // redacted. Never log `url` directly — always wrap it in redact().
  try { ws = new WebSocket(url); } catch (err) {
    console.warn('[fastlink/relay] connect failed for', redact(url), err?.message || err);
    scheduleReconnect();
    return;
  }
  socket = ws;
  connectStartedAt = Date.now();
  setBadgeForState('connecting');

  ws.onopen = () => {
    backoffMs = BACKOFF_MIN_MS;                       // healthy connection — reset backoff
    lastRxTs = Date.now();
    whenReady(() => sendHello(ws));
    replies.flush();                                  // results finished while no socket was open
    startPingLoop(ws);
    setBadgeForState('connected');
  };
  ws.onmessage = (e) => onMessage(ws, e);
  ws.onclose = (e) => {
    // Ignore closes for a superseded/stale socket. After an MV3 SW-death redial,
    // relay-core's DO closes the OLD socket with code 4000 ("superseded") while
    // the freshly-dialed socket is the live one. ping loop / badge / reconnect are
    // module-global, so acting on the dead socket here would clobber the live one.
    if (socket !== ws) return;
    stopPingLoop();
    socket = null;
    // Token revoked (4401): stop + prompt re-pair (don't hammer a dead token).
    // Anything else (drop, hibernation churn, SW death): backoff reconnect.
    if (e && e.code === AUTH_FAIL_CODE) { onAuthFailure(); return; }
    setBadgeForState('disconnected');
    scheduleReconnect();
  };
  // onclose always follows an error, so reconnect is handled there. Log a
  // redacted breadcrumb (never the raw URL/token) so a failed handshake is still
  // diagnosable from the console.
  ws.onerror = () => { console.warn('[fastlink/relay] socket error for', redact(url)); };
}

async function onMessage(ws, e) {
  lastRxTs = Date.now();                             // any inbound frame is proof the path is alive
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  if (msg.ping || msg.pong) return;                  // keepalive echoes — nothing to do
  // Per-origin consent prompt pushed by the relay on first touch of a new site
  // (SIGNUP-SPEC §4.2). Stash it so the toolbar popup can surface Allow / Read-
  // only / Block. Shape coordinated with relay-auth/hardening; tolerate either
  // `modesOffered` or `modes`.
  if (msg.type === 'consent_required' && msg.origin) {
    try {
      chrome.storage.local.set({
        fastlinkPendingConsent: {
          origin: msg.origin,
          modes: msg.modesOffered || msg.modes || ['allow', 'readonly'],
          message: msg.message || '',
          ts: Date.now(),
        },
      });
    } catch {}
    return;
  }
  if (msg.type !== 'call' || msg.id == null || !msg.action) return;   // events/hello/etc. — ignore inbound
  const reply = await runCall(msg, (action, args) => queue.submit({ id: msg.id, action, args }), resolveTarget);
  // Spread reply so {result} or {error, ...extras} (plus origin/tabId) reach the relay verbatim.
  replies.sendResult({ type: 'result', id: msg.id, ...reply }, ws);
}

function scheduleReconnect() {
  if (stopped) return;
  if (reconnectTimer) return;                        // a reconnect is already pending
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

// Tear down the current socket without scheduling work. Nulling `socket` first
// makes the old socket's onclose a no-op (its `socket !== ws` guard), so it
// can't clobber the fresh one or double-fire a reconnect.
function recycle() {
  const dead = socket;
  socket = null;
  if (dead) { stopPingLoop(); try { dead.close(); } catch {} }
}

// Liveness watchdog, run from the ping loop (worker alive) and the alarm tick
// (worker possibly just revived). Force-recycles zombie sockets so connect()
// can replace them; a healthy socket is left untouched.
function checkHealth() {
  if (stopped || !socket) return;
  const now = Date.now();
  if (socket.readyState === WebSocket.CONNECTING) {
    if (now - connectStartedAt > CONNECT_TIMEOUT_MS) { recycle(); scheduleReconnect(); }
    return;
  }
  if (socket.readyState === WebSocket.OPEN) {
    if (now - lastRxTs > STALE_MS) { recycle(); setBadgeForState('disconnected'); scheduleReconnect(); }
    return;
  }
  // CLOSING / CLOSED that never fired a usable onclose — clean up and retry.
  recycle();
  scheduleReconnect();
}

// Token rejected/revoked: stop reconnecting (no infinite loop on a dead token),
// clear the stored token, and surface a re-pair prompt for the options page.
function onAuthFailure() {
  stopped = true;
  stopPingLoop();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  chrome.alarms.clear(RECONNECT_ALARM);
  try {
    chrome.storage.local.remove(['deviceToken']);
    chrome.storage.local.set({ relayAuthError: 'FastLink was unpaired or its token was revoked — re-pair in the extension options.' });
  } catch {}
  setBadgeForState('auth');
}

// User-initiated hard disconnect (SAFETY N2 "Disconnect relay"). Stops dialing,
// closes the socket, drops the keepalive alarm — claude.ai can no longer drive
// this browser until the relay is re-enabled (background sets relayEnabled=false
// and a reconnect re-runs the module with stopped reset). Distinct from
// onAuthFailure: no re-pair prompt, no stored error — this is intentional.
export function stopRelay() {
  stopped = true;
  stopPingLoop();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { chrome.alarms.clear(RECONNECT_ALARM); } catch {}
  recycle();
  setBadgeForState('disconnected');
}

async function disconnectIfIdle() {
  if (await hasAnyWindow()) return;
  if (socket) try { socket.close(); } catch {}
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // Drop the alarm so a windowless worker can die and free the relay connection;
  // chrome.windows.onCreated re-arms it when a window reappears.
  chrome.alarms.clear(RECONNECT_ALARM);
}

function startPingLoop(ws) {
  stopPingLoop();
  pingTimer = setInterval(() => {
    checkHealth();                                   // catch half-open sockets between alarm ticks
    if (ws.readyState !== WebSocket.OPEN) return;
    // EXACTLY {"ping":true} — must string-match the DO's setWebSocketAutoResponse
    // key so the keepalive is answered without waking the DO from hibernation.
    try { ws.send(JSON.stringify({ ping: true })); } catch {}
  }, PING_MS);
}

function stopPingLoop() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

// Push an unsolicited event up to the relay DO (the popup's driving_paused /
// driving_resumed toggle). No-op if the socket is down.
export function sendRelayEvent(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify({ type: 'event', ...payload })); } catch {}
  }
}

function hasAnyWindow() {
  return new Promise((resolve) => {
    try {
      chrome.windows.getAll({}, (wins) => resolve(Array.isArray(wins) && wins.length > 0));
    } catch { resolve(false); }
  });
}

// Report this transport's state to background.js (icon + `fastlinkConn` owner).
function setBadgeForState(state) {
  report?.({ state });
}

// ---------------------------------------------------------------------------
// Pairing (HTTPS, one-time): exchange a short human code for a durable device
// token. Called from the options page. On success, stores the relay config in
// chrome.storage.local. The caller then messages background
// ('fastlink:relay-paired') to dial the relay live.
// ---------------------------------------------------------------------------
export async function claimPairingCode(code, relayBase) {
  const base = (String(relayBase || '').trim() || DEFAULT_RELAY_BASE).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Relay base URL must start with https://');
  const clean = normalizeCode(code);
  if (!clean) throw new Error('Enter the pairing code shown on the relay page.');

  let res, body = {};
  try {
    res = await fetch(`${base}/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: clean, label: defaultBaseName() }),
    });
  } catch (e) {
    throw new Error(`Could not reach the relay at ${base} (${e?.message || e}).`);
  }
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) {
    const map = { invalid_or_expired_code: 'That code is invalid or expired — generate a new one on the relay page.' };
    throw new Error(map[body?.error] || body?.error || `Pairing failed (HTTP ${res.status}).`);
  }
  const { deviceToken, userId } = body;
  if (!deviceToken) throw new Error('Relay did not return a device token.');
  // Prefer the relay-supplied wss URL; otherwise derive it from the base origin.
  const wssUrl = body.wssUrl || `${base.replace(/^http/, 'ws')}/ext`;

  await persistRelayPairing({ deviceToken, base, wssUrl, userId });
  return { userId: userId || null, wssUrl };
}

// ---------------------------------------------------------------------------
// Auto-pair via chrome.identity.launchWebAuthFlow (SIGNUP-SPEC §1.4 / §4.1).
// One-click "Sign in & connect": opens the relay's /ext/authorize in a browser-
// controlled auth window, the human proves identity there (OWNER_SECRET in
// shared mode, email magic-link in magic mode), and the relay 302s back to our
// fixed chromiumapp.org redirect URI with the freshly minted device token in the
// URL FRAGMENT. No code is ever shown to or typed by the user.
//
// MUST be invoked from a user-gesture context (the onboarding / options button)
// so interactive:true is allowed to open the window. On success this stores the
// same relay config claimPairingCode does (shared tail) — the caller then asks
// background.js to start the relay transport live (no extension reload needed).
// ---------------------------------------------------------------------------
export async function authorizeViaWebAuthFlow(relayBase) {
  const base = (String(relayBase || '').trim() || DEFAULT_RELAY_BASE).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Relay base URL must start with https://');
  if (!chrome.identity?.launchWebAuthFlow) {
    throw new Error('chrome.identity is unavailable — reload the extension (the "identity" permission may be missing).');
  }

  // Fixed redirect URI derived from the extension ID: https://<id>.chromiumapp.org/
  const redirectUri = chrome.identity.getRedirectURL();
  // CSRF / response-fixation guard: opaque random the relay must echo verbatim.
  const state = randomState();
  const url = `${base}/ext/authorize`
    + `?redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(state)}`
    + `&label=${encodeURIComponent(defaultBaseName())}`;

  let ret;
  try {
    ret = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch (e) {
    const m = String(e?.message || e);
    // launchWebAuthFlow rejects on user-close/cancel and on flow timeout.
    if (/did not approve|cancell?ed|closed|user_cancelled/i.test(m)) {
      throw new Error('Sign-in was canceled. Click “Sign in & connect” to try again.');
    }
    throw new Error(`Sign-in could not complete (${m}).`);
  }
  if (!ret) throw new Error('Sign-in did not complete — please try again.');

  // Token data rides the fragment (#…); parse it (NOT the query string).
  let frag;
  try { frag = new URLSearchParams(new URL(ret).hash.replace(/^#/, '')); }
  catch { throw new Error('Could not read the sign-in response from the relay.'); }

  const err = frag.get('error');
  if (err) throw new Error(mapAuthError(err));
  // Verify state BEFORE trusting any token in the response.
  if (frag.get('state') !== state) {
    throw new Error('Sign-in failed a security check (state mismatch). Please retry.');
  }
  const deviceToken = frag.get('devicetoken');
  if (!deviceToken) throw new Error('The relay did not return a device token.');
  const userId = frag.get('userId') || null;
  const wssUrl = frag.get('wssUrl') || `${base.replace(/^http/, 'ws')}/ext`;

  await persistRelayPairing({ deviceToken, base, wssUrl, userId });
  return { userId, wssUrl };
}

// ---------------------------------------------------------------------------
// Tab-poll fallback: fully automatic pairing when launchWebAuthFlow fails
// (popup blocked, flow error, 2nd-profile quirks). Opens the relay's
// /ext/authorize in a REGULAR tab (chrome.tabs.create — popup blockers don't
// apply) carrying an unguessable extension-generated pollId; the relay parks the
// minted device token under that pollId at sign-in completion, and we collect it
// here by POSTing /ext/authorize/wait every ~2s (token rides the response BODY,
// never a URL). Single-use server-side: the relay deletes the row on hand-out.
// Requires a relay that knows the `poll` param — an older relay answers the poll
// with 405/501, which we surface as "use a pairing code instead" (graceful
// degradation to the manual path). Same persistRelayPairing storage tail as the
// other two flows.
// ---------------------------------------------------------------------------
const TAB_POLL_INTERVAL_MS = 2_000;
const TAB_POLL_TIMEOUT_MS = 5 * 60_000;

export async function authorizeViaTabPoll(relayBase) {
  const base = (String(relayBase || '').trim() || DEFAULT_RELAY_BASE).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Relay base URL must start with https://');
  if (!chrome.tabs?.create) throw new Error('chrome.tabs is unavailable — reload the extension.');
  // The relay's open-redirect guard requires a valid chromiumapp.org redirect_uri
  // even though the tab flow delivers the token via the poll, not the redirect.
  if (!chrome.identity?.getRedirectURL) {
    throw new Error('chrome.identity is unavailable — reload the extension (the "identity" permission may be missing).');
  }
  const redirectUri = chrome.identity.getRedirectURL();
  const pollId = randomPollId();
  const url = `${base}/ext/authorize`
    + `?redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(randomState())}`
    + `&label=${encodeURIComponent(defaultBaseName())}`
    + `&poll=${encodeURIComponent(pollId)}`;

  let tab;
  try { tab = await chrome.tabs.create({ url, active: true }); }
  catch (e) { throw new Error(`Could not open the sign-in tab (${e?.message || e}).`); }

  // Best-effort early abort if the user closes the sign-in tab (Chrome may reuse
  // tab ids eventually, but not within this 5-minute window in practice).
  let tabClosed = false;
  const onRemoved = (tabId) => { if (tab && tabId === tab.id) tabClosed = true; };
  try { chrome.tabs.onRemoved.addListener(onRemoved); } catch {}

  try {
    const deadline = Date.now() + TAB_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(TAB_POLL_INTERVAL_MS);
      if (tabClosed) throw new Error('The sign-in tab was closed before sign-in finished — try again, or use a pairing code.');

      let res;
      try {
        res = await fetch(`${base}/ext/authorize/wait`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pollId }),
        });
      } catch { continue; }                          // transient network error — keep polling
      // 405/501: the relay predates the tab-poll flow (or the pair_requests
      // migration isn't applied) — fail over to the manual code path. Close the
      // now-useless sign-in tab so an OLD relay can't finish the flow and dump a
      // token fragment onto the chromiumapp.org placeholder page.
      if (res.status === 405 || res.status === 501) {
        if (tab) { try { await chrome.tabs.remove(tab.id); } catch {} }
        throw new Error('This relay doesn’t support automatic tab sign-in yet — use “Use a pairing code” instead.');
      }
      if (!res.ok) continue;                         // 429 limiter blip / 5xx — next tick
      let body;
      try { body = await res.json(); } catch { continue; }
      const deviceToken = body?.devicetoken || body?.deviceToken;
      if (!deviceToken) continue;                    // {status:'pending'} — keep polling

      const userId = body.userId || null;
      const wssUrl = body.wssUrl || `${base.replace(/^http/, 'ws')}/ext`;
      await persistRelayPairing({ deviceToken, base, wssUrl, userId });
      if (tab) { try { await chrome.tabs.remove(tab.id); } catch {} }
      return { userId, wssUrl };
    }
    // Timed out: nobody is polling anymore, so a late sign-in would park a token
    // no one collects (it expires server-side) — close the tab to make that clear.
    if (tab && !tabClosed) { try { await chrome.tabs.remove(tab.id); } catch {} }
    throw new Error('Sign-in timed out — try again, or use a pairing code.');
  } finally {
    try { chrome.tabs.onRemoved.removeListener(onRemoved); } catch {}
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 32 random bytes → base64url: a 256-bit poll key. The relay accepts ≥22 chars
// (≥128 bits); this comfortably exceeds it.
function randomPollId() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Shared storage-write tail for ALL pairing paths (manual code + web-auth + tab-poll).
// Writes the relay config, enables the relay, and clears any stale auth-error banner.
async function persistRelayPairing({ deviceToken, base, wssUrl, userId }) {
  await chrome.storage.local.set({
    deviceToken,
    relayBase: base,
    relayWssUrl: wssUrl,
    relayUserId: userId || null,
    relayAuthError: null,
    relayEnabled: true,
  });
}

// 16 random bytes → base64url. ≥16 chars, satisfies the relay's state length gate.
function randomState() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Map the relay's machine-readable error codes (#error=…) to friendly text.
function mapAuthError(code) {
  const map = {
    access_denied:   'Sign-in was declined on the relay.',
    invalid_request: 'The sign-in request was invalid — please try again.',
    server_error:    'The relay hit an error during sign-in — please try again.',
  };
  return map[code] || `Sign-in failed (${code}).`;
}

function normalizeCode(code) {
  // Crockford base32, case-insensitive, dashes/spaces are cosmetic.
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

