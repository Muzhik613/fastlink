// lock.js — the secure build's lock (owner notes: ./README.md, format: ./sealed.js).
//
// Fixed behaviour in the secure build (SECURE_BUILD in ./build.js, checked by the callers):
// every call must be sealed with the lock key; unsealed calls, and all calls before a
// lock is set, are refused.
//
// SETTINGS (owner, options page; no new build):
//   lock code   — who may drive: the holder of the code.
//   allowlist   — the only https sites calls may read, act on or open.
//   remoteAdd   — may the driving machine ADD sites with a sealed set_allowlist?
//                 (it may always remove them)
//   allowEval   — may calls run page JavaScript (fast_evaluate)? Page JS can send data
//                 anywhere, so it is an explicit owner choice.
//
// Storage: the settings live under STORE_KEY and are written only by setLock /
// setAllowlist / clearLock (each re-reads right before writing). The replay window lives
// under SEEN_KEY, written only here, so a call in flight can never write back stale settings.
import { deriveKeys, seal, unseal } from './sealed.js';

export const STORE_KEY = 'fastlink.lock';      // { code, allowlist[], remoteAdd, allowEval }
const SEEN_KEY = 'fastlink.lockSeen';          // { keyId, seen[] }
export const MAX_SKEW_MS = 60_000;             // a request's ts must be within this of now
// Replay window: the last SEEN_MAX request numbers. A number already seen, or below a full
// window, is refused; numbers may arrive out of order (two scripts driving at once).
export const SEEN_MAX = 64;

// Tab actions: they must name an allowed tab by id (no `match`), or list tabs (filtered).
const TAB_BY_ID = new Set(['fast_switch', 'fast_close']);
// Actions that navigate to `url`.
const NAVIGATES = new Set(['fast_nav', 'fast_tab']);

let state = null;   // { keys, allowlist, remoteAdd, allowEval, seen } while locked, else null

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

// Is `url` an https page on the default port on the allowlist? "*.bank.com" matches
// bank.com and its subdomains.
export function urlAllowed(url, allowlist) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.port !== '') return false;
  const host = u.hostname.toLowerCase();
  return allowlist.some((e) => (e.startsWith('*.') ? host === e.slice(2) || host.endsWith(e.slice(1)) : host === e));
}

// --- state ---------------------------------------------------------------------

export function isLocked() { return !!state; }
export function lockKeyId() { return state ? state.keys.keyId : null; }
export function lockSettings() {
  return state ? { allowlist: [...state.allowlist], remoteAdd: state.remoteAdd, allowEval: state.allowEval } : { allowlist: [], remoteAdd: false, allowEval: false };
}

async function readStore(key) { return (await chrome.storage.local.get(key))[key]; }

export async function loadLock() {
  const saved = await readStore(STORE_KEY);
  if (!saved?.code) { state = null; return; }
  try {
    const keys = await deriveKeys(saved.code);
    const s = await readStore(SEEN_KEY);
    state = {
      keys,
      allowlist: normalizeAllowlist(saved.allowlist),
      remoteAdd: saved.remoteAdd === true,
      allowEval: saved.allowEval === true,
      seen: s?.keyId === keys.keyId && Array.isArray(s.seen) ? s.seen.filter(Number.isSafeInteger) : [],
    };
  } catch { state = null; }
}

// Options page: set (or replace) the lock and its settings. The replay window is kept
// when the code is the same one, and starts empty for a new code.
export async function setLock(code, allowlist, { remoteAdd = false, allowEval = false } = {}) {
  const keys = await deriveKeys(code);   // validates the code
  const list = normalizeAllowlist(allowlist);
  await chrome.storage.local.set({ [STORE_KEY]: { code: String(code).trim(), allowlist: list, remoteAdd: !!remoteAdd, allowEval: !!allowEval } });
  await loadLock();
  return { keyId: keys.keyId, allowlist: list };
}

// Owner (options page): any list and flags. Driving machine (sealed set_allowlist,
// `remote`): only removals, unless the owner set remoteAdd; it can't change the flags.
export async function setAllowlist(allowlist, { remote = false, remoteAdd, allowEval } = {}) {
  if (!state) throw new Error('not locked');
  const list = normalizeAllowlist(allowlist);
  const saved = await readStore(STORE_KEY);   // re-read: the owner may have changed it
  if (!saved?.code) throw new Error('not locked');
  const current = normalizeAllowlist(saved.allowlist);
  if (remote && saved.remoteAdd !== true) {
    const added = list.filter((e) => !current.includes(e));
    if (added.length) throw new Error(`adding sites (${added.join(', ')}) needs the owner: FastLink options, or allow it there`);
  }
  const next = { ...saved, allowlist: list };
  if (!remote && remoteAdd !== undefined) next.remoteAdd = !!remoteAdd;
  if (!remote && allowEval !== undefined) next.allowEval = !!allowEval;
  await chrome.storage.local.set({ [STORE_KEY]: next });
  await loadLock();
  return list;
}

export async function clearLock() {
  await chrome.storage.local.remove([STORE_KEY, SEEN_KEY]);
  state = null;
}

