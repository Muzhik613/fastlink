import { getInjectableTab } from '../util.js';

const CDP_VERSION = '1.3';

// Persistent CDP attachment. PREVIOUSLY every trusted action attached the
// debugger and detached in finally — which made the yellow "FastLink is
// debugging this browser" banner APPEAR during a click and DISAPPEAR after.
// That banner shifts the page viewport down ~35px, so a coordinate computed
// from a screenshot (banner absent) lands ~35px too high when the click attaches
// (banner present). Keeping the debugger attached across calls means the banner
// state never changes between screenshot and click → coordinates stay accurate.
// We attach once per tab and leave it; it auto-cleans on tab close / detach.
const attached = new Set(); // tabIds we currently hold a debugger session on

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, CDP_VERSION);
  attached.add(tabId);
}

// Drop our bookkeeping if Chrome detaches us (tab closed, devtools opened, etc.)
try {
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId != null) attached.delete(source.tabId);
  });
} catch {}

// `debugger` MUST stay a REQUIRED manifest permission (MV3 rejects it as
// optional), so "Advanced control" is now a SOFT runtime toggle: the
// chrome.storage.local `advancedControl` flag (default ON when unset — the
// permission is granted, so the capability is available unless the user
// explicitly turns it off in the popup/options). Every CDP path — coordinate
// input (click_xy/type/key/wheel/drag_xy), fast_evaluate, and background-tab /
// GPU-fallback capture — funnels through cdp(), so this single guard makes the
// whole debugger surface degrade gracefully when the flag is OFF: a clear,
// actionable error instead of acting. DOM actions (snapshot, selector
// click/fill) use chrome.scripting and never reach here, and the capture tools'
// chrome.tabs.captureVisibleTab fallback is NOT gated (it's not CDP).
const ADVANCED_CONTROL_KEY = 'advancedControl';
async function ensureAdvancedControl() {
  let on = true; // default ON when the flag is unset
  try {
    const o = await chrome.storage.local.get(ADVANCED_CONTROL_KEY);
    if (o && o[ADVANCED_CONTROL_KEY] === false) on = false;
  } catch {}
  if (!on) {
    const e = new Error(
      'Advanced control is OFF — enable it in the FastLink popup/options to use coordinate ' +
      'clicks/typing, scripts, and background-tab capture. DOM-based clicking and form-filling work without it.'
    );
    e.code = 'advanced_control_off';
    throw e;
  }
}

