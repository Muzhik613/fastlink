// options.js — the FastLink Settings hub. FastLink runs the local broker AND the
// cloud relay AT THE SAME TIME (both drive the same browser), so this page pairs/
// unpairs the relay, shows live status of BOTH transports, and centralizes every
// setting: advanced control, the
// broker slot, desktop notifications, and per-origin site permissions.
// Applying a transport change reloads the extension so background.js re-reads config.

import { claimPairingCode, authorizeViaWebAuthFlow, authorizeViaTabPoll } from './src/relayClient.js';

const $ = (id) => document.getElementById(id);

// ---- section tabs -----------------------------------------------------------
// Top tab bar: one section (Connection / Behavior / Sites & about) visible at a
// time. The selected tab is mirrored into location.hash so
// a refresh (and any future deep link, e.g. options.html#behavior) lands on the
// same section.
const TAB_DEFAULT = 'connection';
function showTab(name) {
  let tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (!tab) { name = TAB_DEFAULT; tab = document.querySelector(`.tab[data-tab="${name}"]`); }
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.tabpanel').forEach((p) => {
    p.classList.toggle('active', p.id === `panel-${name}`);
  });
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
}
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => showTab(t.dataset.tab)));
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
showTab(location.hash.slice(1) || TAB_DEFAULT);

const DEFAULT_RELAY_BASE = 'https://relay.ytx.app';

// Keep the disclosure's "Generate a code →" link pointed at the (possibly
// customized) relay — same scheme as onboarding.js.
function pairNewUrl(base) {
  return `${String(base || DEFAULT_RELAY_BASE).replace(/\/+$/, '')}/pair/new`;
}
function syncGenCodeLink() {
  const a = $('gen-code');
  if (a) a.href = pairNewUrl(($('relayBase').value || '').trim());
}
const STORAGE_KEYS = [
  'fastlinkMode', 'localEnabled', 'relayEnabled', 'deviceToken',
  'relayBase', 'relayWssUrl', 'relayUserId', 'relayAuthError', 'fastlinkConn',
];

// state -> [pill class, label]
const LABELS = {
  connected:    ['ok',   'Connected'],
  connecting:   ['warn', 'Connecting…'],
  disconnected: ['off',  'Disconnected'],
  auth:         ['warn', 'Needs re-pair'],
  disabled:     ['off',  'Disabled'],
  unpaired:     ['off',  'Not paired'],
};
// Map a pill class to the matching status-dot tint.
const DOT_BY_PILL = { ok: 'ok', warn: 'warn', off: 'err' };

function setPill(id, dotId, state) {
  const [cls, text] = LABELS[state] || LABELS.disconnected;
  const el = $(id);
  el.textContent = text;
  el.className = 'pill ' + cls;
  const dot = dotId && $(dotId);
  if (dot) dot.className = 'fl-dot ' + (DOT_BY_PILL[cls] || 'err');
}

function mask(token) {
  if (!token) return '—';
  return token.length <= 8 ? '••••' : `${token.slice(0, 4)}…${token.slice(-4)}`;
}

// Build a <code> element via textContent — never innerHTML. relayBase is user-
// typed and relayUserId comes off the wire, so they must not be parsed as HTML
// in this privileged (chrome.*-capable) options page.
function codeEl(text) {
  const el = document.createElement('code');
  el.textContent = String(text);
  return el;
}

function showMsg(text, kind) {
  const el = $('msg');
  el.textContent = text;
  el.className = `msg ${kind}`;
}

