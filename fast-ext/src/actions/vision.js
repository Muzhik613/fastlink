// Vision capture for the scout's coordinate-grounding tier. Captures the
// visible tab and reports the IMAGE pixel dimensions + devicePixelRatio so the
// server can convert Gemini's normalized 0-1000 points back to CSS px for a
// trusted click. Optionally crops to a region (CSS px) and upscales it — the
// "zoom" half of the conditional crop-zoom refine pass (research: ZoomClick).
//
// Coordinate spaces (load-bearing):
//   • captureVisibleTab image  = DEVICE px  (CSS px × dpr)
//   • fast_click_xy wants       = CSS px
//   • Gemini points come back    = normalized 0-1000 of the IMAGE we send
// So the server divides by dpr at the end; this file just reports dpr + the
// exact image dims (and, for a crop, where the crop sits in CSS space).
import { injectInTab, captureVisiblePinAware, captureViaDebugger } from '../util.js';

// Robust viewport grab for the vision tier (fast_vision_capture, which
// fast_point / fast_fill_vision capture through). The GPU compositor
// intermittently wedges ("image readback failed" / "Failed to capture tab") —
// captureVisibleTab depends on that GPU readback path, while CDP
// Page.captureScreenshot reads the window surface and can succeed when it's
// wedged. captureVisiblePinAware already retries captureVisibleTab (quota-spaced)
// on the foreground path and routes a backgrounded pinned tab through CDP, but
// its foreground path has no CDP fallback — so add one here before surfacing an
// error. Returns a device-px dataUrl, or null only after every path is exhausted.
async function captureForVision(capOpts = { format: 'png' }) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 200));
    try {
      const d = await captureVisiblePinAware(capOpts);
      if (d) return d;
    } catch (e) { lastErr = e; }
  }
  // captureVisibleTab kept failing the GPU readback — fall back to CDP.
  try {
    const d = await captureViaDebugger(capOpts);
    if (d) return d;
  } catch (e) { lastErr = e; }
  if (lastErr) console.warn('[fastlink] vision capture exhausted retries:', lastErr?.message || lastErr);
  return null;
}

function readDpr() {
  return window.devicePixelRatio || 1;
}

// Decode a captured dataURL → ImageBitmap, draw (optionally a crop, upscaled)
// to an OffscreenCanvas, return a PNG dataURL. Returns the natural image size
// too so the caller knows the pixel frame Gemini will see.
async function process(dataUrl, cropDev, zoom) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  if (!cropDev) {
    return { dataUrl, imgW: bmp.width, imgH: bmp.height };
  }
  // Clamp the crop to the image bounds (device px).
  const sx = Math.max(0, Math.min(cropDev.x, bmp.width - 1));
  const sy = Math.max(0, Math.min(cropDev.y, bmp.height - 1));
  const sw = Math.max(1, Math.min(cropDev.w, bmp.width - sx));
  const sh = Math.max(1, Math.min(cropDev.h, bmp.height - sy));
  const z = zoom || 2;
  const cvs = new OffscreenCanvas(Math.round(sw * z), Math.round(sh * z));
  const ctx = cvs.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, cvs.width, cvs.height);
  const outBlob = await cvs.convertToBlob({ type: 'image/png' });
  const out = await blobToDataURL(outBlob);
  return { dataUrl: out, imgW: cvs.width, imgH: cvs.height };
}

async function blobToDataURL(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:image/png;base64,' + btoa(bin);
}

// args:
//   crop?: { x, y, w, h } in CSS px (a region of the viewport to zoom into)
//   zoom?: upscale factor for the crop (default 2)
// returns: { dataUrl, imgW, imgH, dpr, crop } where crop (if any) echoes the
// CSS-space region so the server can map normalized points within the crop back
// to full-viewport CSS coordinates.
export async function visionCapture(args = {}) {
  try {
    const r = await injectInTab({ world: 'MAIN', func: readDpr });
    if (r.error) return r;
    const dpr = r.result || 1;

    const dataUrl = await captureForVision({ format: 'png' });
    if (!dataUrl) return { error: 'vision capture failed: GPU image readback wedged and the CDP fallback also failed — retry in a moment' };

    const cropCss = args.crop && typeof args.crop === 'object' ? args.crop : null;
    const cropDev = cropCss
      ? { x: cropCss.x * dpr, y: cropCss.y * dpr, w: cropCss.w * dpr, h: cropCss.h * dpr }
      : null;
    const processed = await process(dataUrl, cropDev, args.zoom);
    return {
      dataUrl: processed.dataUrl,
      imgW: processed.imgW,
      imgH: processed.imgH,
      dpr,
      crop: cropCss || undefined,
    };
  } catch (e) {
    return { error: 'vision capture failed: ' + (e?.message || String(e)) };
  }
}
