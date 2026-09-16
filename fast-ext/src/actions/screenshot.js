import { captureViewport, captureViaDebugger, getActiveTab } from '../util.js';

// fast_screenshot answers "what is on the user's screen RIGHT NOW", so by DEFAULT
// it captures the user's ACTUAL foreground tab — the active tab of the last-focused
// window — NOT the pinned automation target.
//
// LIVE BUG (the reason this changed): capture used to route through
// captureViewport(), which honors the pinned target tab (resolveTargetTab). When
// the target was pinned to an old tab from an earlier fast_tab and the user had
// since moved to a different tab (e.g. the extension Settings page), "screenshot
// the current screen" captured the STALE pinned background tab instead of what the
// user was looking at. A screenshot is inherently about what is visible NOW.
//
// Two preserved escape hatches:
//   • Companion screenshots — the `screenshot:true` flag attached to a DOM action,
//     which ran on the PINNED/driven tab (e.g. in cloud-relay mode where Claude
//     drives a backgrounded tab while the user sits on claude.ai) — pass
//     preferTarget:true to KEEP the pin-aware capture, so they still show the tab
//     the action drove, not the user's foreground tab.
//   • An explicit numeric `tabId` always targets that exact tab.
export async function takeScreenshot(args = {}) {
  try {
    // Companion screenshots stay pin-aware (show the tab the action actually drove).
    if (args.preferTarget && typeof args.tabId !== 'number') {
      const shot = await captureViewport(args);
      return await toCssPixels(shot, await getActiveTab(), args);
    }
    const { tab, ...shot } = await captureForeground(args);
    return await toCssPixels(shot, tab, args);
  } catch (e) {
    return { error: e?.message || String(e), hint: e?.hint };
  }
}

// ONE coordinate space for the model: a screenshot's pixels ARE the CSS pixels
// fast_click_xy takes. Both capture paths (captureVisibleTab and CDP
// Page.captureScreenshot) return DEVICE pixels — CSS px × devicePixelRatio — so
// on a HiDPI screen (dpr 2) a point read off the image clicked twice as far out
// (live Azure: a 2880x1530 image of a ~1440px viewport; the click at 320,145
// hit the page title). Every capture is resized here to the tab's CSS viewport.
// There is no device-resolution mode: nothing downstream maps coordinates by dpr.
// The scale comes from the WIDTH (the tab's width in DIPs over its page zoom =
// the CSS viewport width); the height follows the image at that same scale, so
// the aspect ratio is never distorted by a tab height that disagrees with the
// captured surface. Pure.
export function cssFrame({ imgW, imgH, tabW, zoom }) {
  const z = zoom > 0 ? zoom : 1;
  if (!(tabW > 0) || !(imgW > 0)) return { cssWidth: imgW, cssHeight: imgH, dpr: 1 };
  const cssWidth = Math.round(tabW / z);
  const dpr = imgW / cssWidth;
  return { cssWidth, cssHeight: Math.round(imgH / dpr), dpr: Math.round(dpr * 1000) / 1000 };
}

async function toCssPixels(shot, tab, args = {}) {
  if (!shot || !shot.dataUrl) return shot;
  const format = shot.format || 'png';
  const blob = await (await fetch(shot.dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  let zoom = 1;
  try { if (tab?.id != null) zoom = await chrome.tabs.getZoom(tab.id); } catch {}
  const f = cssFrame({ imgW: bmp.width, imgH: bmp.height, tabW: tab?.width, zoom });
  const meta = { cssWidth: f.cssWidth, cssHeight: f.cssHeight, dpr: f.dpr, scale: 1 };
  if (bmp.width === f.cssWidth && bmp.height === f.cssHeight) { bmp.close?.(); return { ...shot, ...meta }; }
  const canvas = new OffscreenCanvas(f.cssWidth, f.cssHeight);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, f.cssWidth, f.cssHeight);
  bmp.close?.();
  const out = await canvas.convertToBlob({ type: `image/${format}`, ...(format === 'jpeg' ? { quality: (typeof args.quality === 'number' ? args.quality : 90) / 100 } : {}) });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { ...shot, dataUrl: `data:image/${format};base64,${btoa(bin)}`, ...meta };
}

// Resolve the tab to capture: an explicit tabId override, else the user's REAL
// foreground tab (active tab of the last-focused window). Mirrors getActiveTab()'s
// MV3 cold-start fallback (a freshly-woken worker has no "last focused window" yet)
// but DELIBERATELY does NOT consult the pinned target — that is the whole point.
async function resolveForegroundTab(args) {
  if (typeof args.tabId === 'number') {
    try { return await chrome.tabs.get(args.tabId); } catch { /* fall through to foreground */ }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) return tab;
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true });
  for (const w of wins) { const t = w.tabs?.find((t) => t.active); if (t) return t; }
  return undefined;
}