async function render() {
  const c = await chrome.storage.local.get(STORAGE_KEYS);
  const conn = c.fastlinkConn || {};

  const localDisabled   = c.localEnabled === false;
  const relayConfigured = !!c.deviceToken;
  // Relay is disabled either explicitly or via the legacy fastlinkMode==='local'.
  const relayDisabled   = c.relayEnabled === false || c.fastlinkMode === 'local';

  // Local transport pill + dot.
  setPill('local-pill', 'local-dot', localDisabled ? 'disabled' : (conn.local?.state || 'disconnected'));
  const localDetail = $('local-detail');
  if (localDisabled) {
    localDetail.textContent = 'Disabled — the local broker is off.';
  } else if (conn.local?.state === 'connected' && typeof conn.local.clients === 'number') {
    const n = conn.local.clients;
    localDetail.textContent = `Localhost broker — ${n} MCP client${n === 1 ? '' : 's'} connected.`;
  } else {
    localDetail.textContent = 'Localhost broker (Claude Code / Desktop).';
  }

  // Relay transport pill + dot: auth error > not paired > disabled > live state.
  let relayState;
  if (c.relayAuthError)        relayState = 'auth';
  else if (!relayConfigured)   relayState = 'unpaired';
  else if (relayDisabled)      relayState = 'disabled';
  else                         relayState = conn.relay?.state || 'disconnected';
  setPill('relay-pill', 'relay-dot', relayState);

  // Relay detail line.
  const detail = $('status-detail');
  if (relayConfigured && !relayDisabled) {
    detail.replaceChildren('Paired to ', codeEl(c.relayBase || '?'));
    if (c.relayUserId) detail.append(' as user ', codeEl(c.relayUserId));
    detail.append('. Device token ', codeEl(mask(c.deviceToken)), '. ');
    detail.append(localDisabled
      ? 'Local broker is disabled.'
      : 'Local broker also active (Claude Code / Desktop).');
  } else if (c.relayAuthError) {
    detail.textContent = c.relayAuthError;
  } else if (relayConfigured && relayDisabled) {
    detail.textContent = 'Paired, but the cloud relay is disabled — only the local broker is active.';
  } else {
    detail.textContent = 'Using the localhost broker (Claude Code / Desktop). Not paired with a cloud relay.';
  }

  // Pairing card: show the "✓ Paired as <user>" confirmation and dim the how-to
  // once this browser actually holds a device token (and the relay isn't disabled).
  // Reuses the existing relayUserId / deviceToken values — no new pairing logic.
  const paired = relayConfigured && !relayDisabled;
  const confirm = $('pair-confirm');
  if (confirm) {
    if (paired) {
      confirm.style.display = 'flex';
      const txt = $('pair-confirm-text');
      if (txt) {
        if (c.relayUserId) txt.replaceChildren('Paired as ', codeEl(c.relayUserId), '.');
        else txt.textContent = 'This browser is paired with the relay.';
      }
    } else {
      confirm.style.display = 'none';
    }
  }
  const howto = $('pair-howto');
  if (howto) howto.classList.toggle('dimmed', paired);

  // Pre-fill the relay base from the last-used value so the user rarely re-types it.
  if (c.relayBase) $('relayBase').value = c.relayBase;
  syncGenCodeLink();

  // Toggle the local/relay control button label to match what it will do.
  const localBtn = $('local-btn');
  if (localBtn) {
    localBtn.textContent = relayConfigured && !relayDisabled
      ? 'Disable cloud relay (keep local broker)'
      : 'Use local broker only';
  }

  if (c.relayAuthError && relayDisabled) showMsg(c.relayAuthError, 'err');
}

// Ask background.js to bring the relay transport up LIVE after a fresh pairing
// (no extension reload). Returns true if it started live; false means a reload
// was triggered (re-pair carrying a new token, or background was unreachable).
async function bringRelayUp() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'fastlink:relay-paired' });
    if (resp?.needsReload) { setTimeout(() => chrome.runtime.reload(), 600); return false; }
    return true;
  } catch {
    setTimeout(() => chrome.runtime.reload(), 600);
    return false;
  }
}

