// Passive per-tab URL trail: every chrome.tabs.onUpdated URL change is stamped
// and kept in a ring of TRAIL_MAX per tab (chrome.storage.session so a service-
// worker restart mid-run keeps it). fast_list returns it per tab, so a watcher
// reconstructs every stop from timestamps instead of polling the tab list every
// 500ms through the same service worker the page is storming.
const TRAIL_MAX = 50;
const KEY = 'fastlink.trail';
const trails = new Map();   // tabId → [{ t, url }] oldest first
let loaded = null;
let saveTimer = null;

const load = () => loaded ||= (async () => {
  try {
    const stored = (await chrome.storage.session.get(KEY))[KEY] || {};
    for (const [id, arr] of Object.entries(stored)) {
      const live = trails.get(+id) || [];
      trails.set(+id, [...arr, ...live.filter(e => !arr.some(s => s.t === e.t && s.url === e.url))].slice(-TRAIL_MAX));
    }
  } catch {}
})();

const save = () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { chrome.storage.session.set({ [KEY]: Object.fromEntries(trails) }).catch(() => {}); } catch {}
  }, 250);
};

export const recordUrl = (tabId, url, t = Date.now()) => {
  if (!url) return;
  const arr = trails.get(tabId) || [];
  if (arr.length && arr[arr.length - 1].url === url) return;
  arr.push({ t, url });
  if (arr.length > TRAIL_MAX) arr.splice(0, arr.length - TRAIL_MAX);
  trails.set(tabId, arr);
  save();
};

export const forgetTab = (tabId) => { if (trails.delete(tabId)) save(); };

// Register at service-worker top level (MV3 listeners must be synchronous).
export function installTrail() {
  load();
  chrome.tabs.onUpdated.addListener((tabId, info) => { if (info && info.url) recordUrl(tabId, info.url); });
  chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));
}

export async function trailOf(tabId) {
  await load();
  return (trails.get(tabId) || []).slice();
}
