// Frame reach: the ONE way FastLink looks inside every frame of a tab,
// cross-origin iframes included.
//
// The extension holds <all_urls>, so chrome.scripting.executeScript runs in any
// http(s) frame — all of them (allFrames:true) or exactly the ones named
// (frameIds, from webNavigation.getAllFrames below). The page's same-origin
// policy stops the TOP document from reaching into a cross-origin iframe; it
// does not stop the extension.
//
// Reach is deliberately narrow. Only the fixed functions in this codebase are
// injected (the focus probe in input.js, the field reader and the frame probe
// below). Callers pass DATA (a URL substring, label strings, a text), never code.
//
// Frames the extension may not inject into (another extension's page, the web
// store, possibly about:blank/srcdoc frames) simply do not answer; callers that
// care name them from the iframes the answering frames can see.
import { getInjectableTab } from '../util.js';

// Run `func(...args)` in every frame of the tab. Returns [{ frameId, result }]
// for each frame that answered with a non-null result.
export async function inAllFrames(tabId, func, args = [], world = 'ISOLATED') {
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, world, func, args,
  });
  return (injections || []).filter((r) => r && r.result != null).map((r) => ({ frameId: r.frameId, result: r.result }));
}

// ── Field read ───────────────────────────────────────────────────────────────
// Runs in every frame (ISOLATED world: the page cannot tamper with what it
// reads). A frame whose URL does not contain `frameSub` returns only its URL.
// A matching frame returns, per label, every VISIBLE control carrying that label:
//   lookup order <label for>/wrapping <label>, aria-labelledby, aria-label, then
//   the text of the field's form row — the first stage that finds anything wins.
// Values, exactly as the control holds them:
//   input/textarea → .value, NOT trimmed (appended junk must survive the read)
//   <select>       → the selected option's text
//   combobox/listbox/other → the text the closed control shows ("" when that
//                    text is its placeholder)
//   password       → null (never read out)
function readFieldsInFrame(frameSub, labels) {
  const url = location.href;
  if (!url.includes(frameSub)) return { url, matched: false };

  const FIELD = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]),'
    + 'textarea,select,[role=combobox],[role=listbox],[role=textbox],[role=spinbutton],[contenteditable=""],[contenteditable=true]';
  const SKIP_TEXT = 'button,[role=button],[role=tooltip],svg,script,style,template,noscript,[aria-hidden=true],[hidden]';
  const norm = (s) => String(s || '')
    .replace(/[\uE000-\uF8FF]/g, '')          // icon-font glyphs
    .replace(/\s+/g, ' ').trim()
    .replace(/\s*[*:]+$/, '').trim()           // "Name *", "Name:"
    .toLowerCase();
  const visible = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden) return false;
      const cs = getComputedStyle(n);
      if (cs.display === 'none') return false;
      if (n === el && cs.visibility === 'hidden') return false;
    }
    return true;
  };
  // The text a label element shows, without its info buttons, icons, tooltips.
  const labelText = (el) => {
    let out = '';
    const walk = (n) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1 && !c.matches(SKIP_TEXT) && !c.matches(FIELD) && c.tagName !== 'OPTION') { out += ' '; walk(c); out += ' '; }
      }
    };
    walk(el);
    return norm(out);
  };
  const isField = (el) => !!el && el.nodeType === 1 && el.matches(FIELD);
  // one control per widget: a combobox <div> wrapping its own <input> is one field
  const outermost = (els) => {
    const uniq = [...new Set(els)].filter((el) => isField(el) && visible(el));
    return uniq.filter((el) => !uniq.some((o) => o !== el && o.contains(el)));
  };

  const readValue = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const base = { tag, role };
    if (tag === 'input' || tag === 'textarea') {
      if (el.type === 'password') return { ...base, value: null, reason: 'password field: value not read' };
      if (el.type === 'checkbox' || el.type === 'radio') return { ...base, value: String(!!el.checked) };
      return { ...base, value: el.value == null ? '' : String(el.value) };
    }
    if (tag === 'select') {
      const o = el.selectedOptions && el.selectedOptions[0];
      return { ...base, value: o ? o.text : '' };
    }
    const inner = el.querySelector('input:not([type=hidden]),textarea');
    if (inner && visible(inner)) return { ...readValue(inner), tag, role };
    const shown = String(el.textContent || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
    const ph = el.getAttribute('aria-placeholder') || el.getAttribute('placeholder');
    const isPlaceholder = (ph && shown === ph.trim())
      || [...el.querySelectorAll('[class*="placeholder" i]')].some((p) => String(p.textContent || '').replace(/\s+/g, ' ').trim() === shown);
    return { ...base, value: isPlaceholder ? '' : shown };
  };

  const fields = {};
  for (const raw of labels) {
    const want = norm(raw);
    let hits = [];
    // 1. <label for> / wrapping <label>
    if (!hits.length) {
      hits = outermost([...document.querySelectorAll('label')]
        .filter((l) => labelText(l) === want).map((l) => l.control).filter(Boolean));
    }
    // 2. aria-labelledby (the whole reference list, or any one element in it)
    if (!hits.length) {
      hits = outermost([...document.querySelectorAll('[aria-labelledby]')].filter((el) => {
        const refs = el.getAttribute('aria-labelledby').split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean);
        return refs.length && (norm(refs.map(labelText).join(' ')) === want || refs.some((r) => labelText(r) === want));
      }));
    }
    // 3. aria-label
    if (!hits.length) {
      hits = outermost([...document.querySelectorAll('[aria-label]')].filter((el) => norm(el.getAttribute('aria-label')) === want));
    }
    // 4. the text of the field's form row: the element showing exactly the label,
    //    then the nearest ancestor holding a field — all of that row's fields
    if (!hits.length && document.body) {
      const labelEls = new Set();
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let t = tw.nextNode(); t; t = tw.nextNode()) {
        const piece = norm(t.nodeValue);
        if (!piece || !want.includes(piece)) continue;
        for (let el = t.parentElement, i = 0; el && i < 4; el = el.parentElement, i++) {
          if (el.closest(SKIP_TEXT) || isField(el) || el.querySelector(FIELD)) break;
          if (labelText(el) === want) { labelEls.add(el); break; }
        }
      }
      const rows = [];
      for (const l of labelEls) {
        if (!visible(l)) continue;
        for (let a = l.parentElement, i = 0; a && i < 8; a = a.parentElement, i++) {
          const inRow = outermost([...a.querySelectorAll(FIELD)]);
          if (inRow.length) { rows.push(...inRow); break; }
        }
      }
      hits = outermost(rows);
    }
    fields[raw] = hits.map(readValue);
  }
  return { url, matched: true, fields };
}

