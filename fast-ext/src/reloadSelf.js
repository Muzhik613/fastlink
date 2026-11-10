// The ONE chrome.runtime.reload() path in the service worker. Callers: the
// toolbar fallback and a relay reconnect. A toolbar click first asks Chrome for a feed
// update, so "click the FastLink icon" also installs a waiting new version.
export async function reloadSelf(reason) {
  if (reason === 'toolbar-click') {
    try {
      const r = await chrome.runtime.requestUpdateCheck();
      if ((r?.status ?? r) === 'update_available') return;   // onUpdateAvailable below applies it once downloaded
    } catch { /* unpacked or throttled: plain reload */ }
  }
  chrome.runtime.reload();
}

// A downloaded update waits for the extension to go idle, which a connected relay socket may
// never do: apply it at once.
try { chrome.runtime.onUpdateAvailable.addListener(() => chrome.runtime.reload()); } catch {}
