// popup.js — toolbar popup. FastLink runs up to TWO transports at once (local
// broker + cloud relay); this renders one status row per ENABLED transport from
// the combined `fastlinkConn` object that background.js writes:
//   { local: {enabled,state,clients}|null, relay: {enabled,state}|null }
// (null = that transport is disabled/not configured). Plus shortcuts to the
// pairing settings and an extension reload.

const $ = (id) => document.getElementById(id);

// state -> [pill class, label]
const LABELS = {
  connected:    ['ok',   'Connected'],
  connecting:   ['warn', 'Connecting…'],
  disconnected: ['off',  'Disconnected'],
  auth:         ['warn', 'Needs re-pair'],
};

// Map a pill class to the matching status-dot tint.
const DOT_BY_PILL = { ok: 'ok', warn: 'warn', off: 'err' };

function row(title, state, detailText) {
  const [cls, text] = LABELS[state] || LABELS.disconnected;
  const wrap = document.createElement('div');
  wrap.className = 'trow';

  const main = document.createElement('div');
  main.className = 'trow-main';

  const dot = document.createElement('span');
  dot.className = 'fl-dot ' + (DOT_BY_PILL[cls] || 'err');
  const t = document.createElement('span');
  t.className = 'trow-title';
  t.textContent = title;
  const pill = document.createElement('span');
  pill.className = 'pill ' + cls;
  pill.textContent = text;
  main.append(dot, t, pill);
  wrap.append(main);

  if (detailText) {
    const d = document.createElement('div');
    d.className = 'trow-sub';
    d.textContent = detailText;
    wrap.append(d);
  }
  return wrap;
}

async function render() {
  const c = await chrome.storage.local.get(['fastlinkConn', 'relayAuthError', 'relayBase']);
  const conn = c.fastlinkConn || {};
  const rows = $('rows');
  rows.replaceChildren();

  if (conn.local) {
    const n = typeof conn.local.clients === 'number' ? conn.local.clients : null;
    const detail = conn.local.state === 'connected' && n != null
      ? `${n} MCP client${n === 1 ? '' : 's'} connected`
      : 'Claude Code / Desktop';
    rows.append(row('Local broker', conn.local.state, detail));
  }

  if (conn.relay) {
    const state = c.relayAuthError ? 'auth' : conn.relay.state;
    const detail = c.relayAuthError
      ? c.relayAuthError
      : conn.relay.state === 'connected'
        ? 'claude.ai web chat'
        : `Cloud relay${c.relayBase ? ' (' + c.relayBase + ')' : ''}`;
    rows.append(row('Cloud relay', state, detail));
  }

  if (!conn.local && !conn.relay) {
    rows.append(row('No transport enabled', 'disconnected',
      'Enable the local broker or pair a cloud relay in settings.'));
  }
}

// ---------------------------------------------------------------------------
// Per-origin consent (SIGNUP-SPEC §4.2). Grant happens IN the browser via the
// device token the extension already holds — POST {relayBase}/consent. We
// surface either a relay-pushed pending origin (fastlinkPendingConsent) or, when
// paired, the current active tab's origin so the user can pre-approve a site.
// ---------------------------------------------------------------------------
const DEFAULT_RELAY_BASE = 'https://relay.ytx.app';

async function activeOrigin() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.url && /^https?:/.test(tab.url)) return new URL(tab.url).origin;
  } catch {}
  return null;
}

