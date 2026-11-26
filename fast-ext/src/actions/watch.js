// watch.js — live watches on a tab, pushed to the relay as they happen (fast_watch_read there).
//
// Two kinds share one registry and one delivery path (watchOutbox.js):
//   dom      fast_watch: a MutationObserver in the page (isolated world) re-reads the items
//            matching `selector` whenever the DOM changes; the service worker diffs them
//            against the last list it saw and pushes add / change / remove events.
//   request  fast_capture (capture.js): matching network requests with headers and body.
// The relay assigns every watchId. The registry (chrome.storage.session) survives a
// service-worker restart; a page load re-installs that tab's DOM watches and diffs against
// the stored list, so a reload reports only what really changed. A closed tab ends its
// watches ({kind:'ended'}). The hello names the live watch ids, so the relay ends the ones
// a restarted Chrome or a reloaded FastLink no longer runs.

import { injectInTab } from '../util.js';
import { maskCardNumbers } from './frames.js';
import { createWatchOutbox } from '../watchOutbox.js';
import { setRelayHooks, sendRelayFrame, resendHello } from '../relayClient.js';

const REG_KEY = 'fastlink.watches';
const STATE_PREFIX = 'fastlink.watchState.';
export const WATCH_LIMIT_DEFAULT = 50;
export const WATCH_LIMIT_MAX = 200;
const MAX_FIELDS = 20;
const WATCH_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

const session = {
  get: async (k) => (await chrome.storage.session.get(k))[k],
  set: (k, v) => chrome.storage.session.set({ [k]: v }),
  del: (k) => chrome.storage.session.remove(k),
};

let registry = null;   // { [watchId]: { kind, tabId, spec, createdAt } }
export const ready = (async () => {
  try { registry = (await session.get(REG_KEY)) || {}; } catch { registry = {}; }
})().then(() => resendHello());
const saveRegistry = () => session.set(REG_KEY, registry).catch(() => {});

// Kind-specific teardown (capture.js registers 'request').
const kinds = { dom: { stop: stopDomInPage } };
export function registerKind(kind, handlers) { kinds[kind] = handlers; }

export const outbox = createWatchOutbox({
  storage: { get: session.get, set: session.set },
  send: sendRelayFrame,
  onGone: (id) => { endWatch(id).catch(() => {}); },
});
setRelayHooks({
  onOpen: () => { outbox.flush(); },
  onFrame: (m) => { if (m.type === 'watch_ack') outbox.ack(m.watchId, m.n); else outbox.gone(m.watchId); },
  watchIds: () => (registry ? Object.keys(registry) : undefined),
});

// One chain per watch: its start, every page report and its stop run in order.
const chains = new Map();
function serial(id, fn) {
  const p = (chains.get(id) || Promise.resolve()).then(fn);
  const tail = p.catch(() => {});
  chains.set(id, tail);
  tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
  return p;
}

export function registrySync() { return registry; }
export function watchesOnTab(tabId, kind) {
  return Object.entries(registry || {}).filter(([, w]) => w.tabId === tabId && (!kind || w.kind === kind));
}
export async function addWatch(id, w) {
  await ready;
  registry[id] = { ...w, createdAt: Date.now() };
  await saveRegistry();
}
export function pushEvents(id, events) {
  const at = Date.now();
  return outbox.push(id, events.map((e) => ({ at, ...e })));
}

// Remove a watch here (its kind's teardown runs). `reason` set → an `ended` event tells the relay.
async function endLocal(id, reason = null) {
  await ready;
  const w = registry[id];
  if (!w) return false;
  delete registry[id];
  await saveRegistry();
  try { await session.del(STATE_PREFIX + id); } catch {}
  try { await kinds[w.kind]?.stop?.(id, w); } catch {}
  if (reason) await pushEvents(id, [{ kind: 'ended', reason }]);
  return true;
}
export function endWatch(id, reason) { return serial(id, () => endLocal(id, reason)); }

// fast_watch_stop {watchId}: the relay already forgot it, so nothing more is sent.
export async function watchStop(args = {}) {
  const id = args.watchId;
  if (typeof id !== 'string' || !WATCH_ID_RE.test(id)) return { error: 'fast_watch_stop needs the watchId fast_watch or fast_capture returned' };
  const had = await serial(id, () => endLocal(id));
  await outbox.drop(id);
  return { watchId: id, stopped: had };
}

