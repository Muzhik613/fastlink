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
  name_taken: 'Another browser on your account already uses that name. Pick a different one.',
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

// The relay's auto-assigned default for a fresh pairing (browser-1, browser-2…).
export function isAutoName(name) {
  return /^browser-\d+$/.test(String(name || ''));
}

// A sensible pre-fill: the device kind, made unique against the account's
// other browsers (chromebook, chromebook-2, …).
export function suggestName(devices) {
  const p = String(navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
  const base = /cros|chrome ?os/.test(p) ? 'chromebook'
    : /win/.test(p) ? 'windows-pc'
    : /mac/.test(p) ? 'mac'
    : /linux/.test(p) ? 'linux-pc'
    : 'my-browser';
  const taken = new Set((devices || []).filter((d) => !d.self).map((d) => d.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// GET (no body) or POST {name} / {makeDefault} to {base}/devices.
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
  if (!res.ok) throw new Error(RELAY_NAME_ERRORS[b?.error] || b?.error || `Request failed (HTTP ${res.status}).`);
  return b;
}
