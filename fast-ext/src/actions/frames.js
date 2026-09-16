// Frame reach: the ONE way FastLink looks inside every frame of a tab,
// cross-origin iframes included.
//
// The extension holds <all_urls>, so chrome.scripting.executeScript with
// allFrames:true runs in every http(s) frame and returns each frame's result
// with its frameId. The page's same-origin policy stops the TOP document from
// reaching into a cross-origin iframe; it does not stop the extension. No
// webNavigation permission is needed: each injected function reads its own
// location.href, so frames are matched by URL from inside themselves.
//
// Reach is deliberately narrow. Only the fixed functions in this codebase are
// injected (the focus probe in input.js, the field reader and the text probe
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

// ── Text wait across frames ──────────────────────────────────────────────────
// Runs in every frame. The top frame reports only the iframes it holds (its own
// text is page.js's fast_wait, which keeps doing that job). A sub-frame reports
// whether its rendered-document text contains `needle` (lowercased, whitespace
// collapsed; script/style/template/noscript text does not count).
function textInFrame(needle) {
  const url = location.href;
  const iframes = [...document.querySelectorAll('iframe,frame')].map((f) => {
    try { return new URL(f.getAttribute('src') || '', location.href).href; } catch { return ''; }
  }).filter((u) => /^https?:/.test(u));
  if (window === window.top) return { url, top: true, iframes };
  let text = '';
  if (document.body) {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = tw.nextNode(); t; t = tw.nextNode()) {
      const p = t.parentElement;
      if (p && p.closest('script,style,template,noscript,[hidden]')) continue;
      text += t.nodeValue;
    }
  }
  return { url, top: false, iframes, found: text.replace(/\s+/g, ' ').toLowerCase().includes(needle) };
}

const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };

// fast_wait {text} that can see inside frames. `topWait` is page.js's own
// top-frame wait (a promise-returning function); it runs untouched, so slow
// content in the top document resolves exactly as before. Meanwhile every
// sub-frame is polled: text rendered inside one resolves the wait at once
// (inFrame:true + the frame URL) instead of burning the whole timeout. If the
// top wait times out, its result gains `frames: {searched, unsearched}` —
// the origins that were searched, and those of iframes that could not be.
export async function waitTextAnyFrame(args, topWait, { pollMs = 250 } = {}) {
  const text = String((args && args.text) || '');
  const needle = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const got = await getInjectableTab();
  if (got.error || !needle) return topWait();
  const t0 = Date.now();
  const deadline = t0 + ((args && args.timeoutMs) || 5000);
  let settled = null;
  const top = Promise.resolve(topWait()).then((r) => { settled = { r }; return r; });
  let last = null;
  while (!settled) {
    try { last = (await inAllFrames(got.tab.id, textInFrame, [needle])).map((a) => a.result); } catch {}
    if (settled) break;
    const hit = last && last.find((a) => !a.top && a.found);
    if (hit) {
      return {
        found: { text, frame: hit.url }, inFrame: true, waitedMs: Date.now() - t0,
        note: `"${text}" is inside a sub-frame (${hit.url}); fast_click/fast_fill act on the top document only — act on it with fast_click_xy + fast_type`,
      };
    }
    if (Date.now() >= deadline) break;
    await Promise.race([top, new Promise((r) => setTimeout(r, pollMs))]);
  }
  const r = await top;
  if (!r || r.found || !r.error || !last) return r;
  const answered = new Set(last.filter((a) => !a.top).map((a) => originOf(a.url)));
  const unsearched = [...new Set(last.flatMap((a) => a.iframes).map(originOf))].filter((o) => o && !answered.has(o));
  if (!answered.size && !unsearched.length) return r;
  return {
    ...r,
    frames: { searched: [...answered], unsearched },
    ...(unsearched.length ? { framesHint: `not found in the top document or any searchable frame; frames from ${unsearched.join(', ')} could not be searched, so the text may be there` } : {}),
  };
}