// Send a CDP command on the persistent session (attach lazily, do NOT detach).
// Exported so other actions (e.g. fast_evaluate) share ONE debugger session —
// critical: a separate attach/detach per call toggles the "debugging Chrome"
// banner, which shifts the viewport ~35-50px and makes coordinate clicks miss.
export async function cdp(tabId, method, params) {
  await ensureAdvancedControl();
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

// Trusted click at a TOP-LEVEL viewport pixel via the CDP Input domain.
// Unlike injected JS .click() (isTrusted:false), this lands a real mouse event
// that LWC/React honor and that can focus an iframe input without DOM reach-in.
export async function clickXY({ x, y, button, clickCount }) {
  // Guard the coords: missing/NaN x|y would dispatch a mouse event at
  // (undefined, undefined) — CDP coerces it to (0,0) and "clicks" the top-left
  // corner, a SILENT no-op for the intended target (and it would never focus the
  // input the read-coords→click→fast_type playbook depends on). Fail loudly.
  if (typeof x !== 'number' || typeof y !== 'number' || Number.isNaN(x) || Number.isNaN(y)) {
    return { error: 'fast_click_xy: x and y must be numbers (viewport CSS pixels)' };
  }
  const got = await getInjectableTab();
  if (got.error) return got;
  const tabId = got.tab.id;
  const btn = button || 'left';
  // CDP `buttons` is a bitmask (left=1, right=2, middle=4) and must agree with
  // the named button, or right/middle clicks misfire.
  const mask = btn === 'right' ? 2 : btn === 'middle' ? 4 : 1;
  const count = Math.max(1, clickCount || 1);
  // Move the pointer there first, as a real mouse does: hover state follows it,
  // and fast_type's force check reads that hover state to confirm focus landed
  // on what was clicked.
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  // Escalating clickCount (1,2,…) is how CDP signals double/triple-click.
  for (let i = 1; i <= count; i++) {
    const base = { x, y, button: btn, clickCount: i, buttons: mask };
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  }
  const out = { clickedAt: { x, y }, button: btn, clickCount: count };
  // WHERE FOCUS LANDED. A coordinate click is how a caller focuses a field it
  // cannot name, and the fast_type that follows REFUSES when nothing editable
  // has focus — so a click that reports only its own coordinates leaves the
  // caller with no way to see the refusal coming (live: the first click on a
  // combobox right after a consent overlay closed left focus on the page's
  // main-content wrapper, and the next fast_type was refused). Same probe, same
  // vocabulary as fast_type's guard. Best-effort: a navigating click tears the
  // frame down mid-probe, and that is simply no focus report.
  try {
    const f = await probeFocus(tabId);
    out.focused = { tag: f.tag, editable: !!f.editable };
    if (f.type) out.focused.type = f.type;
    if (f.label) out.focused.label = f.label;
    if (f.frames.length) out.focused.frames = f.frames;
    if (f.editable) out.focused.value = f.value;
    if (f.underPointer === false) {
      out.hint = `focus is on ${describeFocus(f)}, which is NOT the element that was clicked — the click did not move focus, so a fast_type now would go into that other field. Click the field's own box before typing.`;
    }
    if (!f.editable) {
      out.hint = `${describeFocus(f)} holds focus, not an editable field — a fast_type now would be refused. Click the field's own box, or read its rect and click that center, before typing.`;
    }
  } catch {}
  return out;
}

// Trusted mouse-wheel scroll at a point via CDP — real wheel events that
// canvas/virtualized lists (which ignore scrollTop) actually honor.
export async function wheelScroll({ x, y, deltaX, deltaY }) {
  const got = await getInjectableTab();
  if (got.error) return got;
  await cdp(got.tab.id, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: x || 0, y: y || 0, deltaX: deltaX || 0, deltaY: deltaY || 0,
  });
  return { wheeled: { deltaX: deltaX || 0, deltaY: deltaY || 0, at: { x: x || 0, y: y || 0 } } };
}

// Runs in EVERY frame of the tab (chrome.scripting allFrames, MAIN world) and
// describes that frame's focused element. Self-contained (no closures) —
// chrome.scripting serializes it.
//
// The extension holds <all_urls>, so a CROSS-ORIGIN iframe is injectable like
// any other frame: its field can be read, verified and selected from inside
// that frame. The page's own same-origin policy stops the TOP document from
// reaching in; it does not stop the extension. What IS unreachable is a frame
// the extension may not inject into at all (another extension's page, the web
// store) — resolveFocus names that case.
//
// Each frame reports its PATH from the top (its index in each ancestor's
// window list — WindowProxy identity and indexing are allowed cross-origin),
// and a frame whose focus sits on an <iframe> reports WHICH child it is, so the
// chain top → child → … → the real field is followed exactly, with no guessing
// from document.hasFocus() (false whenever the Chrome window is in the
// background, which is the normal state while an agent drives it).
function inspectFocusInFrame() {
  const NON_TEXT = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'];
  const trim = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : (s || ''));
  const path = [];
  try {
    for (let w = window; w !== w.parent; w = w.parent) {
      const p = w.parent;
      let idx = -1;
      for (let i = 0; i < p.length; i++) if (p[i] === w) { idx = i; break; }
      path.unshift(idx);
    }
  } catch { return null; }
  let el = document.activeElement;
  // an open shadow root keeps its own focused element — follow it down
  for (let depth = 0; depth < 20 && el && el.shadowRoot && el.shadowRoot.activeElement; depth++) el = el.shadowRoot.activeElement;
  const tag = el ? (el.tagName || '').toLowerCase() : 'none';
  const host = location.host || '';
  if (tag === 'iframe' || tag === 'frame') {
    let child = -1;
    try { for (let i = 0; i < window.length; i++) if (window[i] === el.contentWindow) { child = i; break; } } catch {}
    let src = '';
    try { src = new URL(el.src || '', location.href).host; } catch {}
    return { path, host, child, tag: 'iframe', label: src || (el.getAttribute && el.getAttribute('title')) || '' };
  }
  if (!el || el === document.body || el === document.documentElement) {
    return {
      path, host, tag: el === document.documentElement ? 'html' : el ? 'body' : 'none',
      type: '', editable: false, readable: true,
      reason: 'the document itself has focus — no field is focused',
      label: '', value: '', valueLen: 0,
    };
  }
  const editable =
    (tag === 'input' && !NON_TEXT.includes((el.type || 'text').toLowerCase())) ||
    tag === 'textarea' ||
    el.isContentEditable === true;
  let label = '';
  try {
    label = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('name') ||
      el.getAttribute('placeholder') || el.id)) || '';
  } catch {}
  let value = '';
  if (tag === 'input' || tag === 'textarea') value = el.value == null ? '' : String(el.value);
  else if (el.isContentEditable) value = el.textContent || '';
  const out = {
    path, host, tag, type: el.type || '', editable, readable: editable,
    label: trim(label, 80), value: trim(value, 300), valueLen: value.length,
  };
  // Is the focused field the thing under the mouse pointer? After a coordinate
  // click it must be: the pointer is over the field itself, over a <label> for
  // it, or over a wrapper that holds no other field. When a click lands on
  // something that does not take focus (a dropdown button, a styled div), focus
  // STAYS on the previous field and this says false. Only a positive mismatch is
  // reported; anything this cannot evaluate leaves it undefined.
  if (editable) {
    try {
      if (el.matches(':hover')) out.underPointer = true;
      else {
        const hovered = document.querySelectorAll(':hover');
        const deepest = hovered[hovered.length - 1];
        const lab = deepest && deepest.closest ? deepest.closest('label') : null;
        const FIELDS = 'input:not([type=hidden]),textarea,select,[contenteditable]:not([contenteditable=false])';
        out.underPointer = !!deepest && ((lab && lab.control === el)
          || (deepest.contains(el) && deepest.querySelectorAll(FIELDS).length === 1));
      }
    } catch {}
  }
  if (!editable) out.reason = `focus is on a <${tag}>, which holds no editable value`;
  else if (el.type === 'password') { out.value = '•'.repeat(Math.min(value.length, 32)); out.readable = false; out.reason = 'password field: value not readable'; }
  return out;
}