// fast_frame_read { frame, fields } — the live values of labelled fields inside
// the frames whose URL contains `frame`, merged across every matching frame.
// Ambiguity is refused: count > 1 → value null.
export async function frameRead({ frame, fields } = {}) {
  if (typeof frame !== 'string' || !frame) return { error: 'fast_frame_read: frame (a substring of the frame URL) is required' };
  if (!Array.isArray(fields) || !fields.length || fields.some((f) => typeof f !== 'string' || !f.trim())) {
    return { error: 'fast_frame_read: fields must be a non-empty array of label texts' };
  }
  const got = await getInjectableTab();
  if (got.error) return got;
  const answers = (await inAllFrames(got.tab.id, readFieldsInFrame, [frame, fields])).map((a) => a.result);
  const matched = answers.filter((a) => a.matched);
  if (!matched.length) {
    return { error: `no frame URL contains ${JSON.stringify(frame)}`, frames: answers.map((a) => a.url) };
  }
  const out = {};
  for (const label of fields) {
    const all = matched.flatMap((a) => a.fields[label] || []);
    const first = all[0];
    out[label] = {
      found: all.length > 0,
      count: all.length,
      value: all.length === 1 ? first.value : null,
      ...(first ? { tag: first.tag, role: first.role } : {}),
      ...(all.length === 1 && first.reason ? { reason: first.reason } : {}),
    };
  }
  return { frames: matched.map((a) => a.url), fields: out };
}

// ── Frame tree ───────────────────────────────────────────────────────────────
// Which frame is which comes from chrome.webNavigation.getAllFrames: it runs in
// the browser process (no script in any page, 4ms for 4 frames, ~440ms for
// 1,000) and gives every frame, cross-origin included, with its parent. What
// the browser does NOT know is whether a frame is rendered; only its parent
// document does, so a parent lists its rendered <iframe>s by URL and those URLs
// are matched to that parent's child frames here.

// Map parentFrameId → [{ id, url }] in the browser's order. Empty map on failure.
export async function frameTree(tabId) {
  const byParent = new Map();
  let all = [];
  try { all = (await chrome.webNavigation.getAllFrames({ tabId })) || []; } catch {}
  for (const f of all) {
    if (f.parentFrameId < 0 || f.errorOccurred) continue;
    if (!byParent.has(f.parentFrameId)) byParent.set(f.parentFrameId, []);
    byParent.get(f.parentFrameId).push({ id: f.frameId, url: f.url });
  }
  return byParent;
}

