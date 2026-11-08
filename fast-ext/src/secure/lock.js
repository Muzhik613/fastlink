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

// Unlocking also unpairs: a secure browser is never left paired AND unlocked. (The relay
// keeps its own record of the lock anyway and refuses this pairing from then on; reset =
// revoke the browser and pair it again.)
export async function clearLock() {
  await chrome.storage.local.remove([STORE_KEY, SEEN_KEY, 'deviceToken']);
  state = null;
}

// Accept `seq` once: not seen before and not below a full window. The check-and-add is
// synchronous (no await before it), so two calls with the same seq can't both pass.
async function acceptSeq(st, seq) {
  const seen = st.seen;
  if (!Number.isSafeInteger(seq) || seq <= 0 || seen.includes(seq)) return false;
  if (seen.length >= SEEN_MAX && seq < seen[0]) return false;
  seen.push(seq);
  seen.sort((a, b) => a - b);
  if (seen.length > SEEN_MAX) seen.splice(0, seen.length - SEEN_MAX);
  await chrome.storage.local.set({ [SEEN_KEY]: { keyId: st.keys.keyId, seen: [...seen] } });
  return true;
}

// --- calls -------------------------------------------------------------------

// The secure build's answer to an UNSEALED call: always refused.
export function refuseUnsealed() {
  return { error: state
    ? 'This browser is locked: it accepts only sealed calls from its driving machine.'
    : 'This secure browser is not locked yet: set the lock code in FastLink options first.', code: 'locked' };
}

// A tab's committed URL and, during a navigation, the URL it is going to. A just-created
// tab has url '' (or about:blank) until its first navigation commits.
const isBlank = (u) => !u || u === 'about:blank';
async function tabState(tabId) {
  try { const t = await chrome.tabs.get(tabId); return { url: t.url || '', pendingUrl: t.pendingUrl || '' }; } catch { return { gone: true, url: '', pendingUrl: '' }; }
}

const offList = (st, urls) => urls.find((u) => !urlAllowed(u, st.allowlist));
const refused = (url) => ({ error: `not on this browser's allowlist: ${hostOf(url)}`, code: 'not_allowed' });

// Check a call before it runs; returns { args } to run with, or { error }.
// A page action is pinned to the tab that was checked (tabId) and carries expectOrigin, so
// the extension re-checks that tab's site right before acting (siteGuard), after any wait
// in the tab queue.
async function prepare(st, action, args, targetTabId, deadline) {
  if (action === 'fast_batch') return { error: 'fast_batch is not available on a secure browser: send its steps as separate calls', code: 'not_allowed' };
  if (action === 'fast_evaluate' && !st.allowEval) return { error: 'page JavaScript (fast_evaluate) is off on this secure browser: the owner can allow it in FastLink options', code: 'not_allowed' };
  if (NAVIGATES.has(action)) {
    if (!urlAllowed(args.url, st.allowlist)) return refused(args.url);
  }
  // notAfter: the extension refuses the call if it only gets to run after the caller's
  // deadline (it may have waited in the tab queue); dispatchAction checks and strips it.
  const late = Number.isFinite(deadline) ? { notAfter: deadline } : {};
  if (action === 'fast_tab' || action === 'fast_list') return { args: { ...args, ...late } };
  if (TAB_BY_ID.has(action)) {
    // By id only: `match` (and the pin options) would let these pick another tab.
    const { match, clear, release, unpin, ...rest } = args;
    if (typeof rest.tabId !== 'number' || match !== undefined) return { error: `${action} needs a tabId (no match) on a secure browser`, code: 'not_allowed' };
    args = rest;
  }
  const id = typeof args.tabId === 'number' ? args.tabId : await targetTabId();
  if (typeof id !== 'number') return { error: 'no target tab' };
  // Acting on a page needs a committed page on the allowlist (and, mid-navigation, an
  // allowed destination). A tab with no page yet is "not ready", not an allowlist matter.
  const { url, pendingUrl } = await tabState(id);
  if (isBlank(url)) return { error: 'the tab has no page yet (still loading); retry in a moment', code: 'not_ready' };
  const off = offList(st, [url, ...(isBlank(pendingUrl) ? [] : [pendingUrl])]);
  if (off !== undefined) return refused(off);
  if (TAB_BY_ID.has(action) || action === 'fast_nav') return { args: { ...args, tabId: id, ...late } };
  return { args: { ...args, tabId: id, expectOrigin: new URL(url).origin, ...late } };
}

