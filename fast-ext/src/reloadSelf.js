// The ONE chrome.runtime.reload() path in the service worker. Callers: the
// toolbar fallback and a relay reconnect.
export async function reloadSelf(reason) {
  chrome.runtime.reload();
}