// Follow the per-frame reports from the top frame down to the element that
// really has focus. Returns one descriptor: { tag, type, editable, readable,
// reason?, label, value, valueLen, frames, frameId, reachable? } — `frames` is
// the host of every iframe crossed on the way down, `frameId` is the frame the
// field lives in (for a follow-up injection into exactly that frame).
function resolveFocus(injections) {
  const byPath = new Map();
  for (const r of injections || []) {
    if (r && r.result && Array.isArray(r.result.path)) byPath.set(r.result.path.join('/'), { ...r.result, frameId: r.frameId });
  }
  const frames = [];
  let cur = byPath.get('');
  if (!cur) {
    return { tag: 'none', type: '', editable: false, readable: false, reachable: false, reason: 'unreadable: the page could not be inspected', label: '', value: '', valueLen: 0, frames };
  }
  for (let depth = 0; depth < 20 && cur.tag === 'iframe'; depth++) {
    frames.push(cur.label || 'iframe');
    const next = cur.child >= 0 ? byPath.get([...cur.path, cur.child].join('/')) : null;
    if (!next) {
      return {
        tag: 'iframe', type: '', editable: false, readable: false, reachable: false,
        reason: `unreadable: focus is inside a frame (${cur.label || 'iframe'}) the extension cannot inject into`,
        label: cur.label || '', value: '', valueLen: 0, frames, frameId: cur.frameId,
      };
    }
    cur = next;
  }
  const { path, child, host, ...d } = cur;
  return { ...d, frames };
}

async function probeFocus(tabId) {
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, world: 'MAIN', func: inspectFocusInFrame,
  });
  return resolveFocus(injections);
}

// How a refusal names what had focus.
function describeFocus(d) {
  if (!d || d.tag === 'none') return 'nothing';
  if (d.tag === 'body' || d.tag === 'html') return 'the document itself';
  if (d.tag === 'iframe') return `an uninspectable <iframe>${d.label ? ` (${d.label})` : ''}`;
  return `<${d.tag}>${d.label ? ` (${d.label})` : ''}`;
}

