// Human hand-off (fast_handoff, relay-driven). The relay's phone page shows a person ONLY the
// challenge region of one tab and turns their taps into real clicks there. Two actions:
//   handoff_frame {tabId, region?} → { dataUrl (jpeg of the region only), crop, found }
//   handoff_tap   {tabId, x, y}    → { clickedAt }
// The crop is computed HERE, and the capture is clipped by Chrome, so pixels outside the
// challenge never leave the browser. Neither action is an MCP tool: only the relay's
// hand-off page calls them, for a tab an agent handed off.
import { cdp } from './input.js';
import { getInjectableTab } from '../util.js';

// Challenge providers whose frames make up "the captcha" on a page.
const CHALLENGE_SRC = /(^|\.)(google\.com|recaptcha\.net)\/recaptcha\/|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs\.com|funcaptcha\.com/i;
const PAD = 6;

// Runs in the tab's top frame: visible challenge iframes (in viewport CSS px), grouped by the
// provider of the largest one, plus the viewport and scroll offset.
function readChallenge(srcRe) {
  const re = new RegExp(srcRe, 'i');
  const vw = innerWidth, vh = innerHeight;
  const boxes = [];
  for (const f of document.querySelectorAll('iframe')) {
    const src = f.src || '';
    if (!re.test(src)) continue;
    if (f.checkVisibility && !f.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = f.getBoundingClientRect();
    if (r.width < 20 || r.height < 20 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
    let host = ''; try { host = new URL(src).hostname; } catch {}
    boxes.push({ x: r.left, y: r.top, w: r.width, h: r.height, host });
  }
  return { boxes, vw, vh, sx: scrollX, sy: scrollY };
}

function unionCrop(boxes, vw, vh) {
  if (!boxes.length) return null;
  const main = boxes.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  const mine = boxes.filter((b) => b.host === main.host);
  const x0 = Math.max(0, Math.min(...mine.map((b) => b.x)) - PAD), y0 = Math.max(0, Math.min(...mine.map((b) => b.y)) - PAD);
  const x1 = Math.min(vw, Math.max(...mine.map((b) => b.x + b.w)) + PAD), y1 = Math.min(vh, Math.max(...mine.map((b) => b.y + b.h)) + PAD);
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

async function handoffFrame({ tabId, region, quality }) {
  const got = await getInjectableTab(tabId);
  if (got.error) return got;
  const id = got.tab.id;
  const [{ result: page }] = await chrome.scripting.executeScript({
    target: { tabId: id, frameIds: [0] }, func: readChallenge, args: [CHALLENGE_SRC.source],
  });
  let crop = null;
  const found = page.boxes.length > 0;
  if (region && [region.x, region.y, region.w, region.h].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    const x = Math.max(0, region.x), y = Math.max(0, region.y);
    crop = { x: Math.round(x), y: Math.round(y), w: Math.round(Math.min(page.vw - x, region.w)), h: Math.round(Math.min(page.vh - y, region.h)) };
  } else {
    crop = unionCrop(page.boxes, page.vw, page.vh);
  }
  if (!crop || crop.w < 10 || crop.h < 10) return { tabId: id, found: false, crop: null };
  // Clip in page coordinates (viewport + scroll); Chrome renders only that rectangle.
  const res = await cdp(id, 'Page.captureScreenshot', {
    format: 'jpeg', quality: typeof quality === 'number' ? quality : 70, captureBeyondViewport: false,
    clip: { x: crop.x + page.sx, y: crop.y + page.sy, width: crop.w, height: crop.h, scale: 1 },
  });
  if (!res?.data) return { error: 'the browser returned no picture of the challenge' };
  return { tabId: id, found, crop, dataUrl: `data:image/jpeg;base64,${res.data}` };   // dataUrl: card masking skips it
}

// A plain trusted click (CDP), without fast_click_xy's focus probe across every frame,
// which takes seconds on challenge pages.
async function handoffTap({ tabId, x, y }) {
  if (![x, y].every((n) => typeof n === 'number' && Number.isFinite(n))) return { error: 'x and y must be numbers' };
  const got = await getInjectableTab(tabId);
  if (got.error) return got;
  const id = got.tab.id;
  await cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await cdp(id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  return { tabId: id, clickedAt: { x, y } };
}

export const handoffActions = { handoff_frame: handoffFrame, handoff_tap: handoffTap };