async function postConsent(origin, mode) {
  const c = await chrome.storage.local.get(['relayBase', 'deviceToken']);
  if (!c.deviceToken) throw new Error('This browser is not paired with the relay yet.');
  const base = String(c.relayBase || DEFAULT_RELAY_BASE).replace(/\/+$/, '');
  const res = await fetch(`${base}/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceToken: c.deviceToken, origin, mode }),
  });
  if (!res.ok) {
    let b = {};
    try { b = await res.json(); } catch {}
    const FRIENDLY = {
      invalid_device_token: 'This browser is no longer paired — re-pair it in the extension options.',
      invalid_mode: 'Unsupported permission choice.',
      invalid_origin: 'Could not determine this site’s origin.',
      invalid_json: 'The relay rejected the request.',
    };
    throw new Error(FRIENDLY[b?.error] || b?.error || `Consent update failed (HTTP ${res.status}).`);
  }
}

// Local mirror of decided per-origin permissions, so the popup can show a
// COMPACT saved-status line ("claude.ai — Allowed ✓") instead of re-rendering the
// full chooser on every open. The authoritative store is the relay; this is just
// for instant display. Shape: { [origin]: 'allow'|'readonly'|'block' }.
const DECISIONS_KEY = 'fastlinkConsentDecisions';

// When the user clicks "change"/"set", we expand the chooser for THIS origin only
// (popup-session state; resets to compact each time the popup is reopened).
let chooserOpenOrigin = null;

const CONSENT_LABEL = {
  allow:    ['Allowed',   'allow'],
  readonly: ['Read-only', 'readonly'],
  block:    ['Blocked',   'block'],
};

function buildChooser(box, origin, pending) {
  const modes = pending?.modes || ['allow', 'readonly'];
  box.className = 'consent' + (pending ? ' pending' : '');

  const h = document.createElement('h2');
  h.textContent = pending ? 'claude.ai wants control' : 'Web chat access';
  box.append(h);

  if (pending?.message) {
    const m = document.createElement('p');
    m.className = 'cmsg muted';
    m.textContent = pending.message;
    box.append(m);
  }

  const o = document.createElement('p');
  o.className = 'origin';
  o.textContent = origin;
  box.append(o);

  // Plain-English explainer of what granting access actually does.
  const ex = document.createElement('p');
  ex.className = 'explain';
  ex.textContent = pending
    ? 'The claude.ai web chat is asking to drive this site — read the page, click, fill, and navigate on your behalf.'
    : 'Lets the claude.ai web chat read this page, click, fill, and navigate it on your behalf.';
  box.append(ex);

  const btns = document.createElement('div');
  btns.className = 'btns';
  const make = (label, mode, cls) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', () => grant(origin, mode));
    return b;
  };
  if (modes.includes('allow'))    btns.append(make('Allow', 'allow', 'allow'));
  if (modes.includes('readonly')) btns.append(make('Read-only', 'readonly', 'read'));
  btns.append(make('Block', 'block', 'block'));
  box.append(btns);

  // When the user voluntarily opened the chooser (not a relay-pushed prompt),
  // let them back out to the compact line without deciding.
  if (!pending) {
    const cancel = document.createElement('button');
    cancel.className = 'linklike';
    cancel.style.marginTop = '7px';
    cancel.textContent = 'cancel';
    cancel.addEventListener('click', () => { chooserOpenOrigin = null; renderConsent(); });
    box.append(cancel);
  }

  const msg = document.createElement('p');
  msg.className = 'cmsg';
  msg.id = 'consent-msg';
  box.append(msg);
}

function buildCompact(box, origin, saved) {
  box.className = 'consent';
  const h = document.createElement('h2');
  h.textContent = 'Web chat access';
  box.append(h);

  const line = document.createElement('div');
  line.className = 'consent-line';

  let host = origin;
  try { host = new URL(origin).host; } catch {}
  const site = document.createElement('span');
  site.className = 'site';
  site.title = origin;
  site.textContent = host;

  const [label, cls] = CONSENT_LABEL[saved] || ['Not set', 'none'];
  const dash = document.createElement('span');
  dash.className = 'muted';
  dash.textContent = '—';
  const state = document.createElement('span');
  state.className = 'state ' + cls;
  state.textContent = label + (saved === 'allow' ? ' ✓' : '');

  const change = document.createElement('button');
  change.className = 'linklike';
  change.textContent = saved ? 'Change' : 'Set up';
  change.addEventListener('click', () => { chooserOpenOrigin = origin; renderConsent(); });

  line.append(site, dash, state, change);
  box.append(line);

  // One-line explainer so "Allowed ✓" is self-explanatory.
  const ex = document.createElement('p');
  ex.className = 'explain';
  ex.textContent = saved === 'allow'
    ? 'claude.ai web chat can read, click, fill, and navigate this site for you. “Change” revokes or edits this.'
    : saved === 'readonly'
      ? 'claude.ai web chat can read this site but not click or type. “Change” edits this.'
      : saved === 'block'
        ? 'claude.ai web chat is blocked from driving this site. “Change” edits this.'
        : 'Decide whether the claude.ai web chat may drive this site (read, click, fill, navigate). “Set up” to choose.';
  box.append(ex);
}

async function renderConsent() {
  const box = $('consent');
  const c = await chrome.storage.local.get([DECISIONS_KEY, 'fastlinkPendingConsent', 'deviceToken']);
  // No relay pairing → nothing to consent to.
  if (!c.deviceToken) { box.style.display = 'none'; return; }

  const pending = c.fastlinkPendingConsent;     // unresolved relay-pushed request
  const decisions = c[DECISIONS_KEY] || {};
  const origin = pending?.origin || await activeOrigin();
  if (!origin) { box.style.display = 'none'; return; }

  box.replaceChildren();
  // Full chooser ONLY for an unresolved pending request, or when the user
  // explicitly chose to (re)set this origin via "change"/"set". Otherwise show
  // the compact one-line saved status so the card never grows on reopen.
  if (pending || chooserOpenOrigin === origin) {
    buildChooser(box, origin, pending);
  } else {
    buildCompact(box, origin, decisions[origin]);
  }
  box.style.display = 'block';
}

async function grant(origin, mode) {
  const msg = $('consent-msg');
  if (msg) { msg.textContent = 'Saving…'; msg.style.color = 'var(--fl-text-dim)'; }
  try {
    await postConsent(origin, mode);
    // Persist the decision locally for the compact status, clear any pending
    // prompt for this origin, and collapse back to the one-line view.
    const c = await chrome.storage.local.get([DECISIONS_KEY, 'fastlinkPendingConsent']);
    const decisions = { ...(c[DECISIONS_KEY] || {}), [origin]: mode };
    const writes = { [DECISIONS_KEY]: decisions };
    await chrome.storage.local.set(writes);
    if (c.fastlinkPendingConsent?.origin === origin) {
      await chrome.storage.local.remove(['fastlinkPendingConsent']);
    }
    chooserOpenOrigin = null;
    renderConsent();   // re-render → compact line reflects the saved decision
  } catch (e) {
    if (msg) { msg.textContent = e?.message || String(e); msg.style.color = 'var(--fl-err)'; }
  }
}

// ---------------------------------------------------------------------------
// "Who's driving" mirror (SIGNUP-SPEC §5.4 / SAFETY N2). The target-tab PIN
// (chrome.storage.session 'fastlink.targetTabId') is the tab Claude is driving
// even while unfocused; mirror it here so the user always knows what's being
// driven from the chat side. The target tab itself shows the activity overlay.
// ---------------------------------------------------------------------------
const TARGET_PIN_KEY = 'fastlink.targetTabId';
const PAUSE_KEY = 'fastlink.drivingPaused';

async function isPaused() {
  try { const s = await chrome.storage.session.get(PAUSE_KEY); return !!s?.[PAUSE_KEY]; } catch { return false; }
}

async function renderDriving() {
  const el = $('driving');
  // Paused state wins over the pin: make the global "Claude can't act" stop obvious.
  if (await isPaused()) {
    el.textContent = '⏸ Paused by you — Claude can’t act until you resume';
    el.className = 'panel driving paused';
    el.style.display = 'block';
    return;
  }
  el.className = 'panel driving';
  let id = null;
  try {
    const o = await chrome.storage.session.get(TARGET_PIN_KEY);
    id = o?.[TARGET_PIN_KEY];
  } catch {}
  if (typeof id !== 'number') { el.style.display = 'none'; return; }
  let label;
  try {
    const t = await chrome.tabs.get(id);
    label = t?.title || (t?.url ? new URL(t.url).origin : `tab ${id}`);
  } catch {
    el.style.display = 'none';   // pinned tab gone
    return;
  }
  el.textContent = `▶ Claude is driving: ${label}`;
  el.style.display = 'block';
}

// N2 kill-switch controls: Stop/Resume driving (pause gate) + Disconnect/
// Reconnect the cloud relay. Both go through background message handlers.
async function renderControls() {
  const c = await chrome.storage.local.get(['deviceToken', 'relayEnabled', 'fastlinkMode']);
  const paused = await isPaused();

  const pb = $('pause-btn');
  pb.textContent = paused ? '▶ Resume driving' : '⏸ Stop driving';
  pb.className = paused ? 'resume' : 'stop';

  const db = $('disconnect-btn');
  if (c.deviceToken) {
    const relayDisabled = c.relayEnabled === false || c.fastlinkMode === 'local';
    db.style.display = '';
    db.textContent = relayDisabled ? 'Reconnect relay' : 'Disconnect relay';
    db.dataset.act = relayDisabled ? 'reconnect' : 'disconnect';
  } else {
    db.style.display = 'none';
  }
  $('controls').style.display = '';
}

async function onPauseToggle() {
  const paused = await isPaused();
  try { await chrome.runtime.sendMessage({ type: 'fastlink:driving-pause', paused: !paused }); } catch {}
  renderControls();
  renderDriving();
}

async function onDisconnectToggle() {
  const act = $('disconnect-btn').dataset.act;
  const type = act === 'reconnect' ? 'fastlink:relay-reconnect' : 'fastlink:relay-stop';
  try { await chrome.runtime.sendMessage({ type }); } catch {}
  renderControls();
}

// ---------------------------------------------------------------------------
// Global activity view. background.js (the single dispatch chokepoint) writes
// chrome.storage.session['fastlink.activity']:
//   { running:[{action,start,tabId}], inFlight, stuck, last:{action,ok,endedAt} }
// This is visible from ANY tab via the toolbar popup, complementing the in-page
// overlay (which only shows on the driven tab). A local 1s ticker keeps the
// elapsed/"… ago" labels live without churning storage.
// ---------------------------------------------------------------------------
const ACTIVITY_KEY = 'fastlink.activity';
const STUCK_MS = 13000;
let activityTimer = null;

function agoLabel(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ${s % 60}s ago`;
}
function durLabel(ms) { return `${Math.max(0, Math.round(ms / 1000))}s`; }

async function tabLabel(id) {
  if (typeof id !== 'number') return null;
  try {
    const t = await chrome.tabs.get(id);
    return t?.title || (t?.url ? new URL(t.url).origin : `tab ${id}`);
  } catch { return null; }
}

async function renderActivity() {
  const el = $('activity');
  let a = null;
  try { a = (await chrome.storage.session.get(ACTIVITY_KEY))[ACTIVITY_KEY]; } catch {}
  const running = a?.running || [];

  el.replaceChildren();
  const head = document.createElement('div'); head.className = 'head';
  const sub = document.createElement('div');  sub.className = 'sub';

  if (running.length > 0) {
    const oldest = running.reduce((x, y) => (x.start < y.start ? x : y));
    const elapsed = Date.now() - oldest.start;
    const stuck = a.stuck || elapsed >= STUCK_MS;
    const more = running.length > 1 ? ` (+${running.length - 1} more)` : '';
    el.className = 'panel activity ' + (stuck ? 'stuck' : 'running');
    head.textContent = (stuck ? '⚠ Possibly stuck · ' : '▶ Running · ') + oldest.action + ' ' + durLabel(elapsed) + more;
    const label = await tabLabel(oldest.tabId);
    sub.textContent = label ? `Driving: ${label}` : `${running.length} command${running.length === 1 ? '' : 's'} in flight`;
  } else if (a?.last) {
    el.className = 'panel activity idle';
    head.textContent = `Idle · last: ${a.last.action} ${a.last.ok ? '✓' : '✗'}`;
    sub.textContent = agoLabel(a.last.endedAt);
  } else {
    el.style.display = 'none';
    return;
  }
  el.append(head, sub);
  el.style.display = 'block';
}

async function renderNotifyToggle() {
  try {
    const o = await chrome.storage.local.get('fastlinkNotify');
    $('notify-toggle').checked = !!o?.fastlinkNotify;
  } catch {}
}
$('notify-toggle').addEventListener('change', (e) => {
  chrome.storage.local.set({ fastlinkNotify: !!e.target.checked }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Read-aloud toggle. The widget (src/readAloud.js) is hidden by default; this
// button shows/hides it on the active tab via a content-script message. Hidden
// when the tab has no content script (chrome:// pages, tabs opened before the
// extension loaded).
// ---------------------------------------------------------------------------
async function readAloudTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null && /^https?:/.test(tab.url || '')) return tab;
  } catch {}
  return null;
}

async function renderReadAloud() {
  const btn = $('read-aloud');
  const tab = await readAloudTab();
  if (!tab) { btn.style.display = 'none'; return; }
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'fastlink:read-aloud-state' });
    btn.textContent = r?.shown ? '🔊 Hide read-aloud player' : '🔊 Read aloud on this page';
    btn.style.display = '';
  } catch {
    btn.style.display = 'none';                  // no content script on this tab
  }
}