// One-click: chrome.identity.launchWebAuthFlow → relay mints the device token →
// store + start the relay live. No code paste, no reload. If the auth window
// fails (popup blocked, flow error, 2nd-profile quirks), fall back to the
// automatic tab-poll flow — the manual pairing code stays as the LAST resort.
async function onSignIn() {
  const btn = $('signin-btn');
  btn.disabled = true;
  showMsg('Opening the sign-in window…', 'ok');
  try {
    let userId;
    try {
      ({ userId } = await authorizeViaWebAuthFlow($('relayBase').value));
    } catch {
      showMsg('Opening a sign-in tab instead…', 'ok');
      ({ userId } = await authorizeViaTabPoll($('relayBase').value));
    }
    const live = await bringRelayUp();
    showMsg(live
      ? `Connected${userId ? ` as ${userId}` : ''}. The cloud relay is now active.`
      : `Connected${userId ? ` as ${userId}` : ''}. Reloading FastLink to apply…`, 'ok');
    if (live) render();
  } catch (e) {
    showMsg(e?.message || String(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

async function onPair() {
  const btn = $('pair-btn');
  const relayBase = $('relayBase').value;
  const code = $('code').value;
  btn.disabled = true;
  showMsg('Pairing…', 'ok');
  try {
    const { userId } = await claimPairingCode(code, relayBase);
    const live = await bringRelayUp();
    showMsg(live
      ? `Paired${userId ? ` as ${userId}` : ''}. The cloud relay is now active.`
      : `Paired${userId ? ` as ${userId}` : ''}. Reloading FastLink to connect…`, 'ok');
    if (live) render();
  } catch (e) {
    showMsg(e?.message || String(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Relay control buttons: Stop/Resume driving (pause gate) + Disconnect/Reconnect
// the cloud relay. Mirrors the toolbar popup so the controls live in both places.
// Both go through background message handlers. The pause flag is a session key.
// ---------------------------------------------------------------------------
const PAUSE_KEY = 'fastlink.drivingPaused';

async function isPaused() {
  try { const s = await chrome.storage.session.get(PAUSE_KEY); return !!s?.[PAUSE_KEY]; } catch { return false; }
}

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
}

async function onPauseToggle() {
  const paused = await isPaused();
  try { await chrome.runtime.sendMessage({ type: 'fastlink:driving-pause', paused: !paused }); } catch {}
  renderControls();
}

async function onDisconnectToggle() {
  const act = $('disconnect-btn').dataset.act;
  const type = act === 'reconnect' ? 'fastlink:relay-reconnect' : 'fastlink:relay-stop';
  try { await chrome.runtime.sendMessage({ type }); } catch {}
  renderControls();
}

// Advanced control = coordinate clicks/typing, running scripts, and background-
// tab capture (all via CDP/debugger). The `debugger` permission is REQUIRED in
// the manifest (MV3 rejects it as optional), so this is a SOFT runtime toggle: a
// chrome.storage.local `advancedControl` flag that the CDP gate reads. Default
// ON when unset (the permission is granted, so the capability is available
// unless the user turns it off). No chrome.permissions.add/remove — removing a
// required permission errors with "can't turn off required permissions".
const ADVANCED_CONTROL_KEY = 'advancedControl';

async function isAdvancedControlOn() {
  try { const o = await chrome.storage.local.get(ADVANCED_CONTROL_KEY); return o[ADVANCED_CONTROL_KEY] !== false; }
  catch { return true; }
}

async function renderDebugger() {
  const pill = $('dbg-pill');
  const btn = $('dbg-btn');
  const detail = $('dbg-detail');
  if (!pill || !btn) return;
  const on = await isAdvancedControlOn();
  if (on) {
    pill.textContent = 'On'; pill.className = 'pill ok badge';
    btn.textContent = 'Disable advanced control'; btn.dataset.act = 'disable';
    detail.textContent = 'Advanced control grants coordinate clicks/typing, running scripts, and background-tab capture.';
  } else {
    pill.textContent = 'Off'; pill.className = 'pill off badge';
    btn.textContent = 'Enable advanced control'; btn.dataset.act = 'enable';
    detail.textContent = 'DOM-only mode — clicks/fills by selector still work. Enable for coordinate clicks/typing, scripts, and background-tab capture.';
  }
}

async function onToggleDebugger() {
  const btn = $('dbg-btn');
  btn.disabled = true;
  try {
    const enable = btn.dataset.act === 'enable';
    await chrome.storage.local.set({ [ADVANCED_CONTROL_KEY]: enable });
    showMsg(enable
      ? 'Advanced control enabled — coordinate clicks/typing, scripts, and background-tab capture are on.'
      : 'Advanced control disabled — FastLink is back to DOM-only (selector clicks/fills still work).', 'ok');
  } catch (e) {
    showMsg(e?.message || String(e), 'err');
  } finally {
    btn.disabled = false;
    renderDebugger();
  }
}

// ---------------------------------------------------------------------------
// THIS BROWSER'S NAME (cloud relay). The relay twin of the Broker-slot card
// below: one unique NAME per browser so a chat can say which browser to drive
// (fast_profile install:"<name>"). Same sanitizing rule as the broker slot, so a
// name means the same thing on both transports.
//
// The relay is authoritative (names live in D1, selection lives in the user's
// Durable Object). This page reads/writes them through {base}/devices, authed
// with the device token this browser already holds — exactly like the
// site-permission card. Nothing is mirrored into chrome.storage: a second
// copy of a name would just be a way to disagree with the relay.
// ---------------------------------------------------------------------------
const RELAY_NAME_ERRORS = {
  invalid_device_token: 'This browser is no longer paired — re-pair it in Connection above.',
  invalid_name: 'Use letters, digits, "-" or "_" (e.g. "work"), starting with a letter or digit.',
  reserved_name: '“auto”, “default” and “none” are reserved words — pick another name.',
  name_taken: 'Another browser on your account already uses that name. Pick a different one.',
  unknown_device: 'The relay doesn’t recognise this browser — re-pair it in Connection above.',
  invalid_json: 'The relay rejected the request.',
};

function relayNameMsg(text, kind) {
  const el = $('relay-name-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = kind ? `msg ${kind}` : 'msg';
}

async function devicesFetch(method, body) {
  const c = await chrome.storage.local.get(['relayBase', 'deviceToken']);
  if (!c.deviceToken) return null;                       // not paired — card renders its empty state
  const base = String(c.relayBase || DEFAULT_RELAY_BASE).replace(/\/+$/, '');
  const url = `${base}/devices`;
  const res = method === 'GET'
    ? await fetch(`${url}?deviceToken=${encodeURIComponent(c.deviceToken)}`)
    : await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceToken: c.deviceToken, ...body }),
      });
  let b = {};
  try { b = await res.json(); } catch {}
  if (!res.ok) throw new Error(RELAY_NAME_ERRORS[b?.error] || b?.error || `Request failed (HTTP ${res.status}).`);
  return b;
}

// Paint the card from a /devices payload: this browser's name, the account
// default, and every browser with its live connection state.
function paintRelayDevices(data) {
  const list = $('relay-devices');
  const input = $('relay-name');
  const toggle = $('relay-default-toggle');
  if (!list) return;
  list.replaceChildren();

  if (!data) {
    if (input) { input.value = ''; input.disabled = true; }
    if (toggle) toggle.disabled = true;
    const p = document.createElement('div');
    p.className = 'perm-empty';
    p.textContent = 'Pair this browser with the cloud relay (above) to name it.';
    list.append(p);
    return;
  }

  if (input) {
    input.disabled = false;
    // Don't clobber what the user is mid-way through typing.
    if (document.activeElement !== input) input.value = data.self || '';
  }
  if (toggle) {
    toggle.disabled = false;
    toggle.checked = !!(data.self && data.default === data.self);
  }

  const devices = Array.isArray(data.devices) ? data.devices : [];
  if (!devices.length) {
    const p = document.createElement('div');
    p.className = 'perm-empty';
    p.textContent = 'No browsers paired to this account yet.';
    list.append(p);
    return;
  }

  for (const d of devices) {
    const item = document.createElement('div');
    item.className = 'perm-item';

    const dot = document.createElement('span');
    dot.className = 'fl-dot ' + (d.connected ? 'ok' : 'err');

    const nameEl = document.createElement('span');
    nameEl.className = 'host';
    nameEl.textContent = d.name;

    const tags = document.createElement('span');
    tags.className = 'fine';
    const bits = [d.connected ? 'connected' : 'offline'];
    if (d.self) bits.push('this browser');
    if (data.default === d.name) bits.push('default');
    tags.textContent = bits.join(' · ');

    item.append(dot, nameEl, tags);
    list.append(item);
  }
}

async function renderRelayDevices() {
  try {
    paintRelayDevices(await devicesFetch('GET'));
  } catch (e) {
    paintRelayDevices(null);
    relayNameMsg(e?.message || String(e), 'err');
  }
}

async function onSaveRelayName() {
  const btn = $('relay-name-btn');
  const raw = ($('relay-name').value || '').trim();
  if (!raw) { relayNameMsg('Enter a name for this browser first.', 'info'); return; }
  // Sanitize client-side with the SAME rule the relay applies, so the user sees
  // what will actually be stored instead of a silent normalization.
  const name = sanitizeInstallId(raw);
  if (!name) { relayNameMsg(RELAY_NAME_ERRORS.invalid_name, 'err'); return; }
  btn.disabled = true;
  relayNameMsg('Saving…', 'info');
  try {
    const data = await devicesFetch('POST', { name });
    if (!data) { relayNameMsg('Pair this browser with the cloud relay first.', 'err'); return; }
    paintRelayDevices(data);
    relayNameMsg(`This browser is now “${data.self}”. Tell a chat to drive it with fast_profile install:"${data.self}".`, 'ok');
  } catch (e) {
    relayNameMsg(e?.message || String(e), 'err');
    renderRelayDevices();   // revert the field to what the relay actually holds
  } finally {
    btn.disabled = false;
  }
}

async function onRelayDefaultToggle(e) {
  const makeDefault = !!e.target.checked;
  relayNameMsg('Saving…', 'info');
  try {
    const data = await devicesFetch('POST', { makeDefault });
    if (!data) return;
    paintRelayDevices(data);
    relayNameMsg(makeDefault
      ? `Chats that don't pick a browser now drive “${data.self}”.`
      : 'Cleared the default — chats that don\'t pick a browser drive whichever connected most recently.', 'ok');
  } catch (err) {
    relayNameMsg(err?.message || String(err), 'err');
    renderRelayDevices();
  }
}

// Broker slot LABEL (chrome.storage.local 'fastlinkInstallId', default 'primary').
// Mirrors connection.js. Presets have a dedicated <option>; any other stored
// value is a custom label shown via the "Custom label…" option.
const INSTALL_ID_KEY = 'fastlinkInstallId';
const PRESET_INSTALL_IDS = ['primary', 'secondary'];
const CUSTOM_OPTION = '__custom__';

// Slot key, mirrors broker/server/connection.js: lowercase [a-z0-9_-], alnum first, ≤32.
function sanitizeInstallId(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[-_]+/, '').slice(0, 32);
}

async function renderInstallSlot() {
  const sel = $('install-select');
  if (!sel) return;
  let id = 'primary';
  try { const o = await chrome.storage.local.get(INSTALL_ID_KEY); id = sanitizeInstallId(o[INSTALL_ID_KEY]) || 'primary'; }
  catch {}
  const customRow = $('install-custom-row');
  const customInput = $('install-custom');
  if (PRESET_INSTALL_IDS.includes(id)) {
    sel.value = id;
    if (customRow) customRow.hidden = true;
  } else {
    // Stored custom label → Custom option + show it in the input.
    sel.value = CUSTOM_OPTION;
    if (customInput) customInput.value = id;
    if (customRow) customRow.hidden = false;
  }
  renderSlotBusy();
}

// The broker rejects a profile whose slot is already held by another live
// profile (connection.js writes `fastlinkSlotBusy` on that signal). Surface it
// here, pointing at a free slot, so the user knows exactly which knob to turn.
async function renderSlotBusy() {
  const el = $('slot-busy-warn');
  if (!el) return;
  let info = null;
  try { const o = await chrome.storage.local.get('fastlinkSlotBusy'); info = o?.fastlinkSlotBusy || null; }
  catch {}
  if (!info) { el.hidden = true; return; }
  const busy = info.install || 'primary';
  const free = (Array.isArray(info.knownInstalls) ? info.knownInstalls : PRESET_INSTALL_IDS).find((s) => s !== busy)
    || (busy === 'primary' ? 'secondary' : 'primary');
  el.innerHTML = `⚠️ <strong>This slot (“${busy}”) is already in use by another Chrome profile.</strong> `
    + `FastLink can't connect here until you move this profile to a free slot — switch it to <strong>${free === 'secondary' ? 'Secondary' : 'Primary'}</strong> below.`;
  el.hidden = false;
}

// Persist slot label + reload so background.js reconnects on it.
async function commitInstallSlot(id, humanLabel) {
  try {
    await chrome.storage.local.set({ [INSTALL_ID_KEY]: id });
    showMsg(`Broker slot set to ${humanLabel}. Reloading FastLink to reconnect…`, 'ok');
    setTimeout(() => chrome.runtime.reload(), 600);
  } catch (e) {
    showMsg(e?.message || String(e), 'err');
  }
}

function onInstallSlotChange() {
  const sel = $('install-select');
  const customRow = $('install-custom-row');
  if (sel.value === CUSTOM_OPTION) {
    // Reveal input, wait for Apply — don't store/reload yet.
    if (customRow) customRow.hidden = false;
    const input = $('install-custom');
    if (input) input.focus();
    return;
  }
  if (customRow) customRow.hidden = true;
  const id = PRESET_INSTALL_IDS.includes(sel.value) ? sel.value : 'primary';
  commitInstallSlot(id, id === 'secondary' ? 'Secondary (port 9877)' : 'Primary (port 9876)');
}

function onApplyCustomInstall() {
  const input = $('install-custom');
  const id = sanitizeInstallId(input?.value);
  if (!id) { showMsg('Enter a label using letters, digits, "-" or "_" (e.g. "work").', 'err'); return; }
  if (PRESET_INSTALL_IDS.includes(id)) { showMsg(`"${id}" is a preset slot — pick it from the dropdown instead.`, 'err'); return; }
  commitInstallSlot(id, `“${id}” (custom · shares port 9876)`);
}

// ---------------------------------------------------------------------------
// Desktop notifications. Mirrors the toolbar popup's toggle (fastlinkNotify in
// chrome.storage.local) so the setting is editable from here too.
// ---------------------------------------------------------------------------
async function renderNotifyToggle() {
  try {
    const o = await chrome.storage.local.get('fastlinkNotify');
    $('notify-toggle').checked = !!o?.fastlinkNotify;
  } catch {}
}

// ---------------------------------------------------------------------------
// Site permissions manager (SIGNUP-SPEC §4.2). Per-origin relay consent. The
// authoritative store is the relay; chrome.storage.local 'fastlinkConsentDecisions'
// is a local mirror ({ [origin]: 'allow'|'readonly'|'block' }) the popup also
// writes. Here we list every decided origin and let the user change/remove it.
// Changing posts to the relay (POST {base}/consent) AND updates the mirror, so
// both pages stay in sync; removing clears only the local record.
// ---------------------------------------------------------------------------
const DECISIONS_KEY = 'fastlinkConsentDecisions';
const PERM_LABEL = { allow: 'Allowed', readonly: 'Read-only', block: 'Blocked' };

function permMsg(text, kind) {
  const el = $('perm-msg');
  el.textContent = text;
  el.className = kind ? `msg ${kind}` : 'msg';
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
      invalid_device_token: 'This browser is no longer paired — re-pair it in Connection above.',
      invalid_mode: 'Unsupported permission choice.',
      invalid_origin: 'Could not determine this site’s origin.',
      invalid_json: 'The relay rejected the request.',
    };
    throw new Error(FRIENDLY[b?.error] || b?.error || `Consent update failed (HTTP ${res.status}).`);
  }
}

async function renderPermissions() {
  const list = $('perm-list');
  const c = await chrome.storage.local.get([DECISIONS_KEY, 'deviceToken']);
  const decisions = c[DECISIONS_KEY] || {};
  const origins = Object.keys(decisions).sort();
  list.replaceChildren();

  if (!c.deviceToken) {
    const p = document.createElement('div');
    p.className = 'perm-empty';
    p.textContent = 'Pair this browser with the cloud relay (Connection above) to manage site permissions.';
    list.append(p);
    return;
  }
  if (origins.length === 0) {
    const p = document.createElement('div');
    p.className = 'perm-empty';
    p.textContent = 'No site decisions yet. They appear here as Claude touches sites, or add one below.';
    list.append(p);
    return;
  }

  for (const origin of origins) {
    const mode = decisions[origin];
    const item = document.createElement('div');
    item.className = 'perm-item';

    let host = origin;
    try { host = new URL(origin).host; } catch {}
    const hostEl = document.createElement('span');
    hostEl.className = 'host';
    hostEl.title = origin;
    hostEl.textContent = host;

    const sel = document.createElement('select');
    for (const m of ['allow', 'readonly', 'block']) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = PERM_LABEL[m];
      if (m === mode) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener('change', () => changePermission(origin, sel.value));

    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.title = 'Remove this record';
    rm.textContent = '×';
    rm.addEventListener('click', () => removePermission(origin));

    item.append(hostEl, sel, rm);
    list.append(item);
  }
}

async function changePermission(origin, mode) {
  permMsg('Saving…', 'info');
  try {
    await postConsent(origin, mode);
    const c = await chrome.storage.local.get(DECISIONS_KEY);
    const decisions = { ...(c[DECISIONS_KEY] || {}), [origin]: mode };
    await chrome.storage.local.set({ [DECISIONS_KEY]: decisions });
    permMsg(`${origin} set to ${PERM_LABEL[mode]}.`, 'ok');
  } catch (e) {
    permMsg(e?.message || String(e), 'err');
    renderPermissions();   // revert the select to the stored value
  }
}

async function removePermission(origin) {
  try {
    const c = await chrome.storage.local.get(DECISIONS_KEY);
    const decisions = { ...(c[DECISIONS_KEY] || {}) };
    delete decisions[origin];
    await chrome.storage.local.set({ [DECISIONS_KEY]: decisions });
    permMsg(`Removed the local record for ${origin}. The relay may still hold a decision until changed.`, 'info');
  } catch (e) {
    permMsg(e?.message || String(e), 'err');
  }
}

async function onAddPermission() {
  const raw = ($('perm-origin').value || '').trim();
  const mode = $('perm-mode').value;
  if (!raw) { permMsg('Enter a site URL (e.g. https://example.com).', 'info'); return; }
  let origin;
  try { origin = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).origin; }
  catch { permMsg('That doesn’t look like a valid URL.', 'err'); return; }
  await changePermission(origin, mode);
  $('perm-origin').value = '';
  renderPermissions();
}