// The child frames of one parent that its rendered <iframe> elements point at:
// each src (in the parent's priority order) takes one unclaimed child whose URL
// is exactly it, else one of the same origin. A child no rendered element
// claims is a hidden / zero-size / not-http frame and is not returned. Pure.
export function matchChildFrames(children, srcs) {
  const free = [...(children || [])];
  const out = [];
  for (const src of srcs || []) { const c = claimChild(free, src); if (c) out.push(c); }
  return out;
}

// ── Text wait across frames ──────────────────────────────────────────────────
// COST MODEL (measured, headless Chrome, a page of 5,000 iframes — Chrome
// loads at most ~1,000 sub-frames per page, the rest stay empty elements): ONE
// allFrames injection is ~1.2-2s cold / ~110ms warm, and every same-origin
// frame's script runs on the TOP document's main thread, so broadcasting a
// probe every 250ms made a top-frame text wait 13x slower (74ms → 966ms) and
// overran a 3s timeout by ~800ms. So the wait never broadcasts. It walks the
// frame tree from the top, injecting into a few NAMED frames per tick
// (target.frameIds):
//   • a frame is visited only when its parent renders it (a box of at least
//     2×2 px, not visibility:hidden) and it is http(s) — in-view first, then by area;
//   • at most FRAME_WALK.perTick frames per tick, FRAME_WALK.gapMs apart; a
//     finished pass backs off (firstMs → doubling → maxMs) before the next;
//   • the first tick waits FRAME_WALK.firstMs, so text already in the top
//     document resolves through page.js alone, with no frame work at all.

// Runs in ONE frame (ISOLATED world). Reports this frame's URL; when `needle`
// is given, whether its rendered text contains it (script/style/template/
// noscript text does not count); and, unless it was found, the URLs of its
// rendered http(s) child frames — in-view first, then by area, at most
// `maxKids`, the element scan bounded to ~30ms.
function frameProbe(needle, maxKids) {
  const url = location.href;
  let found = false;
  if (needle && document.body) {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let text = '';
    for (let t = tw.nextNode(); t; t = tw.nextNode()) {
      const p = t.parentElement;
      if (p && p.closest('script,style,template,noscript,[hidden]')) continue;
      text += t.nodeValue;
    }
    found = text.replace(/\s+/g, ' ').toLowerCase().includes(needle);
  }
  if (found) return { url, found, kids: [] };
  const kids = [];
  const els = document.querySelectorAll('iframe,frame');
  const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
  const t0 = Date.now();
  for (let i = 0; i < els.length; i++) {
    if ((i & 127) === 127 && Date.now() - t0 > 30) break;
    const el = els[i];
    let src = '';
    try { src = new URL(el.getAttribute('src') || '', location.href).href; } catch {}
    if (!/^https?:/.test(src)) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width >= 2 && r.height >= 2)) continue;
    try { if (getComputedStyle(el).visibility === 'hidden') continue; } catch {}
    const inView = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    kids.push({ src, inView, area: r.width * r.height });
  }
  kids.sort((a, b) => (b.inView - a.inView) || (b.area - a.area));
  return { url, found, kids: kids.slice(0, maxKids).map((k) => k.src) };
}

const WAIT_GRACE_MS = 400;
export const FRAME_WALK = { firstMs: 300, gapMs: 60, maxMs: 2000, perTick: 12, maxKids: 200, depth: 4 };

const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Inject frameProbe into exactly these frames. A frame that cannot be injected
// (another extension's page, a frame torn down since it was listed) fails the
// whole call, so a failed batch is retried one frame at a time. Returns
// Map frameId → result | null.
async function probeFrames(tabId, ids, needle, maxKids) {
  const out = new Map(ids.map((id) => [id, null]));
  const run = async (frameIds) => {
    const res = await chrome.scripting.executeScript({ target: { tabId, frameIds }, world: 'ISOLATED', func: frameProbe, args: [needle, maxKids] });
    for (const r of res || []) if (r && out.has(r.frameId)) out.set(r.frameId, r.result ?? null);
  };
  try { await run(ids); } catch {
    if (ids.length > 1) for (const id of ids) { try { await run([id]); } catch {} }
  }
  return out;
}

