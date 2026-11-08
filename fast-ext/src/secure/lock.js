// lock.js — the secure build's lock: which helper may drive this browser (the holder
// of the lock key) and which sites it may use (the allowlist). Both are SETTINGS: the
// owner changes them in the options page. The driving helper may REMOVE sites with a
// sealed `set_allowlist` call; it may add sites only if the owner allowed that in the
// options (`remoteAdd`). Nothing here needs a new build.
//
// Fixed behaviour in the secure build (SECURE_BUILD, ./build.js — checked by the callers,
// not here): every call must be sealed with the lock key. Unsealed calls, and all calls
// before a lock is set, are refused. Format: ./sealed.js. Owner notes: ./README.md.
import { deriveKeys, seal, unseal } from './sealed.js';

const STORE_KEY = 'fastlink.lock';        // chrome.storage.local: { code, allowlist[], remoteAdd, seen[] }
export const MAX_SKEW_MS = 60_000;        // a sealed request older/newer than this is refused
// Replay window: the last SEEN_MAX request numbers. A number already seen, or below the
// window, is refused; numbers may arrive out of order (two scripts driving at once).
export const SEEN_MAX = 64;

// Actions that never read or change a page (they only list/switch/close tabs).
const NO_PAGE = new Set(['fast_list', 'fast_switch', 'fast_close']);
// Actions whose `url` argument is a navigation target.
const NAVIGATES = new Set(['fast_nav', 'fast_tab']);

let state = null;   // { keys, allowlist, remoteAdd, seen } while locked, else null

// --- allowlist ---------------------------------------------------------------

// "https://www.bank.com/login" | "www.bank.com" | "*.bank.com" → "www.bank.com" | "*.bank.com"
export function normalizeEntry(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  const wild = s.startsWith('*.');
  if (wild) s = s.slice(2);
  try { s = new URL(s.includes('://') ? s : `https://${s}`).hostname; } catch { return ''; }
  if (!/^[a-z0-9.-]+$/.test(s) || !s.includes('.')) return '';
  return wild ? `*.${s}` : s;
}

export function normalizeAllowlist(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)) {
    const n = normalizeEntry(e);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

// Is `url` an https page on the allowlist? "*.bank.com" matches bank.com and its subdomains.
export function urlAllowed(url, allowlist) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return allowlist.some((e) => (e.startsWith('*.') ? host === e.slice(2) || host.endsWith(e.slice(1)) : host === e));
}

// --- state ---------------------------------------------------------------------

export function isLocked() { return !!state; }
export function lockKeyId() { return state ? state.keys.keyId : null; }
export function currentAllowlist() { return state ? [...state.allowlist] : []; }
export function remoteAddAllowed() { return !!state?.remoteAdd; }

export async function loadLock() {
  const saved = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY];
  if (!saved?.code) { state = null; return; }
  try {
    state = { keys: await deriveKeys(saved.code), allowlist: normalizeAllowlist(saved.allowlist), remoteAdd: saved.remoteAdd === true, seen: Array.isArray(saved.seen) ? saved.seen.filter(Number.isSafeInteger) : [] };
  } catch { state = null; }
}

// Options page: set (or replace) the lock. A new code starts a new replay window.
export async function setLock(code, allowlist, { remoteAdd = false } = {}) {
  const keys = await deriveKeys(code);   // validates the code
  const list = normalizeAllowlist(allowlist);
  await chrome.storage.local.set({ [STORE_KEY]: { code: String(code).trim(), allowlist: list, remoteAdd: !!remoteAdd, seen: [] } });
  state = { keys, allowlist: list, remoteAdd: !!remoteAdd, seen: [] };
  return { keyId: keys.keyId, allowlist: list };
}

// Owner (options page): any list, and whether the driving machine may add sites.
// Driving machine (sealed set_allowlist, `remote`): may only remove sites unless remoteAdd.
export async function setAllowlist(allowlist, { remote = false, remoteAdd } = {}) {
  if (!state) throw new Error('not locked');
  const list = normalizeAllowlist(allowlist);
  if (remote && !state.remoteAdd) {
    const added = list.filter((e) => !state.allowlist.includes(e));
    if (added.length) throw new Error(`adding sites (${added.join(', ')}) needs the owner: FastLink options, or allow it there`);
  }
  const saved = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY];
  const flag = remote || remoteAdd === undefined ? state.remoteAdd : !!remoteAdd;
  await chrome.storage.local.set({ [STORE_KEY]: { ...saved, allowlist: list, remoteAdd: flag } });
  state.allowlist = list;
  state.remoteAdd = flag;
  return list;
}

