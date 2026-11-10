import { resolveTargetTab } from './actions/targetTab.js';
// Static import of cdp (was `await import('./actions/input.js')` at call time):
// dynamic import() is disallowed in the MV3 service-worker global scope and threw
// "import() is disallowed on ServiceWorkerGlobalScope", which broke the CDP
// screenshot fallback (e.g. capturing a backgrounded pinned tab). The
// input.js ↔ util.js cycle is safe: cdp is only referenced inside
// captureViaDebugger (call time), after both modules finish initializing.
import { cdp } from './actions/input.js';

// The tab a call acts on. A call that names its own `tabId` (PIN-REDESIGN §3)
// gets exactly that tab — undefined if it was closed, never another tab.
export const getActiveTab = async (tabId) => {
  if (typeof tabId === 'number') {
    try { return await chrome.tabs.get(tabId); } catch { return undefined; }
  }
  // Without a tabId: honor the designated target pin first, so every chokepoint that resolves a
  // tab through getActiveTab (screenshot, CDP capture, network, waitIdle,
  // buffers, marks, vision) drives the tab the assistant pinned — not whatever tab the
  // user's focus has snapped back to. resolveTargetTab returns null (and
  // self-clears a stale pin) when nothing live is pinned, so we fall through to
  // the normal active-tab logic. targetTab.js imports nothing from util.js → no
  // import cycle.
  const pinned = await resolveTargetTab();
  if (pinned) return pinned;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) return tab;
  // MV3 cold-start: a freshly-woken service worker has no "last focused
  // window" until a focus/activate event fires in its lifetime. Fall back to
  // the active tab of the first normal window.
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true });
  for (const w of wins) {
    const t = w.tabs?.find(t => t.active);
    if (t) return t;
  }
  return undefined;
};

export const isInjectableUrl = (url) => /^https?:|^file:/.test(url || '');

export const missingTabError = (tabId) =>
  `No tab with id ${tabId} in this browser (it was closed, or it belongs to another browser/Chrome profile). fast_list shows this browser's tabs.`;

export async function getInjectableTab(tabId) {
  const tab = await getActiveTab(tabId);
  if (!tab) return { error: typeof tabId === 'number' ? missingTabError(tabId) : 'No active tab' };
  if (!isInjectableUrl(tab.url)) return { error: `Restricted URL: ${tab.url}` };
  return { tab };
}

export async function injectInTab({ world = 'MAIN', func, args = [], tabId }) {
  const got = await getInjectableTab(tabId);
  if (got.error) return got;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: got.tab.id }, world, func, args,
  });
  return { tab: got.tab, result };
}

