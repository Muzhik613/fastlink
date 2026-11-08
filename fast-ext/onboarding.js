// onboarding.js — first-run flow (SIGNUP-SPEC §2, §3 ext-auth).
// Step 1: pair this browser with the relay — two equal, side-by-side ways:
//   • "Sign in & connect": chrome.identity.launchWebAuthFlow, falling back to
//     the automatic sign-in tab (authorizeViaTabPoll) if the window fails;
//   • a pairing code from {relay}/pair/new (no Google sign-in in this browser).
//   Either way background.js brings the relay up LIVE (no extension reload), so
//   this page survives to show the next steps.
// Step 2: right after a pairing, ALWAYS prompt for this browser's name (the
//   name fast_status / fast_profile show), pre-filled when the relay only gave
//   it an auto name (browser-N).
// Step 3: plain steps to add the connector URL to claude.ai / other AI apps.

import { authorizeViaWebAuthFlow, authorizeViaTabPoll, claimPairingCode } from './src/relayClient.js';
import { devicesFetch, saveBrowserName, slugifyName, suggestName, isAutoName } from './src/browserName.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_RELAY_BASE = 'https://relay.ytx.app';

function showMsg(text, kind, id = 'msg') {
  const el = $(id);
  el.textContent = text;
  el.className = kind ? `msg ${kind}` : 'msg';
}

function relayBaseValue() {
  return ($('relayBase').value || '').trim() || DEFAULT_RELAY_BASE;
}

const trimBase = (base) => String(base || DEFAULT_RELAY_BASE).replace(/\/+$/, '');

// Reflect connection state into the step cards. Steps 2–4 unlock once paired.
function paintConnected(connected, relayBase) {
  const pill = $('conn-pill');
  const step1 = $('step1');
  $('connector-url').textContent = `${trimBase(relayBase)}/mcp`;

  const later = ['step2', 'step3', 'step4'];
  if (connected) {
    pill.textContent = 'Connected';
    pill.className = 'pill ok';
    step1.classList.remove('locked'); step1.classList.add('done');
    $('num1').textContent = '✓';
    $('step1-detail').textContent = 'This browser is paired. To pair it again (e.g. with a different account), use either option below.';
    $('signin-btn').textContent = 'Sign in again';
    $('signin-btn').classList.remove('primary'); $('signin-btn').classList.add('ghost');
    later.forEach((id) => $(id).classList.remove('locked'));
  } else {
    pill.textContent = 'Not connected';
    pill.className = 'pill off';
    step1.classList.remove('done'); step1.classList.add('locked');
    later.forEach((id) => $(id).classList.add('locked'));
  }
  $('name-input').disabled = !connected;
  $('name-btn').disabled = !connected;
}

// After a pairing (fresh or re-pair): background (re)starts the relay transport
// live with the new token — no extension reload, so this page survives. Only if
// background is unreachable do we reload to pick up the new config.
async function bringRelayUp() {
  try {
    await chrome.runtime.sendMessage({ type: 'fastlink:relay-paired' });
    return true;
  } catch {
    setTimeout(() => chrome.runtime.reload(), 600);
    return false;
  }
}

// Shared tail of both pairing ways: go live, then prompt for a name.
async function afterPair(base, userId) {
  if (!(await bringRelayUp())) return;
  paintConnected(true, base);
  showMsg(`Connected${userId ? ` as ${userId}` : ''}.`, 'ok');
  await loadName({ prompt: true });
}

async function onSignIn() {
  const btn = $('signin-btn');
  btn.disabled = true;
  $('signin-hint').textContent = 'Opening sign-in…';
  showMsg('Opening the sign-in window…', 'info');
  try {
    const base = relayBaseValue();
    let userId;
    try {
      ({ userId } = await authorizeViaWebAuthFlow(base));
    } catch {
      $('signin-hint').textContent = 'Opening a sign-in tab instead…';
      showMsg('Opening a sign-in tab instead…', 'info');
      ({ userId } = await authorizeViaTabPoll(base));
    }
    await afterPair(base, userId);
  } catch (e) {
    showMsg(e?.message || String(e), 'err');
  } finally {
    btn.disabled = false;
    $('signin-hint').textContent = '';
  }
}

