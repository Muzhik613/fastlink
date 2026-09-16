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
  const origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };
  const out = [];
  for (const src of srcs || []) {
    let i = free.findIndex((c) => c.url === src);
    if (i < 0) i = free.findIndex((c) => origin(c.url) && origin(c.url) === origin(src));
    if (i >= 0) out.push(free.splice(i, 1)[0]);
  }
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
          note: `"${text}" is inside a sub-frame (${r.url}); fast_click/fast_fill act on the top document only — act on it with fast_click_xy + fast_type`,
        };
      }
      if (f.depth < walk.depth) for (const k of matchChildFrames(tree.get(f.id), r.kids)) pass.push({ ...k, depth: f.depth + 1 });
    }
    if (cursor >= pass.length) { await pause(backoff); backoff = Math.min(backoff * 2, walk.maxMs); }
    else await pause(walk.gapMs);
  }
  const r = await top;
  if (!r || r.found || !r.error) return r;
  const answered = new Set([...searched.values()].map(originOf));
  const notReached = pass.slice(cursor).map((f) => f.url);
  const unsearched = [...new Set([...failed.values(), ...notReached].map(originOf))].filter((o) => o && !answered.has(o));
  if (!answered.size && !unsearched.length) return r;
  return {
    ...r,
    frames: { searched: [...answered], unsearched },
    ...(unsearched.length ? { framesHint: `not found in the top document or any searched frame; frames from ${unsearched.join(', ')} could not be searched, so the text may be there` } : {}),
  };
}
