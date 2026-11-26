// sheet.js — pages Chrome draws outside the tab strip (the Google Pay payment sheet
// pay.google.com/gp/p/ui/pay is a Payment Handler window: a page target with no tab, so
// chrome.tabs never sees it). Listed from chrome.debugger.getTargets(); read and clicked over
// a debugger session on the target itself: snapshot, screenshot, click (by snapshot id, text,
// or x/y). No typing, no navigation. `hosts` (from the relay, for service tokens) limits which
// sheets are listed or touched.

const VERSION = '1.3';
const attached = new Set();   // targetIds we hold a session on

try { chrome.debugger.onDetach.addListener((src) => { if (src?.targetId) attached.delete(src.targetId); }); } catch { /* node tests */ }

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
const isWeb = (url) => /^https?:/.test(url || '');

async function findTarget(targetId, hosts) {
  const ts = await chrome.debugger.getTargets();
  const t = ts.find((x) => x.id === targetId);
  if (!t) return { error: `No page target ${targetId} (the sheet closed?). fast_list shows the open ones.`, code: 'no_target' };
  if (t.tabId != null) return { error: `Target ${targetId} is tab ${t.tabId}: use tabId for tabs.`, code: 'is_tab' };
  if (t.type !== 'page') return { error: `Target ${targetId} is a frame inside a tab, not a sheet: use that tab's tabId.`, code: 'not_sheet' };
  if (!isWeb(t.url)) return { error: 'That target is not a web page.', code: 'no_target' };
  if (hosts && !hosts.includes(hostOf(t.url))) return { error: `This token may use only sheets on ${hosts.join(', ')}.`, code: 'host_blocked' };
  return { target: t };
}

async function tcdp(targetId, method, params = {}) {
  if (!attached.has(targetId)) {
    try { await chrome.debugger.attach({ targetId }, VERSION); }
    catch (e) { if (!/already attached/i.test(e?.message || '')) throw e; }
    attached.add(targetId);
  }
  return chrome.debugger.sendCommand({ targetId }, method, params);
}

// fast_list's extra rows: {targetId, kind:'sheet', url, title, openerTabId?}
export async function listSheets(hosts = null) {
  let ts = [];
  try { ts = await chrome.debugger.getTargets(); } catch { return []; }
  const out = [];
  for (const t of ts) {
    // a sheet is a whole page with no tab; cross-origin iframes also come back tab-less (as 'other')
    if (t.tabId != null || t.type !== 'page' || !isWeb(t.url)) {
      if (attached.has(t.id)) { attached.delete(t.id); chrome.debugger.detach({ targetId: t.id }).catch(() => {}); }
      continue;
    }
    if (hosts && !hosts.includes(hostOf(t.url))) continue;
    let openerTabId;
    try {
      const info = await tcdp(t.id, 'Target.getTargetInfo');
      const op = info?.targetInfo?.openerId;
      const o = op && ts.find((x) => x.id === op);
      if (o && o.tabId != null) openerTabId = o.tabId;
    } catch { /* listed without its opener */ }
    out.push({ targetId: t.id, kind: 'sheet', url: t.url, title: t.title, ...(openerTabId != null ? { openerTabId } : {}) });
  }
  return out;
}

