// The ONE chrome.runtime.reload() path in the service worker. Every reason
// (update / broker / toolbar-click / relay-reconnect) is appended to the
// fastlinkSelfReloadLog ring as {at, reason} BEFORE reloading, so the next
// startup and updateCheck's loop breaker (it counts only reason:'update') can
// read who reloaded and why. Never throws into the worker.
export const SELF_RELOAD_LOG_KEY = 'fastlinkSelfReloadLog';   // chrome.storage.local — [{at, reason}]
const LOG_MAX = 20;

export async function reloadSelf(reason) {
  try {
    const o = await chrome.storage.local.get(SELF_RELOAD_LOG_KEY);
    const log = (Array.isArray(o?.[SELF_RELOAD_LOG_KEY]) ? o[SELF_RELOAD_LOG_KEY] : [])
      .filter((e) => e && typeof e.at === 'number');
    log.push({ at: Date.now(), reason: String(reason || 'unknown') });
    await chrome.storage.local.set({ [SELF_RELOAD_LOG_KEY]: log.slice(-LOG_MAX) });
  } catch {}
  chrome.runtime.reload();
}