// ---- dom watch ------------------------------------------------------------

// fast_watch args → {spec} or {error}. fields: {name: "css" | "css@attr" | "@attr" | ""}.
export function checkDomSpec(args = {}) {
  const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
  if (!selector) return { error: 'fast_watch needs `selector`: a CSS selector matching each item to watch (e.g. one list row)' };
  let fields = null;
  if (args.fields != null) {
    if (typeof args.fields !== 'object' || Array.isArray(args.fields)) return { error: 'fast_watch `fields` must be an object {name: "css" | "css@attr" | "@attr" | ""}' };
    const ent = Object.entries(args.fields);
    if (!ent.length || ent.length > MAX_FIELDS) return { error: `fast_watch \`fields\` takes 1-${MAX_FIELDS} entries` };
    if (ent.some(([, v]) => typeof v !== 'string')) return { error: 'fast_watch `fields` values must be strings ("" = the item\'s own text)' };
    fields = Object.fromEntries(ent);
  }
  const key = args.key == null ? null : String(args.key);
  if (key && !(fields ? key in fields : key === 'text')) return { error: `fast_watch \`key\` "${key}" is not one of the fields (${fields ? Object.keys(fields).join(', ') : 'text'})` };
  const limit = args.limit == null ? WATCH_LIMIT_DEFAULT : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > WATCH_LIMIT_MAX) return { error: `fast_watch \`limit\` must be 1-${WATCH_LIMIT_MAX}` };
  return { spec: { selector, fields, key, limit } };
}

// Item list → state [[key, json]]. Without a key field an item is its own key (so a
// changed item reads as remove + add); repeated keys get "#2", "#3".
export function stateOf(items, keyField) {
  const seen = new Map();
  return items.map((it) => {
    const json = JSON.stringify(it);
    let k = keyField ? String(it[keyField] ?? '') : json;
    const c = (seen.get(k) || 0) + 1;
    seen.set(k, c);
    if (c > 1) k = `${k}#${c}`;
    return [k, json];
  });
}

// What changed between two states: add / change (with prev) / remove, in list order.
export function diffItems(prev, next) {
  const before = new Map(prev);
  const after = new Set(next.map(([k]) => k));
  const events = [];
  next.forEach(([k, json], index) => {
    if (!before.has(k)) events.push({ kind: 'add', key: k, index, item: JSON.parse(json) });
    else if (before.get(k) !== json) events.push({ kind: 'change', key: k, index, item: JSON.parse(json), prev: JSON.parse(before.get(k)) });
  });
  for (const [k, json] of prev) if (!after.has(k)) events.push({ kind: 'remove', key: k, item: JSON.parse(json) });
  return events;
}

async function installIn(tabId, id, spec) {
  const r = await injectInTab({ world: 'ISOLATED', tabId, func: installWatch, args: [id, spec] });
  if (r.error) return r;
  const out = JSON.parse(r.result);
  return out.error ? out : { ...out, tabId: r.tab.id };
}

// fast_watch {watchId, tabId, selector, fields?, key?, limit?} → the items now.
export async function watchStart(args = {}) {
  const id = args.watchId;
  if (typeof id !== 'string' || !WATCH_ID_RE.test(id)) return { error: 'fast_watch: no watchId (the relay assigns it; update the relay)' };
  const chk = checkDomSpec(args);
  if (chk.error) return chk;
  await ready;
  return serial(id, async () => {
    const r = await installIn(args.tabId, id, chk.spec);
    if (r.error) return r;
    const items = maskCardNumbers(r.items);
    await addWatch(id, { kind: 'dom', tabId: r.tabId, spec: chk.spec });
    await session.set(STATE_PREFIX + id, stateOf(items, chk.spec.key));
    return { watchId: id, tabId: r.tabId, matches: r.matches, items };
  });
}

// A page reported its list (or a reload re-read it): push what changed.
// An empty list right after a load is a page still rendering, never "everything removed".
function onItems(id, tabId, items) {
  return serial(id, async () => {
    await ready;
    const w = registry[id];
    if (!w || w.kind !== 'dom' || w.tabId !== tabId) return false;
    const prev = (await session.get(STATE_PREFIX + id)) || [];
    if (!items.length && prev.length) return true;
    const next = stateOf(maskCardNumbers(items), w.spec.key);
    const events = diffItems(prev, next);
    if (!events.length) return true;
    await session.set(STATE_PREFIX + id, next);
    await pushEvents(id, events);
    return true;
  });
}