// Runs inside the sheet (Runtime.evaluate of its source): controls with top-page centre
// coordinates, same-origin frames included; cross-origin frames are listed as boxes.
export function sheetSnapshot() {
  const items = [], texts = [], frames = [];
  const SEL = 'button,a[href],input,select,textarea,[role=button],[role=link],[role=radio],[role=checkbox],[role=option],[role=menuitem],[role=tab],[tabindex]:not([tabindex="-1"])';
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const visit = (doc, ox, oy, depth) => {
    if (depth > 5 || !doc) return;
    const win = doc.defaultView;
    for (const el of doc.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cs = win.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      const label = clean(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('placeholder'));
      const it = { i: items.length, tag: el.tagName.toLowerCase(), label, x: Math.round(ox + r.left + r.width / 2), y: Math.round(oy + r.top + r.height / 2) };
      const role = el.getAttribute('role'); if (role) it.role = role;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') it.disabled = true;
      if (el.getAttribute('aria-checked') === 'true' || el.checked) it.checked = true;
      items.push(it);
    }
    const t = clean(doc.body ? doc.body.innerText : '');
    if (t) texts.push(t.slice(0, 6000));
    for (const f of doc.querySelectorAll('iframe')) {
      const r = f.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      let d = null;
      try { d = f.contentDocument; } catch { d = null; }
      if (d) visit(d, ox + r.left + f.clientLeft, oy + r.top + f.clientTop, depth + 1);
      else frames.push({ src: String(f.src || '').slice(0, 300), x: Math.round(ox + r.left + f.clientLeft), y: Math.round(oy + r.top + f.clientTop), w: Math.round(r.width), h: Math.round(r.height) });
    }
  };
  visit(document, 0, 0, 0);
  return JSON.stringify({ url: location.href, title: document.title, items, text: texts.join('\n').slice(0, 12000), ...(frames.length ? { crossOriginFrames: frames, note: 'cross-origin frames: read separately by fast_snapshot' } : {}) });
}

async function evalSnap(targetId, contextId = null) {
  const r = await tcdp(targetId, 'Runtime.evaluate', { expression: `(${sheetSnapshot.toString()})()`, returnByValue: true, ...(contextId ? { contextId } : {}) });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || 'exception');
  return JSON.parse(r.result.value);
}

// A cross-origin frame's own target: chrome.debugger lists OOPIFs as tab-less non-page targets
// (it delivers no auto-attach child sessions to extensions, so this is the way in). Matched to
// the frame box the parent document reported by origin + path.
const urlKey = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return ''; } };
export function frameTargetFor(src, targets, used) {
  const want = urlKey(src);
  const pool = targets.filter((t) => t.tabId == null && t.type !== 'page' && t.type !== 'worker' && isWeb(t.url) && !used.has(t.id));
  return pool.find((t) => urlKey(t.url) === want)
    || pool.find((t) => want && urlKey(t.url).startsWith(want.replace(/\/[^/]*$/, '/')))
    || pool.find((t) => hostOf(t.url) === hostOf(src))
    || null;
}

// Every frame of the sheet's own process: [{id, url}] (Page.getFrameTree).
async function frameList(targetId) {
  const out = [];
  try {
    const { frameTree } = await tcdp(targetId, 'Page.getFrameTree');
    const walk = (n) => { if (!n) return; out.push({ id: n.frame.id, url: n.frame.url || '' }); for (const c of n.childFrames || []) walk(c); };
    walk(frameTree);
  } catch { /* none */ }
  return out;
}
function frameInTree(frames, src, used) {
  const want = urlKey(src);
  const pool = frames.slice(1).filter((f) => isWeb(f.url) && !used.has(f.id));
  return pool.find((f) => urlKey(f.url) === want) || pool.find((f) => hostOf(f.url) === hostOf(src)) || null;
}