// fast_wait {text} that can see inside frames. `topWait` is page.js's own
// top-frame wait (a promise-returning function); it runs untouched. Rendered
// sub-frames are walked in bounded ticks (FRAME_WALK above): text found inside
// one resolves the wait at once (inFrame:true + the frame URL), and `cancelTop`
// stops page.js's still-running wait so it does not poll on behind the answer.
// If the top wait times out, its result gains `frames: {searched, unsearched}`
// — the origins searched, and those of rendered frames that were not.
export async function waitTextAnyFrame(args, topWait, { cancelTop, walk = FRAME_WALK } = {}) {
  const text = String((args && args.text) || '');
  const needle = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const got = await getInjectableTab();
  if (got.error || !needle) return topWait();
  const tabId = got.tab.id;
  const t0 = Date.now();
  const deadline = t0 + ((args && args.timeoutMs) || 5000);
  let settled = false;
  const top = Promise.resolve(topWait()).then((r) => { settled = true; return r; });
  const pause = (ms) => Promise.race([top, sleep(Math.min(ms, deadline - Date.now()))]);

  const searched = new Map();     // frameId → url
  const failed = new Map();       // frameId → url
  let pass = [], cursor = 0, backoff = walk.firstMs, tree = new Map();
  await pause(walk.firstMs);
  while (!settled && Date.now() < deadline) {
    if (cursor >= pass.length) {
      // a new pass: the frame tree as it is now, from the top document down
      tree = await frameTree(tabId);
      const topKids = tree.size ? (await probeFrames(tabId, [0], null, walk.maxKids)).get(0) : null;
      pass = topKids ? matchChildFrames(tree.get(0), topKids.kids).map((k) => ({ ...k, depth: 1 })) : [];
      cursor = 0;
      if (!pass.length) { await pause(backoff); backoff = Math.min(backoff * 2, walk.maxMs); continue; }
    }
    if (settled) break;
    const batch = pass.slice(cursor, cursor + walk.perTick);
    cursor += batch.length;
    const res = await probeFrames(tabId, batch.map((f) => f.id), needle, walk.maxKids);
    if (settled) break;
    for (const f of batch) {
      const r = res.get(f.id);
      if (!r) { failed.set(f.id, f.url); continue; }
      searched.set(f.id, r.url);
      failed.delete(f.id);
      if (r.found) {
        if (cancelTop) { try { await cancelTop(); } catch {} }
        return {
          found: { text, frame: r.url }, inFrame: true, waitedMs: Date.now() - t0,
          note: `"${text}" is inside a cross-origin frame (${r.url}); its elements are in fast_snapshot's \`frames\` and fast_click / fast_fill / fast_select_option act on them (by text, by id "f<frameId>:<i>", or with frame:"<part of the frame URL>")`,
        };
      }
      if (f.depth < walk.depth) for (const k of matchChildFrames(tree.get(f.id), r.kids)) pass.push({ ...k, depth: f.depth + 1 });
    }
    if (cursor >= pass.length) { await pause(backoff); backoff = Math.min(backoff * 2, walk.maxMs); }
    else await pause(walk.gapMs);
  }
  // The wait answers at its timeoutMs whatever the page does: page.js checks its
  // deadline only between polls, and one poll on a heavy page (a 1,000-frame
  // test page) ran ~1s, so a 10000ms wait returned at 11.3s. Past the grace the
  // page's wait is cancelled and the timeout is answered from here.
  let r = await Promise.race([top, sleep(deadline + WAIT_GRACE_MS - Date.now()).then(() => null)]);
  if (r === null && !settled) {
    if (cancelTop) { try { await cancelTop(); } catch {} }
    r = { error: `Timed out waiting for "${text}"`, pageBusy: true, hint: 'the page was too busy to finish its own search in time — the text was not seen; read the page (fast_snapshot / fast_screenshot) before waiting again' };
  } else if (r === null) r = await top;
  if (!r || r.found || !r.error) return r;
  const answered = new Set([...searched.values()].map(originOf));
  const notReached = pass.slice(cursor).map((f) => f.url);
  const unsearched = [...new Set([...failed.values(), ...notReached].map(originOf))].filter((o) => o && !answered.has(o));
  if (!answered.size && !unsearched.length) return r;
  return {
    ...r,
    frames: { searched: [...answered], unsearched },
    ...(unsearched.length ? { framesHint: `not found in the top document or any searched frame; frames from ${unsearched.join(', ')} could not be searched, so the text may be there — their content is visible in fast_screenshot, but DOM tools cannot target it` } : {}),
  };
}