// Detect macOS so keyboard chords use the platform-correct select-all modifier:
// Cmd/Meta on macOS, Ctrl elsewhere. userAgentData.platform is the modern
// signal; navigator.platform is the legacy fallback.
function isMacPlatform() {
  try {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    return /mac/i.test(p);
  } catch { return false; }
}

// Select-all + Delete via the CDP Input domain. Uses Cmd/Meta+A on macOS and
// Ctrl+A elsewhere (the MOD_BITS map below carries meta/cmd=4), so the
// clear-before-type select-all fires the right chord on every platform. This
// is the only remaining caller of keyInfo/MOD_BITS. Clears the field so a
// follow-up insertText REPLACES instead of appending.
// ONLY ever called with an EDITABLE element focused (see typeText): Ctrl/Cmd+A
// with the DOCUMENT focused selects the whole PAGE, which is what happened on
// Azure's cross-origin portal blade — the page went blue and the name field was
// never touched, while the call reported success.
async function selectAllAndDelete(tabId) {
  const a = keyInfo('a');
  const selectAllMod = isMacPlatform() ? MOD_BITS.meta : MOD_BITS.ctrl;
  const aBase = { modifiers: selectAllMod, key: a.key, code: a.code, windowsVirtualKeyCode: a.keyCode, nativeVirtualKeyCode: a.keyCode };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...aBase });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...aBase });
  const del = keyInfo('Delete');
  const dBase = { modifiers: 0, key: del.key, code: del.code, windowsVirtualKeyCode: del.keyCode, nativeVirtualKeyCode: del.keyCode };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...dBase });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...dBase });
}

// Trusted typing into the currently-focused element via Input.insertText.
// React accepts it because it's a real input event (unlike setting .value).
//   args.text   : string to insert (required)
//   args.clear  : when true, select-all + Delete first so the value is REPLACED,
//                 not appended (default false → append at the caret).
//   args.force  : (alias allowIframe) the field was JUST focused by a coordinate
//                 click (fast_click_xy). Two consequences: (1) the focused field
//                 must be the element under the pointer, else nothing is typed —
//                 a click on something that takes no focus leaves focus on the
//                 PREVIOUS field, and typing there is how a vision fill turned
//                 "fastlink-bench-vm" into "fastlink-bench-vmany validany valid";
//                 (2) where focus sits in a frame the extension cannot inject
//                 into, it types anyway, unverified. Every other frame —
//                 cross-origin iframes included — is probed directly.
// Before inserting we verify an EDITABLE element is actually focused — a bare
// insertText goes to document.activeElement, so with nothing useful focused the
// text vanishes or lands in the wrong field (live: a URL appended into a Name
// field, "FastLink relayhttps://…").
//
// EVERY return says whether the value was READ BACK: `verified:true` with the
// live value, or `verified:false` with a machine-readable `reason` plus
// `typedInto`. A forced write into an uninspectable frame is exactly the case
// nothing can confirm, so it must never come back looking like a success.
export async function typeText({ text, clear, force, allowIframe } = {}) {
  if (typeof text !== 'string') return { error: 'fast_type: text is required (string)' };
  const got = await getInjectableTab();
  if (got.error) return got;
  const tabId = got.tab.id;
  const forced = force === true || allowIframe === true;

  let el;
  try { el = await probeFocus(tabId); } catch (e) {
    return { error: `fast_type: could not inspect focus — ${(e && e.message) || e}` };
  }
  const where = (d) => ({
    tag: d.tag, type: d.type, label: d.label, value: d.value,
    ...(d.frames.length ? { frames: d.frames } : {}),
  });
  const uninspectable = el.reachable === false;

  // Refuse when nothing editable is focused (catches the "typed into the wrong
  // field" class of bug). force only lifts this where the probe could not look.
  if (!el.editable && !(forced && uninspectable)) {
    return {
      error: `fast_type: no editable element focused — ${describeFocus(el)} has focus; click/focus the field first, nothing was typed`,
      code: 'no_editable_focus', focused: where(el),
      ...(uninspectable ? { hint: 'the focused frame cannot be inspected — if a coordinate click just focused a field inside it, fast_type {text, force:true} types there unverified' } : {}),
    };
  }

  // A coordinate-focused write must land in what was clicked (see args.force).
  if (forced && el.editable && el.underPointer === false) {
    return {
      error: `fast_type: the click did not focus its target — focus is still on ${describeFocus(el)}${el.value ? ` (holding ${JSON.stringify(el.value)})` : ''}, which is not under the pointer, so nothing was typed`,
      code: 'focus_not_on_clicked_target',
      reason: 'focus not on the clicked element: nothing typed',
      focused: where(el),
      hint: 'the clicked element does not take text focus — if it is a dropdown/combobox, open it and pick an option (fast_select_option, or click the option) instead of typing; otherwise click the text box itself',
    };
  }

  // clear:true is a SELECT-ALL, and a select-all only means "this field" when a
  // field has focus. Where focus could not be inspected, Ctrl/Cmd+A may select
  // the whole PAGE and the Delete that follows can hit anything (the Azure
  // create-VM blade turned entirely blue while the name field stayed empty,
  // back when cross-origin frames were not probed). So clear is REFUSED there.
  if (clear && !el.editable) {
    return {
      error: `fast_type: clear:true needs an editable field focused, but ${describeFocus(el)} has focus — a select-all there can select the WHOLE PAGE, not a field, so nothing was typed`,
      code: 'clear_without_editable_focus',
      focused: where(el),
      hint: 'triple-click the field first (fast_click_xy {x, y, clickCount:3}) — that selects only that field\'s own contents — then fast_type {text, force:true} with no clear',
    };
  }

  if (clear) await selectAllAndDelete(tabId);
  await cdp(tabId, 'Input.insertText', { text });

  // Read the (post-insert) focused element back, in whatever frame it lives.
  // Best-effort — fall back to the pre-insert probe.
  let after = el;
  try { after = await probeFocus(tabId); } catch {}
  const tail = { typed: text.length, cleared: !!clear, forced: forced || undefined, typedInto: where(after) };
  if (!after.readable) {
    return { verified: false, reason: after.reason || 'unreadable: value not readable', ...tail };
  }
  const live = String(after.value == null ? '' : after.value);
  const holds = clear ? live === text : live.includes(text);
  if (holds) return { verified: true, ...tail };
  if (after.valueLen > live.replace(/…$/, '').length) {
    return { verified: false, reason: `unreadable: the field holds ${after.valueLen} characters, more than the 300-character read-back window, so the value could not be confirmed`, ...tail };
  }
  return {
    verified: false,
    reason: `the field reads ${JSON.stringify(live)} after typing, not the text sent — the page reformatted, rejected or redirected it; do not report the text as entered`,
    ...tail,
  };
}

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.
const MOD_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