// The sheet's own document, then its cross-origin frames (allowed hosts only, nested too), with
// their controls in the sheet's coordinates: what a person sees and can click.
async function snap(targetId, frameHosts = null) {
  const top = await evalSnap(targetId);
  const items = [...top.items];
  const texts = [top.text];
  const read = [], notRead = [];
  let targets = [];
  try { targets = await chrome.debugger.getTargets(); } catch {}
  const used = new Set([targetId]);
  const usedFrames = new Set();
  const queue = (top.crossOriginFrames || []).map((f) => ({ ...f, ox: 0, oy: 0, depth: 1 }));
  while (queue.length) {
    const f = queue.shift();
    const host = hostOf(f.src);
    if (frameHosts && !frameHosts.includes(host)) { notRead.push({ host, why: 'host not allowed for this token' }); continue; }
    // Same-site frames (payments.google.com inside pay.google.com) share the sheet's process:
    // no target of their own, but a frame in its tree — read through an isolated world there.
    // A frame in another process has its own target instead.
    const inTree = frameInTree(await frameList(targetId), f.src, usedFrames);
    const t = inTree ? null : frameTargetFor(f.src, targets, used);
    if (!inTree && !t) { notRead.push({ host, src: f.src.slice(0, 120), why: 'frame not found in the sheet or as a target', box: { x: f.ox + f.x, y: f.oy + f.y, w: f.w, h: f.h } }); continue; }
    if (t) used.add(t.id); else usedFrames.add(inTree.id);
    try {
      let sub;
      if (t) sub = await evalSnap(t.id);
      else {
        const w = await tcdp(targetId, 'Page.createIsolatedWorld', { frameId: inTree.id, worldName: 'fastlink-sheet', grantUniveralAccess: false });
        sub = await evalSnap(targetId, w.executionContextId);
      }
      const t2 = t || { url: inTree.url };
      const ox = f.ox + f.x, oy = f.oy + f.y;
      for (const it of sub.items) items.push({ ...it, i: items.length, x: Math.round(it.x + ox), y: Math.round(it.y + oy), frame: host });
      if (sub.text) texts.push(sub.text);
      read.push(t2.url.slice(0, 120));
      if (f.depth < 4) for (const g of sub.crossOriginFrames || []) queue.push({ ...g, ox, oy, depth: f.depth + 1 });
    } catch (e) { notRead.push({ host, why: e?.message || String(e) }); }
  }
  const out = { url: top.url, title: top.title, items, text: texts.filter(Boolean).join('\n').slice(0, 20000) };
  if (read.length) out.frames = read;
  if (notRead.length) out.framesNotRead = notRead;
  return out;
}

// One entry point for the four tools that take a targetId.
export async function sheetAction(action, args = {}) {
  const hosts = Array.isArray(args.sheetHosts) ? args.sheetHosts.map(String) : null;
  const found = await findTarget(String(args.targetId), hosts);
  if (found.error) return found;
  const id = found.target.id;
  const base = { targetId: id, url: found.target.url };
  try {
    if (action === 'fast_snapshot') return { ...base, ...(await snap(id, hosts)) };
    if (action === 'fast_screenshot') {
      const fmt = args.format === 'jpeg' ? 'jpeg' : 'png';
      const shot = await tcdp(id, 'Page.captureScreenshot', { format: fmt, ...(fmt === 'jpeg' && typeof args.quality === 'number' ? { quality: args.quality } : {}) });
      return { ...base, dataUrl: `data:image/${fmt};base64,${shot.data}` };
    }
    if (action === 'fast_click_xy') {
      if (typeof args.x !== 'number' || typeof args.y !== 'number') return { error: 'fast_click_xy: x and y must be numbers' };
      await clickAt(id, args.x, args.y);
      return { ...base, clicked: { x: args.x, y: args.y } };
    }
    if (action === 'fast_click') {
      const s = await snap(id, hosts);
      let it = null;
      if (args.id != null && args.id !== '') it = s.items.find((x) => String(x.i) === String(args.id));
      else if (args.text) {
        const want = String(args.text).replace(/\s+/g, ' ').trim().toLowerCase();
        const pool = s.items.filter((x) => (!args.role || x.role === args.role) && (!args.tag || x.tag === String(args.tag).toLowerCase()));
        const exact = pool.filter((x) => x.label.toLowerCase() === want);
        const part = pool.filter((x) => x.label.toLowerCase().includes(want));
        const list = exact.length ? exact : part;
        it = list[Number.isInteger(args.index) ? args.index : 0] || null;
      } else return { error: 'fast_click on a sheet needs `id` (from its fast_snapshot) or `text`' };
      if (!it) return { error: `No control ${args.id != null ? `#${args.id}` : `"${args.text}"`} in the sheet.`, items: s.items.map((x) => ({ i: x.i, label: x.label })) };
      if (it.disabled) return { error: `"${it.label}" is disabled.`, item: it };
      await clickAt(id, it.x, it.y);
      return { ...base, clicked: it.label, at: { x: it.x, y: it.y } };
    }
    return { error: `${action} does not take a targetId (sheets: fast_snapshot, fast_screenshot, fast_click, fast_click_xy)` };
  } catch (e) {
    return { error: `sheet ${action} failed: ${e?.message || e}` };
  }
}