$('read-aloud').addEventListener('click', async () => {
  const tab = await readAloudTab();
  if (!tab) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: 'fastlink:read-aloud-toggle' }); } catch {}
  window.close();
});

$('open').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
$('reload').addEventListener('click', () => chrome.runtime.reload());
$('pause-btn').addEventListener('click', onPauseToggle);
$('disconnect-btn').addEventListener('click', onDisconnectToggle);

// Open the transcript side panel. chrome.sidePanel.open() needs a user gesture
// AND a windowId/tabId — from a popup, sender.tab is undefined, so we resolve the
// current window and call open() DIRECTLY in this click handler (routing through
// the background 'fastlink:open-sidepanel' handler fails because it reads
// sender.tab.id, which a popup message doesn't carry).
$('open-sidepanel').addEventListener('click', async () => {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    window.close();
  } catch (e) {
    console.warn('[fastlink] open side panel failed', e);
  }
});

// Live-update the popup while it's open if background rewrites the status.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.fastlinkConn || changes.relayAuthError) render();
    if (changes.fastlinkConn || changes.fastlinkPendingConsent || changes.deviceToken || changes[DECISIONS_KEY]) renderConsent();
    if (changes.deviceToken || changes.relayEnabled || changes.fastlinkMode) renderControls();
  }
  if (area === 'session' && (changes[TARGET_PIN_KEY] || changes[PAUSE_KEY])) {
    renderDriving();
    if (changes[PAUSE_KEY]) renderControls();
  }
  if (area === 'session' && changes[ACTIVITY_KEY]) renderActivity();
  if (area === 'local' && changes.fastlinkNotify) renderNotifyToggle();
});

// Show the running extension version, unobtrusively, near the footer controls.
try {
  const el = $('version');
  if (el) el.textContent = 'v' + chrome.runtime.getManifest().version;
} catch {}

render();
renderReadAloud();
renderConsent();
renderDriving();
renderControls();
renderActivity();
renderNotifyToggle();

// Keep elapsed / "… ago" labels live while the popup is open (cheap, local-only).
activityTimer = setInterval(renderActivity, 1000);
window.addEventListener('unload', () => { if (activityTimer) clearInterval(activityTimer); });