async function onUseLocal() {
  // Disable the cloud relay, keep the local broker. Writes the explicit flags
  // (and the legacy fastlinkMode for back-compat). Does not server-revoke the
  // device — the token simply stops being dialed.
  await chrome.storage.local.set({ fastlinkMode: 'local', localEnabled: true, relayEnabled: false });
  await chrome.storage.local.remove(['relayAuthError']);
  showMsg('Cloud relay disabled — using the local broker. Reloading FastLink…', 'ok');
  setTimeout(() => chrome.runtime.reload(), 600);
}

// Deep-link handoff: the relay's pairing page (or its copyable link) can open
// this page with ?relay=<url>&code=<code> to pre-fill both fields. Returns true
// when a code was supplied so the caller can auto-run the pairing.
function applyDeepLinkParams() {
  let params;
  try { params = new URLSearchParams(location.search); } catch { return false; }
  const relay = params.get('relay');
  const code = params.get('code');
  if (relay) $('relayBase').value = relay;
  if (code) $('code').value = code;
  return !!code;
}

// Persist the relay base whenever the user edits it, so it's pre-filled next time.
$('relayBase').addEventListener('change', () => {
  const v = $('relayBase').value.trim();
  if (v) chrome.storage.local.set({ relayBase: v });
  syncGenCodeLink();
});