// ── DOM tools inside cross-origin frames ─────────────────────────────────────
// The top document cannot see into a cross-origin frame; the extension can. So
// the REAL page.js (the same MAIN-world script the manifest runs in the top
// document) is run inside each visible cross-origin frame, and what it returns
// is translated into top-page space: every {x, y} gains the frame's content-box
// origin, every snapshot id `i` becomes "f<frameId>:<i>". One core for every
// tool; `ctx.run(frameId, action, args)` is index.js's page.js bridge
// (frameId 0 = the top document).
//
// Which frames: those page.js's own scan reports (fast_frames: on screen,
// >=100x50, not hidden, cross-origin — the frames the frame notice names),
// mapped to extension frame ids through webNavigation (only asked when such a
// frame exists), nested to REACH.depth, at most REACH.maxFrames.
export const REACH = { maxFrames: 4, depth: 2, dryMs: 1500, snapMs: 2500 };

const withTimeout = (p, ms) => Promise.race([Promise.resolve(p).catch(() => null), sleep(ms).then(() => null)]);
const claimChild = (free, src) => {
  let i = free.findIndex((c) => c.url === src);
  if (i < 0) i = free.findIndex((c) => originOf(c.url) && originOf(c.url) === originOf(src));
  return i >= 0 ? free.splice(i, 1)[0] : null;
};

// [{ frameId, origin, url, src, box:{x,y,w,h}, ox, oy }] in top-page space, plus
// `unmapped`: frames page.js saw that no extension frame id answers for.
export async function frameTargets(ctx, { topScan } = {}) {
  const targets = [], unmapped = [];
  let tree = null;
  let level = [{ frameId: 0, ox: 0, oy: 0, scan: topScan }];
  for (let d = 0; d < REACH.depth && level.length && targets.length < REACH.maxFrames; d++) {
    const next = [];
    for (const p of level) {
      const scan = p.scan || await withTimeout(ctx.run(p.frameId, 'fast_frames', {}), REACH.dryMs);
      const seen = scan && Array.isArray(scan.frames) ? scan.frames : [];
      if (!seen.length) continue;
      if (!tree) tree = await frameTree(ctx.tabId);
      const free = [...(tree.get(p.frameId) || [])];
      for (const f of seen) {
        if (targets.length >= REACH.maxFrames) break;
        const child = claimChild(free, f.src);
        if (!child) { unmapped.push({ parent: p.frameId, src: f.src }); continue; }
        const t = {
          frameId: child.id, origin: f.origin, url: child.url, src: f.src, parent: p.frameId,
          box: { x: Math.round(f.x + p.ox), y: Math.round(f.y + p.oy), w: f.w, h: f.h },
          ox: p.ox + f.cx, oy: p.oy + f.cy,
        };
        targets.push(t);
        next.push({ frameId: t.frameId, ox: t.ox, oy: t.oy });
      }
    }
    level = next;
  }
  return { targets, unmapped };
}

// A frame's result in top-page space: x/y shifted, snapshot ids namespaced. Pure.
export function toTopSpace(result, t) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x);
    if (typeof o.x === 'number' && typeof o.y === 'number') { o.x = Math.round(o.x + t.ox); o.y = Math.round(o.y + t.oy); }
    if (typeof o.i === 'number') o.i = `f${t.frameId}:${o.i}`;
    return o;
  };
  return walk(result);
}
const frameTag = (t) => ({ frame: t.origin, url: t.url, frameId: t.frameId });
const inFrame = (t, r) => {
  if (!r || typeof r !== 'object') return r;
  const { frameNotice, opaqueFrames, ...rest } = r;
  return { inFrame: frameTag(t), ...toTopSpace(rest, t) };
};