// Accept `seq` once: not seen before and not below a full window. The check-and-add is
// synchronous (no await before it), so two calls with the same seq can't both pass.
async function acceptSeq(seq) {
  const seen = state.seen;
  if (!Number.isSafeInteger(seq) || seq <= 0 || seen.includes(seq)) return false;
  if (seen.length >= SEEN_MAX && seq < seen[0]) return false;
  seen.push(seq);
  seen.sort((a, b) => a - b);
  if (seen.length > SEEN_MAX) seen.splice(0, seen.length - SEEN_MAX);
  await chrome.storage.local.set({ [SEEN_KEY]: { keyId: state.keys.keyId, seen: [...seen] } });
  return true;
}

// --- calls -------------------------------------------------------------------

// The secure build's answer to an UNSEALED call: always refused.
export function refuseUnsealed() {
  return { error: state
    ? 'This browser is locked: it accepts only sealed calls from its driving machine.'
    : 'This secure browser is not locked yet: set the lock code in FastLink options first.', code: 'locked' };
}

// A tab's current URL and, during a navigation, the URL it is going to.
async function tabUrls(tabId) {
  try { const t = await chrome.tabs.get(tabId); return [t.url || '', ...(t.pendingUrl ? [t.pendingUrl] : [])]; } catch { return ['']; }
}

const offList = (urls) => urls.find((u) => !urlAllowed(u, state.allowlist));
const refused = (url) => ({ error: `not on this browser's allowlist: ${hostOf(url)}`, code: 'not_allowed' });

// Check a call before it runs; returns { args } to run with, or { error }.
// A page action is pinned to the tab that was checked (tabId) and carries expectOrigin, so
// the extension re-checks that tab's site right before acting (siteGuard), after any wait
// in the tab queue.
async function prepare(action, args, targetTabId) {
  if (action === 'fast_batch') return { error: 'fast_batch is not available on a secure browser: send its steps as separate calls', code: 'not_allowed' };
  if (action === 'fast_evaluate' && !state.allowEval) return { error: 'page JavaScript (fast_evaluate) is off on this secure browser: the owner can allow it in FastLink options', code: 'not_allowed' };
  if (NAVIGATES.has(action)) {
    if (!urlAllowed(args.url, state.allowlist)) return refused(args.url);
    if (action === 'fast_tab') return { args };
  }
  if (action === 'fast_list') return { args };
  if (TAB_BY_ID.has(action) && typeof args.tabId !== 'number') return { error: `${action} needs a tabId on a secure browser`, code: 'not_allowed' };
  const id = typeof args.tabId === 'number' ? args.tabId : await targetTabId();
  if (typeof id !== 'number') return { error: 'no target tab' };
  const urls = await tabUrls(id);
  const off = offList(urls);
  if (off !== undefined) return refused(off);
  if (TAB_BY_ID.has(action) || action === 'fast_nav') return { args: { ...args, tabId: id } };
  return { args: { ...args, tabId: id, expectOrigin: new URL(urls[0]).origin } };
}

// After a call: drop anything about off-list pages from the reply.
async function afterRun(action, args, reply) {
  if (action === 'fast_list' && Array.isArray(reply?.result)) {
    return { ...reply, result: reply.result.filter((t) => urlAllowed(t?.url, state.allowlist)).map(({ trail, ...t }) => t) };
  }
  if (action === 'fast_close' || action === 'fast_list') return reply;
  const tabId = typeof reply?.tabId === 'number' ? reply.tabId : (typeof args.tabId === 'number' ? args.tabId : null);
  if (tabId == null) return reply;
  const off = offList(await tabUrls(tabId));
  return off === undefined ? reply : { error: `left the allowlist: the tab is now on ${hostOf(off)}`, code: 'left_allowlist', tabId };
}

// Handle one sealed call. `frame` = the relay call's args ({v, keyId, nonce, ct});
// `run(action, args)` executes a tool exactly like an unsealed call; `targetTabId()`
// resolves the browser's target tab like an unsealed call does. Returns the reply to send
// back: a sealed frame, or a plain {error} that carries no content (wrong key, replay,
// expired, not locked).
export async function handleSealed(frame, run, targetTabId) {
  if (!state) return refuseUnsealed();
  let req;
  try { req = await unseal(state.keys, 'req', frame); } catch (e) { return { error: e.message, code: 'sealed' }; }
  const { seq, ts, deadline, action } = req || {};
  const args = req?.args && typeof req.args === 'object' ? req.args : {};
  const now = Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return { error: 'sealed: request too old (check both clocks)', code: 'sealed' };
  // The caller gave up at its deadline: running later could repeat an action it retried.
  if (Number.isFinite(deadline) && now > deadline) return { error: 'sealed: request arrived after its deadline; not run', code: 'sealed' };
  if (!(await acceptSeq(seq))) return { error: 'sealed: replayed request', code: 'sealed' };

  let reply;
  if (action === 'set_allowlist') {
    try { reply = { result: { allowlist: await setAllowlist(args.allowlist, { remote: true }) } }; } catch (e) { reply = { error: e.message, code: 'not_allowed' }; }
  } else if (action === 'get_allowlist') {
    reply = { result: lockSettings() };
  } else if (typeof action !== 'string' || !action) {
    reply = { error: 'sealed: no action' };
  } else {
    const pre = await prepare(action, args, targetTabId);
    reply = pre.error ? pre : await afterRun(action, pre.args, await run(action, pre.args));
  }
  return { sealed: await seal(state.keys, 'res', reply, seq) };
}

function hostOf(url) {
  try { return new URL(url).host || String(url).slice(0, 60); } catch { return String(url || '(none)').slice(0, 60); }
}