export async function clearLock() {
  await chrome.storage.local.remove(STORE_KEY);
  state = null;
}

// Accept `seq` once: not seen before and not below the window. Persisted, so a reload
// (service-worker restart) doesn't reopen the window.
async function acceptSeq(seq) {
  const seen = state.seen;
  if (!Number.isSafeInteger(seq) || seq <= 0 || seen.includes(seq)) return false;
  if (seen.length >= SEEN_MAX && seq < seen[0]) return false;
  seen.push(seq);
  seen.sort((a, b) => a - b);
  if (seen.length > SEEN_MAX) seen.splice(0, seen.length - SEEN_MAX);
  const saved = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY];
  if (saved) await chrome.storage.local.set({ [STORE_KEY]: { ...saved, seen } });
  return true;
}

// --- calls -------------------------------------------------------------------

// The secure build's gate for an UNSEALED call: always refused.
export function refuseUnsealed() {
  return { error: state
    ? 'This browser is locked: it accepts only sealed calls from its driving machine.'
    : 'This secure browser is not locked yet: set the lock code in FastLink options first.', code: 'locked' };
}

async function tabUrl(tabId) {
  try { return (await chrome.tabs.get(tabId)).url || ''; } catch { return ''; }
}

// Which URLs a call would act on or go to, before it runs. A page action without its own
// tabId is pinned to the current target tab HERE, so the tab that is checked is the tab
// that is acted on (fast_screenshot would otherwise default to the foreground tab).
async function prepare(action, args, targetTabId) {
  const urls = [];
  if (NAVIGATES.has(action) && args.url) urls.push(args.url);
  if (action === 'fast_batch') {
    for (const s of Array.isArray(args.steps) ? args.steps : []) if (s && NAVIGATES.has(s.action) && s.args?.url) urls.push(s.args.url);
  }
  if (NO_PAGE.has(action) || action === 'fast_tab') return { args, urls };
  const id = typeof args.tabId === 'number' ? args.tabId : await targetTabId();
  if (typeof id !== 'number') return { error: 'no target tab' };
  urls.push(await tabUrl(id));
  return { args: { ...args, tabId: id }, urls };
}

// Handle one sealed call. `frame` = the relay call's args ({v, keyId, nonce, ct});
// `run(action, args)` executes a tool exactly like an unsealed call; `targetTabId()`
// returns the browser's current target tab. Returns the reply to send back: a sealed
// frame, or a plain {error} that carries no content (wrong key, replay, not locked).
export async function handleSealed(frame, run, targetTabId) {
  if (!state) return refuseUnsealed();
  let req;
  try { req = await unseal(state.keys, 'req', frame); } catch (e) { return { error: e.message, code: 'sealed' }; }
  const { seq, ts, action } = req || {};
  let args = req?.args && typeof req.args === 'object' ? req.args : {};
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) return { error: 'sealed: request too old (check both clocks)', code: 'sealed' };
  if (!(await acceptSeq(seq))) return { error: 'sealed: replayed request', code: 'sealed' };

  let reply;
  if (action === 'set_allowlist') {
    try { reply = { result: { allowlist: await setAllowlist(args.allowlist, { remote: true }) } }; } catch (e) { reply = { error: e.message, code: 'not_allowed' }; }
  } else if (action === 'get_allowlist') {
    reply = { result: { allowlist: currentAllowlist() } };
  } else if (typeof action !== 'string' || !action) {
    reply = { error: 'sealed: no action' };
  } else {
    const pre = await prepare(action, args, targetTabId);
    const off = pre.error ? undefined : pre.urls.find((u) => !urlAllowed(u, state.allowlist));
    if (pre.error) reply = { error: pre.error };
    else if (off !== undefined) reply = { error: `not on this browser's allowlist: ${hostOf(off)}`, code: 'not_allowed' };
    else {
      args = pre.args;
      reply = await run(action, args);
      // A redirect may have left the allowlist: never hand back what an off-list page showed.
      const tabId = typeof reply?.tabId === 'number' ? reply.tabId : (typeof args.tabId === 'number' ? args.tabId : null);
      if (tabId != null && !NO_PAGE.has(action)) {
        const now = await tabUrl(tabId);
        if (now && !urlAllowed(now, state.allowlist)) reply = { error: `left the allowlist: the tab is now on ${hostOf(now)}`, code: 'left_allowlist', tabId };
      }
    }
  }
  return { sealed: await seal(state.keys, 'res', reply, seq) };
}

function hostOf(url) {
  try { return new URL(url).hostname || String(url).slice(0, 60); } catch { return String(url || '(none)').slice(0, 60); }
}