// fast_snapshot: the top document's snapshot, plus `frames:[{frame, url,
// frameId, box, …that frame's snapshot in top-page space}]` for each visible
// cross-origin frame read within REACH.snapMs. The frame notice then names only
// the frames that could not be read. `args.frame` (URL substring) reads just that frame.
export async function snapshotWithFrames(ctx, args) {
  if (args && args.frame) return inNamedFrame(ctx, 'fast_snapshot', args);
  const top = await ctx.run(0, 'fast_snapshot', args);
  if (!top || top.error || !top.frameNotice) return top;
  const { targets } = await frameTargets(ctx);
  if (!targets.length) return top;
  const t0 = Date.now();
  const snaps = await Promise.all(targets.map((t) => withTimeout(ctx.run(t.frameId, 'fast_snapshot', { ...args, noFrameNotice: true }), REACH.snapMs - (Date.now() - t0))));
  const frames = [];
  const readTop = new Set();
  targets.forEach((t, k) => {
    const s = snaps[k];
    if (!s || s.error) return;
    const { frameNotice, opaqueFrames, ...rest } = s;
    frames.push({ frame: t.origin, url: t.url, frameId: t.frameId, box: t.box, ...toTopSpace(rest, t) });
    if (t.parent === 0) readTop.add(t.src);
  });
  if (!frames.length) return top;
  const { frameNotice, opaqueFrames, ...rest } = top;
  const unreadSrcs = [];
  const scan = await withTimeout(ctx.run(0, 'fast_frames', {}), REACH.dryMs);
  for (const f of (scan && scan.frames) || []) if (!readTop.has(f.src)) unreadSrcs.push(f.src);
  let notice = {};
  if (unreadSrcs.length) {
    const n = await withTimeout(ctx.run(0, 'fast_frames', { unread: unreadSrcs }), REACH.dryMs);
    if (n && n.frameNotice) notice = { frameNotice: n.frameNotice, opaqueFrames: n.opaqueFrames };
  }
  const framesNote = `${frames.length} cross-origin frame(s) read into \`frames\` (${[...new Set(frames.map((f) => f.frame))].join(', ')}): their items carry top-page x,y and ids "f<frameId>:<i>"; fast_click / fast_fill / fast_select_option act inside them (by text, id, or frame:"<part of the frame URL>")`;
  // frames lead the top document's own items: on a framed app the top is chrome only
  const { url, title, ...others } = rest;
  return { framesNote, ...notice, url, title, frames, ...others };
}

// Run `action` in the one visible cross-origin frame whose URL contains args.frame.
export async function inNamedFrame(ctx, action, args) {
  const want = String(args.frame);
  const { targets } = await frameTargets(ctx);
  const hits = targets.filter((t) => t.url.includes(want) || t.origin.includes(want));
  if (hits.length !== 1) {
    return {
      error: hits.length ? `${hits.length} visible cross-origin frames match frame:${JSON.stringify(want)} — nothing was done` : `no visible cross-origin frame URL contains ${JSON.stringify(want)} — nothing was done`,
      frames: (hits.length ? hits : targets).map((t) => ({ ...frameTag(t), box: t.box })),
      hint: hits.length ? 'pass a longer part of the frame URL (see frames)' : (targets.length ? 'use one of these frame URLs' : 'the page shows no readable cross-origin frame; drop frame'),
    };
  }
  const { frame, ...rest } = args;
  return inFrame(hits[0], await ctx.run(hits[0].frameId, action, { ...rest, noFrameNotice: true, idPrefix: `f${hits[0].frameId}:` }));
}

