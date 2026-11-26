// sheet.js — pages Chrome draws outside the tab strip (the Google Pay payment sheet
// pay.google.com/gp/p/ui/pay is a Payment Handler window: a page target with no tab, so
// chrome.tabs never sees it). Listed from chrome.debugger.getTargets(); read and clicked over
// a debugger session on the target itself: snapshot, screenshot, click (by snapshot id, text,
// or x/y). No typing, no navigation. `hosts` (from the relay, for service tokens) limits which
// sheets are listed or touched.

const VERSION = '1.3';
const attached = new Set();   // targetIds we hold a session on

try { chrome.debugger.onDetach.addListener((src) => { if (src?.targetId) { attached.delete(src.targetId); children.delete(src.targetId); } }); } catch { /* node tests */ }

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

// Child sessions (cross-origin frames inside a sheet), per sheet: sessionId -> {targetId, url, parent}.
// Filled by Target.attachedToTarget events after Target.setAutoAttach {flatten:true}.
const children = new Map();   // sheet targetId -> Map(sessionId -> {frameId, url, parentSession})
try {
  chrome.debugger.onEvent.addListener((src, method, p) => {
    const root = src?.targetId;
    if (!root || !children.has(root)) return;
    const m = children.get(root);
    if (method === 'Target.attachedToTarget' && p?.targetInfo?.type === 'iframe') {
      m.set(p.sessionId, { frameId: p.targetInfo.targetId, url: p.targetInfo.url, parentSession: src.sessionId || null });
      // its own cross-origin children too
      chrome.debugger.sendCommand({ targetId: root, sessionId: p.sessionId }, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    } else if (method === 'Target.detachedFromTarget') m.delete(p?.sessionId);
    else if (method === 'Target.targetInfoChanged' && p?.targetInfo) {
      for (const c of m.values()) if (c.frameId === p.targetInfo.targetId) c.url = p.targetInfo.url;
    }
  });
} catch { /* node tests */ }

async function frameSessions(targetId) {
  if (!children.has(targetId)) {
    children.set(targetId, new Map());
    await tcdp(targetId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await new Promise((r) => setTimeout(r, 400));   // the attach events for frames already there
  }
  return children.get(targetId);
}
const send = (targetId, sessionId, method, params = {}) =>
  chrome.debugger.sendCommand(sessionId ? { targetId, sessionId } : { targetId }, method, params);

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
      else frames.push({ src: String(f.src || '').slice(0, 200), x: Math.round(ox + r.left), y: Math.round(oy + r.top), w: Math.round(r.width), h: Math.round(r.height) });
    }
  };
  visit(document, 0, 0, 0);
  return JSON.stringify({ url: location.href, title: document.title, items, text: texts.join('\n').slice(0, 12000), ...(frames.length ? { crossOriginFrames: frames, note: 'cross-origin frames are not read: fast_screenshot + fast_click_xy with this targetId' } : {}) });
}

async function evalSnap(targetId, sessionId) {
  const r = await send(targetId, sessionId, 'Runtime.evaluate', { expression: `(${sheetSnapshot.toString()})()`, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || 'exception');
  return JSON.parse(r.result.value);
}

// Where a cross-origin frame's content box sits in its parent's viewport (CSS px).
async function frameOffset(targetId, parentSession, frameId) {
  await send(targetId, parentSession, 'DOM.getDocument', { depth: 0 });
  const { backendNodeId } = await send(targetId, parentSession, 'DOM.getFrameOwner', { frameId });
  const { model } = await send(targetId, parentSession, 'DOM.getBoxModel', { backendNodeId });
  return { x: model.content[0], y: model.content[1] };
}

// The sheet's own document, then every cross-origin frame in it (allowed hosts only), with
// their controls in the sheet's coordinates: what a person sees and can click.
async function snap(targetId, frameHosts = null) {
  await tcdp(targetId, 'Runtime.enable').catch(() => {});
  const top = await evalSnap(targetId, null);
  const items = [...top.items];
  const texts = [top.text];
  const read = [], skipped = [];
  const kids = await frameSessions(targetId);
  // offsets resolve parent-first: a frame's position is its owner box plus its parent frame's
  const offsets = new Map([[null, { x: 0, y: 0 }]]);
  const pending = [...kids.entries()];
  for (let pass = 0; pass < 4 && pending.length; pass++) {
    for (let k = pending.length - 1; k >= 0; k--) {
      const [sid, c] = pending[k];
      if (!offsets.has(c.parentSession)) continue;
      pending.splice(k, 1);
      if (frameHosts && !frameHosts.includes(hostOf(c.url))) { skipped.push(hostOf(c.url)); continue; }
      try {
        const own = await frameOffset(targetId, c.parentSession, c.frameId);
        const base = offsets.get(c.parentSession);
        const off = { x: base.x + own.x, y: base.y + own.y };
        offsets.set(sid, off);
        const f = await evalSnap(targetId, sid);
        for (const it of f.items) items.push({ ...it, i: items.length, x: Math.round(it.x + off.x), y: Math.round(it.y + off.y), frame: hostOf(c.url) });
        if (f.text) texts.push(f.text);
        read.push(c.url.slice(0, 120));
      } catch (e) { skipped.push(`${hostOf(c.url)} (${e?.message || e})`); }
    }
  }
  const out = { url: top.url, title: top.title, items, text: texts.filter(Boolean).join('\n').slice(0, 20000) };
  if (read.length) out.frames = read;
  if (skipped.length) out.framesNotRead = skipped;
  return out;
}

async function clickAt(targetId, x, y) {
  await tcdp(targetId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await tcdp(targetId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await tcdp(targetId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
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
