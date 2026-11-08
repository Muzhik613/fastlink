// browserName.js — this browser's NAME on the cloud relay, shared by the
// onboarding page (post-pair "Name this browser" step) and the options page
// ("This browser's name" card).
//
// The relay is authoritative: names live in D1 and are read/written through
// {base}/devices, authed with this browser's device token. Nothing is mirrored
// into chrome.storage. The relay sanitizes names
// (lowercase [a-z0-9_-], alnum first, ≤32 — fastlink-relay/src/db.js
// sanitizeDeviceName); slugifyName turns a human name ("Shuli's Chromebook")
// into that form ("shulis-chromebook") BEFORE sending, so the user sees what
// will actually be stored.

const DEFAULT_RELAY_BASE = 'https://relay.ytx.app';

export const RELAY_NAME_ERRORS = {
  invalid_device_token: 'This browser is no longer paired — pair it again above.',
  invalid_name: 'Use letters, digits, spaces, "-" or "_" (e.g. "Home laptop").',
  reserved_name: '“auto”, “default” and “none” are reserved words — pick another name.',
  name_taken: 'Another browser on your account is online with that name. Pick a different one.',
  name_taken_offline: 'An offline browser on your account has that name.',
  unknown_device: 'The relay doesn’t recognise this browser — pair it again above.',
  invalid_json: 'The relay rejected the request.',
};

// Human name → relay name. Apostrophes vanish, any other run of disallowed
// characters (spaces included) becomes one "-".
export function slugifyName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

// The default name a browser pairs with: the device kind. The relay makes it unique
// (mac, mac-2, …). It is only a suggestion: until the user saves a name, the
// onboarding and options pages treat it as unnamed and ask for one.
const DEFAULT_BASES = ['chromebook', 'windows-pc', 'mac', 'linux-pc', 'my-browser'];
export function defaultBaseName() {
  let p = '';
  try { p = String(navigator.userAgentData?.platform || navigator.platform || '').toLowerCase(); } catch {}
  return /cros|chrome ?os/.test(p) ? 'chromebook'
    : /win/.test(p) ? 'windows-pc'
    : /mac/.test(p) ? 'mac'
    : /linux/.test(p) ? 'linux-pc'
    : 'my-browser';
}

// Not yet named by the user: the relay's generic browser-N, or a device-kind default.
export function isAutoName(name) {
  const n = String(name || '');
  return /^browser-\d+$/.test(n) || DEFAULT_BASES.some((b) => n === b || new RegExp(`^${b}-\\d+$`).test(n));
}

// A pre-fill for the name box: the device kind, made unique against the account's
// other browsers (chromebook, chromebook-2, …).
export function suggestName(devices) {
  const base = defaultBaseName();
  const taken = new Set((devices || []).filter((d) => !d.self).map((d) => d.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// GET (no body) or POST {name} to {base}/devices.
// Returns null when this browser isn't paired.
export async function devicesFetch(method, body) {
  const c = await chrome.storage.local.get(['relayBase', 'deviceToken']);
  if (!c.deviceToken) return null;
  const url = `${String(c.relayBase || DEFAULT_RELAY_BASE).replace(/\/+$/, '')}/devices`;
  const res = method === 'GET'
    ? await fetch(`${url}?deviceToken=${encodeURIComponent(c.deviceToken)}`)
    : await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceToken: c.deviceToken, ...body }),
      });
  let b = {};
  try { b = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(RELAY_NAME_ERRORS[b?.error] || b?.error || `Request failed (HTTP ${res.status}).`);
    err.code = b?.error || null;
    err.lastSeen = b?.lastSeen || null;
    throw err;
  }
  return b;
}

// Save this browser's name. If an OFFLINE browser on the account holds it (usually this
// same browser before it was removed and loaded again, which re-pairs it), ask the user
// and, on yes, take the name over: the relay revokes that stale entry. A name held by a
// browser that is online right now is never taken.
export async function saveBrowserName(name) {
  try {
    return await devicesFetch('POST', { name });
  } catch (e) {
    if (e?.code !== 'name_taken_offline') throw e;
    const when = e.lastSeen ? new Date(e.lastSeen).toLocaleString() : 'a while ago';
    const ok = confirm(`"${name}" belongs to a browser on your account that is offline (last seen ${when}).\n\nIf that was this browser before an update or reinstall, replace it: the old entry is removed and this browser takes the name.\n\nReplace it?`);
    if (!ok) throw new Error('Name not changed. Pick a different name, or replace the offline browser.');
    return await devicesFetch('POST', { name, replace: true });
  }
}