async function stopDomInPage(id, w) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: w.tabId }, world: 'ISOLATED', func: (wid) => { globalThis.__fastlinkWatches?.get(wid)?.stop(); }, args: [id] });
  } catch { /* tab gone or navigated: nothing runs there */ }
}

// Listeners at module load (background.js imports this synchronously, so they wake the worker).
try {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== 'fastlink:watch-items' || typeof msg.watchId !== 'string' || !Array.isArray(msg.items)) return false;
    const tabId = sender?.tab?.id;
    if (typeof tabId !== 'number' || sender.id !== chrome.runtime.id) return false;
    onItems(msg.watchId, tabId, msg.items).then((known) => {
      // a page still running a watch this browser has stopped: stop it there
      if (known === false) stopDomInPage(msg.watchId, { tabId });
    }).catch(() => {});
    return false;
  });
  chrome.webNavigation.onCompleted.addListener(async (d) => {
    if (d.frameId !== 0) return;
    await ready;
    for (const [id, w] of watchesOnTab(d.tabId, 'dom')) {
      serial(id, async () => {
        const r = await installIn(d.tabId, id, w.spec);
        return r.error ? null : r.items;
      }).then((items) => items && onItems(id, d.tabId, items)).catch(() => {});
    }
  });
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    await ready;
    for (const [id] of watchesOnTab(tabId)) endWatch(id, 'tab closed').catch(() => {});
  });
  chrome.tabs.onReplaced.addListener(async (added, removed) => {
    await ready;
    for (const [, w] of watchesOnTab(removed)) w.tabId = added;
    await saveRegistry();
  });
} catch { /* node tests: no chrome */ }

// Runs in the page's isolated world (self-contained: executeScript serializes it).
// Installs (or replaces) watch `watchId`; returns JSON {items, matches} of the list now.
export function installWatch(watchId, spec) {
  const W = (globalThis.__fastlinkWatches ||= new Map());
  W.get(watchId)?.stop();
  const FIELD_MAX = 2000;
  const clip = (s) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > FIELD_MAX ? t.slice(0, FIELD_MAX) : t; };
  const textOf = (el) => clip(el.innerText ?? el.textContent);
  const pick = (el, f) => {
    const at = f.lastIndexOf('@');
    const sel = (at >= 0 ? f.slice(0, at) : f).trim();
    const attr = at >= 0 ? f.slice(at + 1).trim() : null;
    let n = el;
    if (sel) { try { n = el.querySelector(sel); } catch { n = null; } }
    if (!n) return null;
    return attr ? (n.hasAttribute(attr) ? clip(n.getAttribute(attr)) : null) : textOf(n);
  };
  const read = () => {
    let els;
    try { els = document.querySelectorAll(spec.selector); } catch (e) { return { error: `fast_watch: bad selector "${spec.selector}" (${e.message})` }; }
    const items = [];
    for (const el of els) {
      if (items.length >= spec.limit) break;
      if (!spec.fields) { items.push({ text: textOf(el) }); continue; }
      const o = {};
      for (const [k, f] of Object.entries(spec.fields)) o[k] = pick(el, f);
      items.push(o);
    }
    return { items, matches: els.length };
  };
  const first = read();
  if (first.error) return JSON.stringify(first);
  let last = JSON.stringify(first.items);
  let queued = false;
  let mo = null;
  const stop = () => { mo?.disconnect(); W.delete(watchId); };
  // One re-read per burst of mutations (a microtask after the observer's batch: not
  // throttled in a background tab, unlike timers); sent only when the list changed.
  const emit = () => {
    queued = false;
    const r = read();
    if (r.error) return;
    const s = JSON.stringify(r.items);
    if (s === last) return;
    last = s;
    try {
      chrome.runtime.sendMessage({ type: 'fastlink:watch-items', watchId, items: r.items }).catch(() => {});
    } catch { stop(); }   // FastLink was reloaded: this copy can no longer report
  };
  mo = new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(emit); } });
  mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  W.set(watchId, { stop });
  return JSON.stringify(first);
}