// fast_click / fast_fill / fast_select_option, frame-aware. With no visible
// cross-origin frame this is exactly the top-document call. With some, the top
// document and every frame are asked IN PARALLEL whether they hold the target
// (dryRun: one look, no auto-wait, nothing done), so a target that lives in a
// frame never pays the top document's auto-wait:
//   top has it, no frame does   → the normal top call
//   no document has it          → the normal top call (it auto-waits; the page may still be mounting)
//   exactly one frame, not top  → acted inside that frame, result in top-page space + inFrame
//   several documents have it   → refused, candidates from each; pass frame:"…" or an id
// {fields} / {selections} are planned per field the same way, and the results merged.
const MULTI = { fast_fill: 'fields', fast_select_option: 'selections' };
export async function actWithFrames(ctx, action, args = {}) {
  const idm = typeof args.id === 'string' && /^f(\d+):(\d+)$/.exec(args.id);
  if (idm) {
    const { targets } = await frameTargets(ctx);
    const t = targets.find((x) => x.frameId === Number(idm[1]));
    if (!t) return { error: `id ${args.id} points into frame ${idm[1]}, which is no longer a visible cross-origin frame — nothing was done; take a fresh fast_snapshot`, idStale: true };
    return inFrame(t, await ctx.run(t.frameId, action, { ...args, id: Number(idm[2]), noFrameNotice: true, idPrefix: `f${t.frameId}:` }));
  }
  if (args.frame) return inNamedFrame(ctx, action, args);
  if (args.id != null && args.id !== '') return ctx.run(0, action, args);   // a top-document id
  const topScan = await withTimeout(ctx.run(0, 'fast_frames', {}), REACH.dryMs);
  if (!topScan || !Array.isArray(topScan.frames) || !topScan.frames.length) return ctx.run(0, action, args);
  const { targets } = await frameTargets(ctx, { topScan });
  // a miss in the top document names the visible frames that could NOT be read
  // (the ones read were searched and did not hold the target either)
  const topCall = async (readSrcs) => {
    const r = await ctx.run(0, action, args);
    const missed = r && typeof r === 'object' && (r.error || (typeof r.missed === 'number' && r.missed > 0) || (typeof r.failed === 'number' && r.failed > 0));
    if (!missed || r.frameNotice) return r;
    const unread = topScan.frames.map((f) => f.src).filter((src) => !readSrcs.has(src));
    if (!unread.length) return r;
    const n = await withTimeout(ctx.run(0, 'fast_frames', { unread }), REACH.dryMs);
    return n && n.frameNotice ? { frameNotice: n.frameNotice, opaqueFrames: n.opaqueFrames, ...r } : r;
  };
  if (!targets.length) return topCall(new Set());
  const noTarget = action === 'fast_click' && !(args.text != null && String(args.text).trim() !== '');
  if (noTarget) {
    // no text and no id while frames are on screen: an index could mean an item of
    // the top document or of any frame — say exactly what to pass
    if (typeof args.index !== 'number') return ctx.run(0, action, args);   // page.js names the two forms
    const n = args.index;
    return {
      error: `index:${n} with no text is ambiguous on this page — nothing was clicked; pass id:"${n}" for snapshot item ${n} of the top document, ${targets.map((t) => `id:"f${t.frameId}:${n}" for item ${n} in ${t.origin}`).join(', ')}, or text:"<label>"`,
      code: 'no_target',
      frames: targets.map((t) => ({ ...frameTag(t), box: t.box })),
    };
  }

  const multiKey = MULTI[action];
  let entries = null;   // [[key, spec]] for the per-field forms
  if (multiKey === 'fields' && args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)) entries = Object.entries(args.fields);
  if (multiKey === 'selections' && args.selections && typeof args.selections === 'object' && !Array.isArray(args.selections)) {
    entries = Object.entries(args.selections);
    if (args.field != null && args.option != null && !(String(args.field) in args.selections)) entries.push([String(args.field), { option: args.option, index: args.index, section: args.section ?? args.near }]);
  }
  const keyOf = () => (action === 'fast_click' ? null : String(action === 'fast_fill' ? args.match : args.field));
  const dry = await Promise.all([0, ...targets.map((t) => t.frameId)].map((id) => withTimeout(ctx.run(id, action, { ...args, dryRun: true, noFrameNotice: true }), REACH.dryMs)));
  const readSrcs = new Set(targets.filter((t, k) => t.parent === 0 && dry[k + 1] && !dry[k + 1].error).map((t) => t.src));
  const statusIn = (d, key) => {
    if (!d || d.error) return 'missing';
    if (action === 'fast_click') return d.found ? 'found' : 'missing';
    return (d.fields && d.fields[key]) || 'missing';
  };
  const where = (key) => {
    const top = statusIn(dry[0], key);
    const hits = targets.map((t, k) => ({ t, s: statusIn(dry[k + 1], key), d: dry[k + 1] })).filter((h) => h.s !== 'missing');
    if (!hits.length) return { in: 'top' };
    if (top === 'missing' && hits.length === 1) return { in: hits[0].t };
    const label = key == null ? JSON.stringify(args.text ?? args.id) : JSON.stringify(key);
    return {
      refuse: {
        error: `${label} matches in ${top === 'missing' ? '' : 'the top document and in '}${hits.length} cross-origin frame(s) — nothing was done`,
        candidates: [
          ...(top === 'missing' ? [] : [{ frame: 'top', ...(dry[0] && dry[0].best ? dry[0].best : {}) }]),
          ...hits.map((h) => ({ ...frameTag(h.t), box: h.t.box, ...(h.d && h.d.best ? toTopSpace(h.d.best, h.t) : {}) })),
        ],
        hint: 'pass frame:"<part of the frame URL>" to act inside one frame, or the item id from fast_snapshot',
      },
    };
  };

  if (!entries) {
    const w = where(keyOf());
    if (w.refuse) return w.refuse;
    if (w.in === 'top') return topCall(readSrcs);
    return inFrame(w.in, await ctx.run(w.in.frameId, action, { ...args, noFrameNotice: true, idPrefix: `f${w.in.frameId}:` }));
  }

  // per field: group by document, run each group, merge in the caller's order
  const groups = new Map();   // 'top' | frameId → { t, keys }
  const refused = new Map();
  for (const [key] of entries) {
    const w = where(key);
    if (w.refuse) { refused.set(key, w.refuse); continue; }
    const gk = w.in === 'top' ? 'top' : w.in.frameId;
    if (!groups.has(gk)) groups.set(gk, { t: w.in === 'top' ? null : w.in, keys: [] });
    groups.get(gk).keys.push(key);
  }
  if (!refused.size && groups.size === 1 && groups.has('top')) return topCall(readSrcs);
  const specOf = new Map(entries);
  const parts = [];
  for (const [gk, g] of groups) {
    const sub = { ...args, [multiKey]: Object.fromEntries(g.keys.map((k) => [k, specOf.get(k)])), noFrameNotice: gk !== 'top', ...(gk !== 'top' ? { idPrefix: `f${gk}:` } : {}) };
    if (multiKey === 'selections') { delete sub.field; delete sub.option; }
    const r = await ctx.run(gk === 'top' ? 0 : gk, action, sub);
    parts.push({ g, r: g.t ? inFrame(g.t, r) : r });
  }
  return mergeParts(action, entries.map(([k]) => k), parts, refused);
}