// After a call: drop anything about off-list pages from the reply.
async function afterRun(st, action, args, reply) {
  if (action === 'fast_list' && Array.isArray(reply?.result)) {
    return { ...reply, result: reply.result.filter((t) => urlAllowed(t?.url, st.allowlist)).map(({ trail, ...t }) => t) };
  }
  if (action === 'fast_close' || action === 'fast_list') return reply;
  const tabId = typeof reply?.tabId === 'number' ? reply.tabId : (typeof args.tabId === 'number' ? args.tabId : null);
  if (tabId == null) return reply;
  // Fail closed: a tab that can't be read, or (except below) a blank one, can't be shown
  // to be on the allowlist. The one exemption: fast_tab right after creating its tab,
  // whose first navigation hasn't committed (url ''/about:blank): it has shown nothing, so
  // only its pending destination is judged (fb#20).
  const { gone, url, pendingUrl } = await tabState(tabId);
  if (gone) return { error: 'could not verify the tab after the call (it is gone)', code: 'left_allowlist', tabId };
  const urls = action === 'fast_tab' && isBlank(url) ? [pendingUrl].filter((u) => !isBlank(u)) : [url, ...(isBlank(pendingUrl) ? [] : [pendingUrl])];
  const off = offList(st, urls);
  return off === undefined ? reply : { error: `left the allowlist: the tab is now on ${hostOf(off)}`, code: 'left_allowlist', tabId };
}

// Handle one sealed call. `frame` = the relay call's args ({v, keyId, nonce, ct});
// `run(action, args)` executes a tool exactly like an unsealed call; `targetTabId()`
// resolves the browser's target tab like an unsealed call does. Returns the reply to send
// back: a sealed frame, or a plain {error} that carries no content (wrong key, replay,
// expired, not locked).
export async function handleSealed(frame, run, targetTabId) {
  // One snapshot of the lock for the whole call: the owner may clear or change it meanwhile.
  const st = state;
  if (!st) return refuseUnsealed();
  try {
    return await sealedCall(st, frame, run, targetTabId);
  } catch {
    return { error: 'sealed: the call failed inside the extension', code: 'sealed' };   // no content in clear
  }
}

async function sealedCall(st, frame, run, targetTabId) {
  let req;
  try { req = await unseal(st.keys, 'req', frame); } catch (e) { return { error: e.message, code: 'sealed' }; }
  const { seq, ts, deadline, action } = req || {};
  const args = req?.args && typeof req.args === 'object' ? req.args : {};
  const now = Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return { error: 'sealed: request too old (check both clocks)', code: 'sealed' };
  // The caller gave up at its deadline: running later could repeat an action it retried.
  if (Number.isFinite(deadline) && now > deadline) return { error: 'sealed: request arrived after its deadline; not run', code: 'sealed' };
  if (!(await acceptSeq(st, seq))) return { error: 'sealed: replayed request', code: 'sealed' };

  let reply;
  if (action === 'set_allowlist') {
    try { reply = { result: { allowlist: await setAllowlist(args.allowlist, { remote: true }) } }; } catch (e) { reply = { error: e.message, code: 'not_allowed' }; }
  } else if (action === 'get_allowlist') {
    reply = { result: lockSettings() };
  } else if (typeof action !== 'string' || !action) {
    reply = { error: 'sealed: no action' };
  } else {
    const pre = await prepare(st, action, args, targetTabId, deadline);
    reply = pre.error ? pre : await afterRun(st, action, pre.args, await run(action, pre.args));
  }
  return { sealed: await seal(st.keys, 'res', reply, seq) };
}

function hostOf(url) {
  try { return new URL(url).host || String(url).slice(0, 60); } catch { return String(url || '(none)').slice(0, 60); }
}