// Capture via CDP Page.captureScreenshot — NOT subject to the captureVisibleTab
// per-second quota, and able to read from the window surface (fromSurface:false)
// rather than the GPU compositor. CRITICAL: it reuses the SHARED persistent
// debugger session from input.js (via cdp()), instead of its own attach/detach.
// The old version attached/detached itself, which (a) collided with input.js's
// always-on session → "already attached" throw (this is why the fallback was
// "also failing"), and (b) toggled the "FastLink is debugging this browser"
// banner, shifting the viewport and breaking coordinate clicks. The shared
// session is already attached during any automation session, so this adds no
// new banner and no quota cost.
export async function captureViaDebugger(capOpts = { format: 'png' }, tabId) {
  const tab = await getActiveTab(tabId);
  if (!tab?.id) throw new Error(typeof tabId === 'number' ? missingTabError(tabId) : 'no active tab for debugger capture');
  const format = capOpts.format === 'jpeg' ? 'jpeg' : 'png';
  const base = { format, captureBeyondViewport: false };
  if (format === 'jpeg' && typeof capOpts.quality === 'number') base.quality = capOpts.quality;
  // Try the window/screen path first (most likely to survive a wedged GPU
  // compositor), then the surface path.
  let lastErr;
  for (const fromSurface of [false, true]) {
    try {
      const res = await cdp(tab.id, 'Page.captureScreenshot', { ...base, fromSurface });
      if (res?.data) return `data:image/${format};base64,${res.data}`;
      lastErr = new Error('Page.captureScreenshot returned no data');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Page.captureScreenshot failed');
}

// The tab to capture, and whether it is OFF-SCREEN. chrome.tabs.captureVisibleTab only
// ever grabs the active tab of a window — so when the assistant drives a tab in the
// background (the call's own tabId, or the pinned target) it returns the WRONG tab's
// pixels. CDP Page.captureScreenshot targets a concrete tabId and reads a non-focused tab,
// so capture must route through it whenever that tab isn't the on-screen one.
// Returns { tab, background } (tab null: no tabId and no pin). A call's own tabId that no
// longer exists throws.
export async function captureTarget(tabId) {
  let tab;
  if (typeof tabId === 'number') {
    tab = await getActiveTab(tabId);
    if (!tab) throw new Error(missingTabError(tabId));
  } else {
    try { tab = await resolveTargetTab(); } catch { tab = null; }
  }
  if (!tab) return { tab: null, background: false };
  // On screen = the active tab of the last-focused window. Compare by id so a tab that
  // is "active" in its own non-focused window still counts as backgrounded.
  let visibleId;
  try {
    const [vis] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    visibleId = vis?.id;
  } catch {}
  return { tab, background: tab.id !== visibleId };
}

// Chrome lets no extension capture its own internal pages, by any path (captureVisibleTab
// and CDP both refuse). Pure.
export const isUncapturableUrl = (url) => /^(chrome|chrome-untrusted|devtools|edge|brave|view-source):/i.test(url || '');

// Robust viewport capture (DEVICE pixels; takeScreenshot resizes every capture to
// CSS pixels). Order matters because the GPU
// wedge is INTERMITTENT and captureVisibleTab is quota-limited:
//   1. one captureVisibleTab — fast, no banner, works when the GPU is healthy
//   2. CDP Page.captureScreenshot — dodges the quota and the wedged compositor
//   3. one more captureVisibleTab, quota-safely spaced, to catch a transient
//      wedge that just cleared
// On total failure, throws an error carrying an actionable .hint.
export async function captureViewport(opts = {}) {
  const format = (opts.format || 'png').toLowerCase();
  const capOpts = { format };
  if (format === 'jpeg' && typeof opts.quality === 'number') capOpts.quality = opts.quality;

  // 0. Backgrounded-tab path. captureVisibleTab would grab the wrong (on-screen)
  //    tab, so go straight to CDP — which targets the tab by id and can read a
  //    non-focused tab — and do NOT fall back to a visible-tab capture that
  //    would return the WRONG page's pixels.
  const { tab: target, background } = await captureTarget(opts.tabId);
  // feedback #25: a chrome:// tab failed every path and was reported as a GPU wedge.
  if (target && isUncapturableUrl(target.url || target.pendingUrl)) {
    const err = new Error(`tab ${target.id} is ${target.url || target.pendingUrl}: Chrome does not let extensions capture its internal pages; nothing was captured`);
    err.hint = 'read a chrome:// page with the user (they can look at it), or screenshot an ordinary web page.';
    throw err;
  }
  const bg = background ? target : null;
  if (bg) {
    try {
      return { dataUrl: await captureViaDebugger(capOpts, bg.id), format };
    } catch (e) {
      const err = new Error(
        `capture of the background tab ${bg.id} via CDP failed (${e?.message || e}). ` +
        `That tab isn't the on-screen tab, so a visible-tab capture would grab the ` +
        `wrong page — retry in a moment, or fast_switch focus onto the tab.`
      );
      err.hint = 'the driven tab is backgrounded and CDP capture failed; retry or bring the tab to the foreground.';
      throw err;
    }
  }

  // A visible-tab capture reads the TARGET's window (captureVisibleTab(undefined) is the
  // "current" window, which can be another window: feedback #25, a screenshot right after
  // fast_tab showed a different window's tab), and counts only while the target is still
  // that window's active tab.
  const visibleCapture = async () => {
    const dataUrl = await chrome.tabs.captureVisibleTab(target ? target.windowId : undefined, capOpts);
    if (!dataUrl) return null;
    if (target) { try { if (!(await chrome.tabs.get(target.id)).active) return null; } catch { return null; } }
    return dataUrl;
  };

  // 1. Fast path (no pin, or the pinned tab is the visible one).
  try {
    const dataUrl = await visibleCapture();
    if (dataUrl) return { dataUrl, format };
  } catch (_) { /* GPU wedge or quota — fall through */ }

  // 2. CDP path (quota-free, shared debugger session).
  let cdpErr;
  try {
    return { dataUrl: await captureViaDebugger(capOpts, opts.tabId), format };
  } catch (e) {
    cdpErr = e;
  }

  // 3. One more captureVisibleTab, spaced to respect the quota.
  try {
    await new Promise((r) => setTimeout(r, 750));
    const dataUrl = await visibleCapture();
    if (dataUrl) return { dataUrl, format };
  } catch (_) { /* fall through to the hint */ }

  const err = new Error(
    `image readback failed — the GPU compositor is wedged and the CDP fallback also failed` +
    (cdpErr?.message ? ` (${cdpErr.message})` : '') +
    `. The wedge is intermittent: a retry in a few seconds may succeed. To fix it for good, ` +
    `fully quit + reopen Chrome, or relaunch Chrome with --disable-gpu.`
  );
  err.hint = 'GPU readback wedged (intermittent — retrying in a few seconds may work); quit+reopen Chrome or relaunch with --disable-gpu for a permanent fix.';
  throw err;
}