$('signin-btn').addEventListener('click', onSignIn);
$('pair-btn').addEventListener('click', onPair);
$('local-btn').addEventListener('click', onUseLocal);
$('pause-btn').addEventListener('click', onPauseToggle);
$('disconnect-btn').addEventListener('click', onDisconnectToggle);
$('dbg-btn').addEventListener('click', onToggleDebugger);
$('relay-name-btn').addEventListener('click', onSaveRelayName);
$('relay-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') onSaveRelayName(); });
$('relay-default-toggle').addEventListener('change', onRelayDefaultToggle);
$('install-select').addEventListener('change', onInstallSlotChange);
$('install-custom-apply').addEventListener('click', onApplyCustomInstall);
$('install-custom').addEventListener('keydown', (e) => { if (e.key === 'Enter') onApplyCustomInstall(); });
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') onPair(); });

$('notify-toggle').addEventListener('change', (e) => {
  chrome.storage.local.set({ fastlinkNotify: !!e.target.checked }).catch(() => {});
});

$('perm-add-btn').addEventListener('click', onAddPermission);
$('perm-origin').addEventListener('keydown', (e) => { if (e.key === 'Enter') onAddPermission(); });

$('reload-btn').addEventListener('click', () => chrome.runtime.reload());

// Live-refresh the page while it's open as transports connect / settings change
// (e.g. from the popup or another view).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.fastlinkConn || changes.relayAuthError) render();
    if (changes.deviceToken || changes.relayEnabled || changes.fastlinkMode) { render(); renderControls(); renderRelayDevices(); }
    if (changes[ADVANCED_CONTROL_KEY]) renderDebugger();
    if (changes.fastlinkNotify) renderNotifyToggle();
    if (changes.fastlinkSlotBusy) renderSlotBusy();
    if (changes[DECISIONS_KEY] || changes.deviceToken) renderPermissions();
  }
  if (area === 'session' && changes[PAUSE_KEY]) renderControls();
});