async function onManualPair() {
  const btn = $('pair-btn');
  btn.disabled = true;
  showMsg('Pairing…', 'info');
  try {
    const base = relayBaseValue();
    const { userId } = await claimPairingCode($('code').value, base);
    await afterPair(base, userId);
  } catch (e) {
    showMsg(e?.message || String(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

// ---- step 2: name ----------------------------------------------------------
// Once the user edits the field, relay refreshes never overwrite it.
let nameDirty = false;

function paintPreview() {
  const slug = slugifyName($('name-input').value);
  const el = $('name-preview');
  el.replaceChildren();
  if (!slug) return;
  const s = document.createElement('span');
  s.className = 'slug';
  s.textContent = slug;
  el.append('The AI will see it as ', s, '.');
}

function markNamed(named) {
  const step2 = $('step2');
  step2.classList.toggle('done', named);
  step2.classList.toggle('attention', !named);
  $('num2').textContent = named ? '✓' : '2';
}

// Read this browser's name from the relay. An auto name (browser-N) counts as
// unnamed: pre-fill a suggestion and, after a fresh pairing, pull focus here.
async function loadName({ prompt = false } = {}) {
  let data;
  try { data = await devicesFetch('GET'); } catch (e) { showMsg(e?.message || String(e), 'err', 'name-msg'); return; }
  if (!data) return;
  const input = $('name-input');
  const unnamed = !data.self || isAutoName(data.self);
  input.placeholder = `e.g. ${suggestName(data.devices)}`;
  if (!nameDirty) input.value = unnamed ? '' : data.self;
  paintPreview();
  markNamed(!unnamed);
  if (unnamed && prompt) {
    $('step2').scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.focus();
    input.select();
    showMsg('Now give this browser a name, then Save.', 'info', 'name-msg');
  }
}

async function onSaveName() {
  const name = slugifyName($('name-input').value);
  if (!name) { showMsg('Type a name for this browser first.', 'err', 'name-msg'); return; }
  const btn = $('name-btn');
  btn.disabled = true;
  showMsg('Saving…', 'info', 'name-msg');
  try {
    const data = await saveBrowserName(name);
    if (!data) { showMsg('Pair this browser first (step 1).', 'err', 'name-msg'); return; }
    $('name-input').value = data.self;
    nameDirty = false;
    paintPreview();
    markNamed(true);
    showMsg(`Saved — this browser is “${data.self}”.`, 'ok', 'name-msg');
    $('step3').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    showMsg(e?.message || String(e), 'err', 'name-msg');
  } finally {
    btn.disabled = false;
  }
}

// Copy the text of element `srcId` and flash the button `btnId`.
async function copyText(srcId, btnId) {
  const text = $(srcId).textContent;
  try {
    await navigator.clipboard.writeText(text);
    const b = $(btnId);
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  } catch {
    showMsg(`Copy failed — select and copy manually: ${text}`, 'err');
  }
}

// Keep the code link pointed at the (possibly customized) relay.
function syncGenCodeLink() {
  const a = $('gen-code');
  const url = `${trimBase(relayBaseValue())}/pair/new`;
  a.href = url;
  a.textContent = url.replace(/^https?:\/\//, '');
}

$('signin-btn').addEventListener('click', onSignIn);
$('pair-btn').addEventListener('click', onManualPair);
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') onManualPair(); });
$('name-btn').addEventListener('click', onSaveName);
$('name-input').addEventListener('input', () => { nameDirty = true; paintPreview(); });
$('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') onSaveName(); });
$('copy-btn').addEventListener('click', () => copyText('connector-url', 'copy-btn'));
$('cc-copy-btn').addEventListener('click', () => copyText('cc-cmd', 'cc-copy-btn'));
$('relayBase').addEventListener('input', syncGenCodeLink);

// Live-refresh if the relay connects/drops while this page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.fastlinkConn || changes.deviceToken || changes.relayAuthError) refresh();
});

async function refresh() {
  const c = await chrome.storage.local.get(['deviceToken', 'relayBase', 'fastlinkConn', 'relayEnabled']);
  const base = c.relayBase || DEFAULT_RELAY_BASE;
  if (c.relayBase) $('relayBase').value = c.relayBase;
  const relayDisabled = c.relayEnabled === false;
  const connected = !!c.deviceToken && !relayDisabled;
  paintConnected(connected, base);
  syncGenCodeLink();
  if (connected) loadName();
}

refresh();