async function captureForeground(args = {}) {
  const format = (args.format || 'png').toLowerCase();
  const capOpts = { format };
  if (format === 'jpeg' && typeof args.quality === 'number') capOpts.quality = args.quality;
  const fresh = args.fresh === true || args.freshCapture === true;

  const tab = await resolveForegroundTab(args);
  if (!tab || typeof tab.windowId !== 'number') {
    const err = new Error('no foreground tab to screenshot');
    err.hint = 'no active/last-focused window resolved; focus a Chrome window and retry.';
    throw err;
  }

  // FRESH capture: chrome.tabs.captureVisibleTab can hand back a STALE composited
  // frame (live bug: 3 byte-identical captures across focus changes), because it
  // reads the GPU compositor's last frame, not necessarily a new paint. CDP
  // Page.captureScreenshot reads the live window surface, so it returns a current
  // frame. Use it FIRST when fresh is requested AND the foreground tab is the one
  // CDP would target (getActiveTab honors the pin — don't let a backgrounded pin
  // divert the capture to the wrong tab). Fall through to the normal path on any
  // failure (e.g. advanced control off).
  if (fresh) {
    try {
      const active = await getActiveTab();
      if (active?.id === tab.id) {
        const dataUrl = await captureViaDebugger(capOpts);
        if (dataUrl) return { dataUrl, format, fresh: true, tab };
      }
    } catch (_) { /* fall through to captureVisibleTab */ }
  }

  // captureVisibleTab is PIXEL-based, so it captures restricted pages too — the
  // chrome-extension:// Settings/options page (the exact tab in the live bug),
  // chrome:// pages, the web store — where DOM scripting is blocked. Scope it to
  // the foreground tab's WINDOW so a multi-window setup grabs the right screen.
  // The API enforces ~2 calls/sec, so the retry is spaced to stay under the quota.
  let lastErr;
  for (let i = 0; i < 2; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 750));
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, capOpts);
      if (dataUrl) return { dataUrl, format, tab };
      lastErr = new Error('captureVisibleTab returned empty');
    } catch (e) { lastErr = e; }
  }

  // GPU compositor wedge ("image readback failed"): try the quota-free CDP path —
  // but ONLY when the foreground tab is the one captureViaDebugger would target.
  // captureViaDebugger resolves its tab via getActiveTab(), which HONORS the pin;
  // if a backgrounded pin is diverting getActiveTab to a different tab, using it
  // would capture the WRONG (pinned) page — the very bug being fixed — so skip CDP
  // in that case. The foreground tab is on-screen anyway, so a wedge is unlikely
  // and the spaced retry above is the right recovery.
  try {
    const active = await getActiveTab();
    if (active?.id === tab.id) {
      const dataUrl = await captureViaDebugger(capOpts);
      if (dataUrl) return { dataUrl, format, tab };
    }
  } catch (e) { lastErr = e; }

  const err = new Error(
    `screenshot of the foreground tab failed (${lastErr?.message || lastErr}). ` +
    `The GPU compositor may be intermittently wedged — a retry in a few seconds may succeed.`
  );
  err.hint = 'foreground-tab capture failed (possible intermittent GPU wedge); retry in a few seconds.';
  throw err;
}
