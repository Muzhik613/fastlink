// The ONE chrome.runtime.reload() path in the service worker. Callers: the
// toolbar fallback and a relay reconnect. A toolbar click first asks Chrome for a feed
// update, so "click the FastLink icon" also installs a waiting new version.
// fast_update (relay tool): answer first, then load the new version. A feed install asks
// Chrome for the update (applied by onUpdateAvailable below); an unpacked copy, or a feed
// with nothing new, reloads from disk. Storage (pairing, name, settings) survives a reload.
export async function updateSelf() {
  let installType = 'unknown';
  try { installType = (await chrome.management.getSelf()).installType; } catch {}
  let check = 'not checked';
  if (installType !== 'development') {
    try { const r = await chrome.runtime.requestUpdateCheck(); check = r?.status ?? r; } catch (e) { check = 'check failed: ' + (e?.message || e); }
  }
  const version = chrome.runtime.getManifest().version;
  if (check !== 'update_available') setTimeout(() => chrome.runtime.reload(), 500);
  return { version, installType, updateCheck: check, reloading: true,
    hint: 'FastLink restarts in a few seconds and reconnects by itself; fast_status shows the version it comes back with.' };
}

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
