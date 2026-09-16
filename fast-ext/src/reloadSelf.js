// The ONE chrome.runtime.reload() path in the service worker. Callers:
// connection.js (the broker's 'reload' message — this is what fast_ext_reload and
// scripts/ship-ext.sh drive), the toolbar fallback, and a relay reconnect.
export async function reloadSelf(reason) {
  chrome.runtime.reload();
}