// One result for a per-field call that ran in several documents. The head is the
// AND / sum of the parts' own heads (each part rolled up its own fields); a
// refused field counts as missed/failed. Pure.
export function mergeParts(action, keys, parts, refused) {
  const bag = action === 'fast_fill' ? 'fields' : 'results';
  const byKey = {};
  for (const { g, r } of parts) {
    const own = (r && r[bag]) || {};
    for (const k of g.keys) {
      const v = own[k] || (r && r.error ? { error: r.error } : { error: 'not done' });
      byKey[k] = g.t ? { ...v, frame: g.t.origin } : v;
    }
  }
  for (const [k, ref] of refused) byKey[k] = ref;
  const out = {};
  const heads = parts.map((p) => p.r || {});
  const n = (v) => (typeof v === 'number' ? v : 0);
  const partOk = (h) => !h.error && h.verified === true;
  out.verified = !refused.size && heads.every(partOk);
  if (action === 'fast_fill') {
    out.filled = heads.reduce((a, h) => a + n(h.filled), 0);
    out.missed = heads.reduce((a, h) => a + n(h.missed), 0) + refused.size;
  } else {
    out.picked = heads.reduce((a, h) => a + n(h.picked), 0);
    out.failed = heads.reduce((a, h) => a + n(h.failed), 0) + refused.size;
  }
  out.total = keys.length;
  const summaries = heads.map((h) => h.summary || (h.error && !h[bag] ? h.error : null)).filter(Boolean);
  if (refused.size) summaries.push(`refused (matches in several documents): ${[...refused.keys()].join(', ')}`);
  if (summaries.length) out.summary = summaries.join(' | ');
  for (const k of ['uncommitted', 'reverted']) { const all = heads.flatMap((h) => h[k] || []); if (all.length) out[k] = all; }
  const hints = heads.map((h) => h.hint).filter(Boolean);
  if (hints.length) out.hint = hints.join(' | ');
  out[bag] = Object.fromEntries(keys.map((k) => [k, byKey[k]]));
  const snapPart = parts.find((p) => p.r && p.r.snapshot);
  if (snapPart) out.snapshot = snapPart.r.snapshot;
  return out;
}

// Card numbers never leave the extension whole: a 13-19 digit run (spaces or
// dashes allowed) that passes the Luhn check is masked to its last 4 digits, in
// every string of every result (values, read-backs, reasons). Pure.
const CARD_RE = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;
const luhn = (digits) => {
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
};
export function maskCardNumbers(v, depth = 0) {
  if (typeof v === 'string') {
    return v.replace(CARD_RE, (m) => {
      const digits = m.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? `•••• ${digits.slice(-4)}` : m;
    });
  }
  if (!v || typeof v !== 'object' || depth > 40) return v;
  if (Array.isArray(v)) return v.map((x) => maskCardNumbers(x, depth + 1));
  if (typeof v.dataUrl === 'string') {   // an image payload: only its metadata is text
    const { dataUrl, ...rest } = v;
    return { dataUrl, ...maskCardNumbers(rest, depth + 1) };
  }
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = maskCardNumbers(x, depth + 1);
  return o;
}