// Show the running extension version in the header + About card.
try {
  const v = 'v' + chrome.runtime.getManifest().version;
  const verEl = $('version'); if (verEl) verEl.textContent = v;
  const aboutEl = $('about-version'); if (aboutEl) aboutEl.textContent = v;
} catch {}

async function init() {
  await render();
  renderControls();
  renderDebugger();
  renderInstallSlot();
  renderNotifyToggle();
  renderPermissions();
  renderRelayDevices();
  // Deep-link params win over stored/default values (they reflect a fresh code).
  // Auto-pair: a deep-linked code is fresh (just minted on the relay), so run the
  // pairing immediately — but only once per page load, and never when this browser
  // already holds an active pairing (an accidental re-open must not silently
  // re-mint a device token over the existing one).
  if (applyDeepLinkParams() && !autoPairRan) {
    autoPairRan = true;
    const c = await chrome.storage.local.get(['deviceToken', 'relayEnabled', 'fastlinkMode']);
    const alreadyPaired = !!c.deviceToken && !(c.relayEnabled === false || c.fastlinkMode === 'local');
    if (alreadyPaired) {
      $('pair-btn').focus();
      showMsg('Pairing code loaded — this browser is already paired; click "Pair with code" to re-pair anyway.', 'ok');
    } else {
      onPair();
    }
  }
}
// One-shot guard for the deep-link auto-pair (init only runs once, but keep the
// intent explicit and future-proof against re-entrant init calls).
let autoPairRan = false;
init();
