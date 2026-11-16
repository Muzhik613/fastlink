// fast_upload: put files into a page's <input type=file> the way a real pick does:
// input.files = the files, then `input` and `change` events. No OS dialog, no focus, no
// CDP, so it works in a background tab and with the screen locked.
//
// Two passes over the tab's frames (ISOLATED world: the page can't fake what is read):
//   1. list  — every frame lists its file inputs (hidden ones and open shadow roots too),
//              no file data sent; the service worker picks ONE input (pickInput).
//   2. set   — only the chosen frame gets the files and sets them on that input.
// The files come in the call (the relay checked them; the Claude Code helper reads them
// from its upload folder). Nothing here reads from disk.
import { getInjectableTab } from '../util.js';

export const UPLOAD_MAX_FILES = 10;
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

// Runs in a frame (ISOLATED world). Self-contained: chrome.scripting serializes it.
//   op 'list': { url, inputs: [{n, name, id, accept, multiple, disabled, label}], nonFile? }
//   op 'set':  sets `files` on file input #n (document order, as listed) → result or {error}
export function fileInputsInFrame(op, opts) {
  const all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'file') all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const clip = (s, n = 80) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  // What a person would read as this input's name: its labels, aria, title, else the
  // text of the nearest ancestor that has some (an "Attach photo" button wrapping it).
  const labelOf = (el) => {
    const own = [...(el.labels || [])].map((l) => l.textContent).join(' ') || el.getAttribute('aria-label') || el.title || '';
    if (clip(own)) return clip(own);
    for (let p = el.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
      const t = clip(p.getAttribute('aria-label') || p.title || p.textContent);
      if (t) return t;
    }
    return '';
  };
  if (op === 'list') {
    const sel = opts && opts.selector;
    let selHits = null, nonFile = [];
    if (sel) {
      try { selHits = new Set(document.querySelectorAll(sel)); } catch (e) { return { url: location.href, badSelector: String(e && e.message || e) }; }
      nonFile = [...selHits].filter((el) => !all.includes(el)).slice(0, 3)
        .map((el) => el.tagName.toLowerCase() + (el.type ? `[type=${el.type}]` : ''));
    }
    const inputs = all.map((el, n) => ({
      n, name: el.name || '', id: el.id || '', accept: el.accept || '', multiple: !!el.multiple, disabled: !!el.disabled,
      label: labelOf(el), ...(selHits ? { sel: selHits.has(el) } : {}),
    }));
    return { url: location.href, inputs, ...(nonFile.length ? { nonFile } : {}) };
  }
  // op 'set'
  const { n, files, expect } = opts;
  const el = all[n];
  if (!el || (expect && (el.name || '') !== expect.name) || (expect && (el.id || '') !== expect.id)) {
    return { error: 'The file input changed before the files were set (the page re-rendered). Call fast_upload again.' };
  }
  if (el.disabled) return { error: 'That file input is disabled.' };
  if (files.length > 1 && !el.multiple) return { error: `That file input takes one file; ${files.length} were given. Upload them one at a time, or pick an input with multiple:true.` };
  const decode = (b64) => {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  // accept="image/*,.pdf": which files a real picker would have offered
  const acc = String(el.accept || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const fits = (f) => !acc.length || acc.some((a) => a.startsWith('.') ? f.name.toLowerCase().endsWith(a)
    : a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : f.type === a);
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(new File([decode(f.data)], f.name, { type: f.type, lastModified: Date.now() }));
  el.files = dt.files;
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const misfit = files.filter((f) => !fits(f)).map((f) => f.name);
  return {
    filesOnInput: el.files ? el.files.length : 0,
    ...(el.isConnected ? {} : { detached: true }),
    ...(misfit.length ? { acceptMismatch: `${misfit.join(', ')} not in this input's accept="${el.accept}"; the site may refuse it` } : {}),
  };
}

const describe = (c) => ({
  ref: `${c.frameId}:${c.n}`,
  ...(c.label ? { label: c.label } : {}), ...(c.name ? { name: c.name } : {}), ...(c.id ? { id: c.id } : {}),
  ...(c.accept ? { accept: c.accept } : {}), ...(c.multiple ? { multiple: true } : {}), ...(c.disabled ? { disabled: true } : {}),
  ...(c.frameId !== 0 ? { frame: c.url } : {}),
});

// Pure: the frames' lists → the one input to use, or an error listing the candidates.
// frames: [{frameId, result: {url, inputs, nonFile?, badSelector?}}]
export function pickInput(frames, { selector, match, ref, frame } = {}) {
  const inFrame = frames.filter((f) => !frame || String(f.result?.url || '').includes(frame));
  const bad = inFrame.find((f) => f.result?.badSelector);
  if (bad) return { error: `fast_upload: bad selector ${JSON.stringify(selector)}: ${bad.result.badSelector}` };
  const all = inFrame.flatMap((f) => (f.result?.inputs || []).map((i) => ({ ...i, frameId: f.frameId, url: f.result.url })));
  const listed = all.slice(0, 20).map(describe);
  if (!all.length) {
    const nonFile = inFrame.flatMap((f) => f.result?.nonFile || []);
    if (selector && nonFile.length) return { error: `fast_upload: ${JSON.stringify(selector)} is not a file input (it matches ${nonFile.join(', ')}). fast_upload only sets <input type=file>.`, code: 'not_file_input' };
    return { error: `fast_upload: no file input${frame ? ` in a frame matching "${frame}"` : ''} on this page. Many sites add it only when you open their attach/upload menu: click that first, then call fast_upload again.`, code: 'no_file_input' };
  }
  let hits = all;
  if (ref != null) {
    hits = all.filter((c) => `${c.frameId}:${c.n}` === String(ref));
    if (!hits.length) return { error: `fast_upload: no file input with ref "${ref}" now.`, inputs: listed };
  }
  if (selector) {
    hits = hits.filter((c) => c.sel);
    if (!hits.length) {
      const nonFile = inFrame.flatMap((f) => f.result?.nonFile || []);
      if (nonFile.length) return { error: `fast_upload: ${JSON.stringify(selector)} is not a file input (it matches ${nonFile.join(', ')}). fast_upload only sets <input type=file>.`, code: 'not_file_input', inputs: listed };
      return { error: `fast_upload: no file input matches ${JSON.stringify(selector)}.`, inputs: listed };
    }
  }
  if (match) {
    const m = String(match).toLowerCase();
    hits = hits.filter((c) => [c.label, c.name, c.id, c.accept].some((s) => String(s || '').toLowerCase().includes(m)));
    if (!hits.length) return { error: `fast_upload: no file input matches "${match}".`, inputs: listed };
  }
  const usable = hits.filter((c) => !c.disabled);
  if (!usable.length) return { error: 'fast_upload: the matching file input is disabled.', inputs: hits.slice(0, 20).map(describe) };
  if (usable.length > 1) {
    return { error: `fast_upload: ${usable.length} file inputs match; name one with ref (or a selector / match).`, code: 'ambiguous', inputs: usable.slice(0, 20).map(describe) };
  }
  return { pick: usable[0] };
}

export async function uploadFiles({ tabId, files, selector, match, ref, frame } = {}) {
  if (!Array.isArray(files) || !files.length) return { error: 'fast_upload needs files.' };
  if (files.length > UPLOAD_MAX_FILES) return { error: `fast_upload takes at most ${UPLOAD_MAX_FILES} files.` };
  let total = 0;
  for (const f of files) {
    if (!f || typeof f.name !== 'string' || typeof f.data !== 'string') return { error: 'fast_upload: each file needs name and data (base64).' };
    total += Math.floor(f.data.length * 3 / 4);
  }
  if (total > UPLOAD_MAX_BYTES) return { error: `fast_upload carries at most ${UPLOAD_MAX_BYTES / 1024 / 1024} MB per call.` };
  const got = await getInjectableTab(tabId);
  if (got.error) return got;
  const id = got.tab.id;
  const listed = await chrome.scripting.executeScript({
    target: { tabId: id, allFrames: true }, world: 'ISOLATED', func: fileInputsInFrame, args: ['list', { selector: selector || null }],
  });
  const frames = (listed || []).filter((r) => r && r.result).map((r) => ({ frameId: r.frameId, result: r.result }));
  const p = pickInput(frames, { selector, match, ref, frame });
  if (p.error) return p;
  const c = p.pick;
  const clean = files.map((f) => ({ name: f.name, type: typeof f.type === 'string' && f.type ? f.type : 'application/octet-stream', data: f.data }));
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId: id, frameIds: [c.frameId] }, world: 'ISOLATED', func: fileInputsInFrame,
    args: ['set', { n: c.n, files: clean, expect: { name: c.name, id: c.id } }],
  });
  const r = inj && inj.result;
  if (!r || typeof r !== 'object') return { error: 'fast_upload: no answer from the page (it may have navigated).' };
  if (r.error) return { ...r, input: describe(c) };
  return {
    uploaded: clean.map((f) => ({ name: f.name, type: f.type, size: Math.floor(f.data.length * 3 / 4) - (f.data.endsWith('==') ? 2 : f.data.endsWith('=') ? 1 : 0) })),
    input: describe(c),
    ...r,
    hint: 'The site now handles the files like a real pick (often a preview with a Send/Post button): read the page and continue.',
    tabId: id,
  };
}