// Map a key name to the fields CDP's dispatchKeyEvent needs. Covers common
// named keys, letters, and digits — enough for shortcuts (Ctrl+A, Cmd+C) and
// navigation keys. Unknown multi-char names pass through as-is.
const NAMED_KEYS = {
  Enter: { keyCode: 13, code: 'Enter', key: 'Enter' },
  Tab: { keyCode: 9, code: 'Tab', key: 'Tab' },
  Escape: { keyCode: 27, code: 'Escape', key: 'Escape' },
  Backspace: { keyCode: 8, code: 'Backspace', key: 'Backspace' },
  Delete: { keyCode: 46, code: 'Delete', key: 'Delete' },
  ArrowUp: { keyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
  ArrowDown: { keyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
  ArrowRight: { keyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
  Home: { keyCode: 36, code: 'Home', key: 'Home' },
  End: { keyCode: 35, code: 'End', key: 'End' },
  PageUp: { keyCode: 33, code: 'PageUp', key: 'PageUp' },
  PageDown: { keyCode: 34, code: 'PageDown', key: 'PageDown' },
  Space: { keyCode: 32, code: 'Space', key: ' ' },
};
function keyInfo(k) {
  if (NAMED_KEYS[k]) return NAMED_KEYS[k];
  const s = String(k);
  if (s.length === 1) {
    const up = s.toUpperCase();
    const cc = up.charCodeAt(0);
    if (up >= 'A' && up <= 'Z') return { keyCode: cc, code: `Key${up}`, key: s };
    if (up >= '0' && up <= '9') return { keyCode: cc, code: `Digit${up}`, key: s };
    return { keyCode: cc, code: '', key: s };
  }
  return { keyCode: 0, code: s, key: s };
}
