// Lives in the target tab's MAIN world as a manifest content script
// (run_at: document_start). Self-attaches to window.__fastlink.run so the
// background can invoke it via a tiny 1-line bridge instead of re-serializing
// this whole file on every executeScript call.
//
// MUST stay self-contained — no imports, no closures from outside this file.
//
// Architecture:
//   • Persistent in-page INDEX (Map<Element, Entry>) built once on first
//     page-action invocation. Initial walk is chunked via requestIdleCallback
//     so it doesn't block paint.
//   • A MutationObserver keeps the index current as the page changes. Per-
//     mutation work is tiny — one element re-classified, no full walk.
//   • fast_snapshot serializes the index. Reads getBoundingClientRect in one
//     tight loop (single layout pass per snapshot) instead of scanning the
//     entire DOM. Typically <20ms even on huge SPAs.

// ───────────────────────────── module helpers ─────────────────────────────

// `a:not([href])` = a script-driven click target (jQuery UI's datepicker Prev/Next,
// old paginators): indexed as a WEAK entry — ranked below every real control.
const SELECTOR = 'a[href],a:not([href]),button,input:not([type="hidden"]),select,textarea,[contenteditable="true"],[contenteditable=""],[role="button"],[role="link"],[role="checkbox"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="switch"],[role="option"],[role="radio"],[onclick],[tabindex]:not([tabindex="-1"])';

const SKIP_SUBTREE = new Set([
  'script','style','noscript','template','head','title','meta','link','svg',
]);

// Hard cap on index size. Interactive elements are always indexed; only NEW
// non-interactive 'content' entries are dropped once this is hit. Stops a
// churning SPA (GCP) from growing the index without bound — which is what blew
// the serialize loop and wedged the renderer.
const MAX_INDEX = 10000;

// ─── Heavy-page guards (issue #7: heavy-DOM main-thread freeze) ───
// The DOM walk and the snapshot serialize are chunked: after at most SLICE_MS
// of contiguous main-thread work we YIELD to the event loop, so even mid-index
// the page never goes "unresponsive". A node-walk CEILING bails the full walk
// on giant SPAs (50k+ nodes) so we never even attempt to serialize the world.
const SLICE_MS = 25;     // max contiguous main-thread time before yielding
const SNAP_SLICE_MS = 12; // serialize yields MORE eagerly than the index walk:
                         // each item does 3-5 layout reads (rect + computed-style +
                         // per-iframe offset), so we keep contiguous work well under
                         // one frame (16ms) and never drop input on a heavy SPA.
const MAX_WALK = 25000;  // hard ceiling on DOM nodes VISITED by the index walk
const HUGE_INDEX = 8000; // above this many entries, snapshots degrade to viewport-only
                         // (kept under MAX_INDEX 10000; normal rich pages sit far below)

// Interactive CONTROL preference (match ranking). A real control (button/input/
// radio/checkbox/option/menuitem/tab/…) should be preferred over a generic link
// or text node when text scores are close — e.g. a radio whose accessible name
// comes from a wrapping <label> vs a plain <a> that merely contains the same word.
const CONTROL_TAGS = new Set(['button', 'input', 'select', 'textarea']);
const CONTROL_ROLES = new Set([
  'button', 'radio', 'checkbox', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'switch', 'link',
]);
const CONTROL_BONUS = 1.25; // additive, crosses at most ~one scoring tier — never a hard override
const isControlItem = (it) => {
  if (!it) return false;
  if (CONTROL_TAGS.has(it.tag)) return true;
  return CONTROL_ROLES.has((it.role || '').toLowerCase());
};

const visible = (el, rect) => {
  if (rect.width < 2 || rect.height < 2) return false;
  const cs = getComputedStyle(el);
  return !(cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0');
};

// LABEL-PROXIED CONTROL: a native radio/checkbox whose input is visually hidden
// (opacity 0, clipped / 1px, display:none) while its <label> (for= or wrapping) is
// what the user sees and clicks — GOV.UK radios, Bootstrap btn-check, CSS-only
// toggles. It is a visible control: geometry = its visible label box(es), plus the
// input's own box when that sits on/next to the label (GOV.UK's 44px hit area).
// Returns a rect-like object, or null when no label is visible.
const labelProxyRect = (el) => {
  if (!el || el.tagName !== 'INPUT' || !/^(radio|checkbox)$/i.test(el.type || '')) return null;
  let labels = null; try { labels = el.labels; } catch {}
  if (!labels || !labels.length) return null;
  let b = null;
  const add = (r) => { b = b ? { l: Math.min(b.l, r.left), t: Math.min(b.t, r.top), r: Math.max(b.r, r.right), btm: Math.max(b.btm, r.bottom) } : { l: r.left, t: r.top, r: r.right, btm: r.bottom }; };
  for (const l of labels) { let r; try { r = l.getBoundingClientRect(); } catch { continue; } if (visible(l, r)) add(r); }
  if (!b) return null;
  let own = null; try { own = el.getBoundingClientRect(); } catch {}
  const near = 48;
  if (own && own.width >= 2 && own.height >= 2 && own.right >= b.l - near && own.left <= b.r + near && own.bottom >= b.t - near && own.top <= b.btm + near) add(own);
  return { x: b.l, y: b.t, left: b.l, top: b.t, right: b.r, bottom: b.btm, width: b.r - b.l, height: b.btm - b.t };
};

// Checked state of a check-type control (native radio/checkbox, or an ARIA
// radio/checkbox/switch carrying aria-checked); null for anything else.
const CHECK_ROLES = /^(radio|checkbox|switch|menuitemradio|menuitemcheckbox)$/;
const checkedOf = (el) => {
  try {
    if (el.tagName === 'INPUT' && /^(radio|checkbox)$/i.test(el.type || '')) return !!el.checked;
    const role = (el.getAttribute('role') || '').toLowerCase();
    const ac = el.getAttribute('aria-checked');
    if (CHECK_ROLES.test(role) && ac != null) return ac === 'true';
  } catch {}
  return null;
};

// A widget's typing input and its BOX: a widget's own typing input is often
// drawn invisible inside the widget's visible box (react-select's 1px opacity-0
// "dummy input", Tom Select's opacity-0 combobox input). For such an input the
// field's box is the nearest ancestor with a real box that holds no OTHER form
// control — the widget itself, never the surrounding form. null when none.
const WIDGET_INPUT_SEL = 'input[role="combobox"],input[id^="react-select-"]';
// The box returned is the INNERMOST ancestor that actually SHOWS something:
// Element Plus and Ant Design wrap the combobox input in a text-less ~10px
// sleeve and draw the chosen label in a SIBLING span, so the first sized
// ancestor read back as "" and a committed pick reported verified:false. The
// climb still stops the moment an ancestor holds ANOTHER form control (that is
// the surrounding form, not the widget); with no text anywhere in the widget
// (an empty dropdown) the innermost box is still the answer.
const hiddenInputBox = (el) => {
  if (!(el && el.matches && el.matches(WIDGET_INPUT_SEL))) return null;
  let innermost = null;
  let p = el.parentElement;
  for (let hops = 0; p && hops < 6; hops++, p = p.parentElement) {
    let r; try { r = p.getBoundingClientRect(); } catch { break; }
    if (r.width < 2 || r.height < 2) continue;
    let others = 0;
    try { for (const c of p.querySelectorAll('input:not([type="hidden"]),select,textarea')) if (c !== el) others++; } catch {}
    if (others) break;                  // past the widget: this is another field's box
    // A widget HIDES its typing sleeve once it displays a value (Element Plus makes
    // the input wrapper invisible and draws the chosen label in a sibling span) —
    // that is part of the widget, not the end of it. Skip it and keep climbing to
    // the box that actually shows; stopping here read the pick back as "".
    if (!visible(p, r)) continue;
    if (!innermost) innermost = p;
    let shows = '';
    try { shows = cleanLabel(p.innerText || p.textContent || ''); } catch {}
    if (shows) return p;
  }
  return innermost;
};

// What a control SHOWS: native select → the selected option's text; a visible
// input → its value; an invisible widget input → its widget box; any other
// widget → its visible text, minus buttons inside it ("Remove item", clear ×),
// hidden descendants (a backing <select>'s option list), popup containers that
// carry their own aria-expanded (an open dropdown inside the widget) and icon
// glyphs. Bounded walk. This is the read-back `verified` compares against.
const shownValueOf = (el) => {
  try {
    if (!el || el.nodeType !== 1) return '';
    if (el.tagName === 'SELECT') { const o = el.selectedOptions ? el.selectedOptions[0] : el.options[el.selectedIndex]; return o ? cleanLabel(o.text || o.value || '') : ''; }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      // A widget's typing input (invisible, or visible but empty after a pick —
      // Tom Select draws the chosen item BESIDE its search input) shows nothing
      // itself: its widget box does.
      let r; try { r = el.getBoundingClientRect(); } catch {}
      const box = r && (!visible(el, r) || !el.value) ? hiddenInputBox(el) : null;
      if (!box) return String(el.value || '');
      el = box;
    }
    const parts = []; let n = 0;
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (++n > 600) return;
        if (c.nodeType === 3) { if (c.data.trim()) parts.push(c.data); continue; }
        if (c.nodeType !== 1) continue;
        const tag = c.tagName;
        // A <label> inside the widget is the field's NAME, never its value (EJ2's
        // float label sits in the same wrapper as the readonly input that shows
        // the pick — the read-back returned "From" for a committed "Chicago").
        if (/^(SELECT|OPTION|SCRIPT|STYLE|TEMPLATE|BUTTON|SVG|LABEL)$/i.test(tag) || c.getAttribute('role') === 'button') continue;
        // Skip an OPEN popup inside the widget — its option list is not the value.
        // Only aria-expanded="TRUE": every modern listbox keeps aria-expanded="false"
        // on the very element that DISPLAYS the pick (EJ2's readonly input, Element
        // Plus / Ant Design's role=combobox input), so skipping any element that
        // merely CARRIES the attribute read a committed widget as empty — that was
        // the false verified:false on four custom dropdowns.
        if (c.getAttribute('aria-hidden') === 'true' || c.getAttribute('aria-expanded') === 'true') continue;
        if (typeof c.checkVisibility === 'function' && !c.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
        if (tag === 'INPUT') { if (c.value && !/^(hidden|checkbox|radio)$/i.test(c.type || '')) parts.push(c.value); continue; }
        walk(c);
      }
    };
    walk(el);
    return cleanLabel(parts.join(' ').replace(/[​-]/g, '')).slice(0, 200);
  } catch { return ''; }
};
// Does a control's shown text SHOW `want`? Equal, or `want` as whole words in it
// ("Female" must not pass for "Male"; multi-value chips "A, B" contain "B").
const showsValue = (shown, want) => {
  const s = cleanLabel(shown).toLowerCase(), w = cleanLabel(want).toLowerCase();
  if (!s || !w) return false;
  if (s === w) return true;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}\\p{N}])`, 'u').test(s);
};

// A text-bearing non-control the page made clickable by script: computed
// cursor:pointer, not inside an indexed control (a <span> in a <button> inherits
// the button's pointer — that one is the button's). The days of a calendar drawn
// as <td>/<span>, a "Next" <div>. Listed and matchable as a WEAK click target.
// An ancestor whose text genuinely BELONGS to it: a real control. A container
// that is merely focusable (`[tabindex]` on a tree/list host) or carries an
// onclick is NOT one — the rows drawn inside it keep their own text. The old
// rule tested SELECTOR, whose `[tabindex]:not([tabindex="-1"])` arm made one
// focusable host swallow every row in it (a 100k-node tree is a single
// tabindex=0 div; nothing inside it was ever a click candidate).
const CONTROL_ANCESTOR_SEL = 'a[href],button,input:not([type="hidden"]),select,textarea,label,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="combobox"],[role="textbox"],[role="searchbox"]';
const pointerContent = (el) => {
  try {
    if (getComputedStyle(el).cursor !== 'pointer') return false;
    const lbl = el.closest('label');
    if (lbl && lbl.control) return false;   // a label's text belongs to its control (listed as the control)
    return !(el.parentElement && el.parentElement.closest(CONTROL_ANCESTOR_SEL));
  } catch { return false; }
};

const lookupId = (el, id) => {
  let r = el.getRootNode && el.getRootNode();
  while (r) {
    if (r.getElementById) {
      const f = r.getElementById(id);
      if (f) return f;
    }
    r = r.host ? r.host.getRootNode() : null;
  }
  return document.getElementById(id);
};

const resolveIdRefs = (el, attr) => {
  const v = el.getAttribute && el.getAttribute(attr);
  if (!v) return null;
  const parts = [];
  for (const id of v.split(/\s+/).filter(Boolean)) {
    const ref = lookupId(el, id);
    if (ref) parts.push((ref.textContent || '').trim());
  }
  const joined = parts.filter(Boolean).join(' ').trim();
  return joined || null;
};

const implicitRoleOf = (tag, type) => {
  if (tag === 'a')        return 'link';
  if (tag === 'button')   return 'button';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select')   return 'combobox';
  if (tag === 'option')   return 'option';
  if (tag === 'input') {
    const t = (type || 'text').toLowerCase();
    if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio')    return 'radio';
    if (t === 'search')   return 'searchbox';
    return 'textbox';
  }
  return null;
};

// Collapse internal runs of whitespace (newlines/indentation between a wrapping
// <label>'s text and its control) to single spaces so the label string is a
// clean, matchable phrase — e.g. "Delivery instructions:\n  " → "Delivery
// instructions:". Without this, source-formatted labels carry stray whitespace
// that breaks exact/substring matching downstream.
const cleanLabel = (s) => (s || '').replace(/\s+/g, ' ').trim();
// `forLookup(el)` (optional): a caller that resolves MANY elements passes a
// precomputed <label for> map instead — two document-wide querySelector calls
// per element made a lookup over thousands of candidates take seconds.
const labelFor = (el, forLookup) => {
  // 1) Explicit association: <label for="id">. Works across the element's own
  //    root (shadow DOM) and the main document.
  if (el.id) {
    if (forLookup) { const t = forLookup(el); if (t != null) return t; }
    else {
      const escId = CSS.escape(el.id);
      const root = el.getRootNode && el.getRootNode();
      const lbl = (root && root.querySelector && root.querySelector(`label[for="${escId}"]`))
                || document.querySelector(`label[for="${escId}"]`);
      if (lbl) return cleanLabel(lbl.textContent);
    }
  }
  // 2) Implicit association: a wrapping <label> ancestor (the control sits
  //    INSIDE the label, e.g. httpbin's `<label>Delivery instructions:
  //    <textarea></textarea></label>`). Strip the control's current value so a
  //    filled field's text isn't mistaken for its label.
  let p = el.parentElement;
  while (p) {
    if (p.tagName === 'LABEL') {
      let t = cleanLabel(p.textContent);
      // A wrapping label's textContent includes the control's own text: the value
      // of an input, every <option> of a <select> ("Dropdown (select) One Two").
      const own = el.tagName === 'SELECT' ? Array.from(el.options).map((o) => cleanLabel(o.text)) : [cleanLabel(el.value || '')];
      for (const v of own) if (v) t = t.replace(v, '');
      return cleanLabel(t);
    }
    p = p.parentElement;
  }
  return resolveIdRefs(el, 'aria-labelledby');
};

// Resolve a field's human label when it is NOT wired via for=/aria-labelledby —
// e.g. a react-select whose combobox input carries an INTERNAL id in aria-label
// (question_6132162009, gender, veteran_status) while the readable label sits in a
// SEPARATE sibling <label> inside the same field group (Greenhouse). Climb a few
// ancestors; the first ancestor that contains exactly ONE <label> not wrapping the
// control is the field group, so return that label's text. Stop at the first
// ancestor holding multiple labels (ambiguous — that's a form section, not a field).
// Only "is there exactly ONE such label" matters, so stop at the SECOND one
// instead of materializing every label and calling contains() on each: a high
// ancestor on a console SPA holds thousands, and this ran per candidate
// (GCP: 138,869 querySelectorAll('label') calls in one fast_select_option).
const containerLabel = (el) => {
  let p = el.parentElement;
  for (let hops = 0; p && hops < 5; hops++, p = p.parentElement) {
    let found = null, n = 0;
    try {
      const labels = p.querySelectorAll('label');
      for (let i = 0; i < labels.length && n < 2; i++) {
        const l = labels[i];
        if (l.contains(el)) continue;   // a wrapping label belongs to the control
        if (++n === 1) found = l;
      }
    } catch {}
    if (n === 1 && found) {
      const t = cleanLabel(found.textContent);
      if (t) return t;
    }
    if (n > 1) break; // ambiguous group — don't climb into a section
  }
  return '';
};

// Which iframe documents THIS document reads itself: only those with no URL of
// their own (about:blank / srcdoc — content the parent writes, which nothing can
// address by URL). A frame with an http(s) document — same-origin or not — is a
// document of its own: the background injects page.js into it and reads it there
// (frames.js), with its own index and its own MutationObserver. Reading it here too
// listed it twice, and read it STALE: the index walked it once at the first call and
// no observer watched it (live OCI: the Create compute instance form rendered into a
// same-origin iframe after the first walk and no snapshot ever showed it). Pure.
const ownedFrameDoc = (el) => {
  let doc = null;
  try { doc = el.contentDocument; } catch {}
  if (!doc) return null;
  let url = '';
  try { url = String(doc.URL || ''); } catch {}
  return /^https?:/i.test(url) ? null : doc;
};

// Walks the composed tree (shadow roots + parent-written iframes). Generic
// version used by diagnose / select_option. Indexing has its own walker.
// The frame offset passed to `visit` is OPT-IN (`{offsets:true}`): reading an
// iframe's getBoundingClientRect forces a synchronous layout, and no caller reads
// ox/oy today, so on a page with many same-origin frames that layout was the bulk
// of the walk — 600 frames measured 98ms with the rect vs 6ms without. `seen` means
// a root reachable by more than one path is walked once, never repeatedly.
// ITERATIVE and BUDGETED. Two failure modes seen on GCP's create-client page, whose
// composed tree is 9,995,921 nodes across 47,646 roots behind 38,116 same-origin
// iframes (5 top-level):
//   • a recursive walk threw RangeError: Maximum call stack size exceeded — the frame
//     nesting alone is deeper than the JS stack, so the walk CRASHED;
//   • walking it to completion costs ~45s, which the caller only ever saw as the
//     bridge's "page busy" 20s timeout with no explanation.
// A root queue removes the depth limit, and the budgets stop the walk in well under a
// second. Returns a status so the caller can say WHY it could not answer instead of
// silently returning a short list: { roots, nodes, ms, truncated }.
const WALK_MAX_NODES = 300000;  // composed elements visited before giving up
const WALK_MAX_ROOTS = 4000;    // documents + shadow roots entered
const WALK_MAX_MS    = 600;     // wall clock
const walkDeep = (root, selector, visit, opts) => {
  const o = opts || {};
  const offsets = !!o.offsets;
  const maxNodes = o.maxNodes || WALK_MAX_NODES;
  const maxRoots = o.maxRoots || WALK_MAX_ROOTS;
  const maxMs = o.maxMs || WALK_MAX_MS;
  const t0 = nowMs();
  const seen = new Set();
  const queue = [[root, 0, 0]];
  let head = 0, roots = 0, nodes = 0, truncated = null;
  while (head < queue.length) {
    if (roots >= maxRoots) { truncated = `more than ${maxRoots} roots`; break; }
    if (nodes >= maxNodes) { truncated = `more than ${maxNodes} composed nodes`; break; }
    if (nowMs() - t0 > maxMs) { truncated = `the ${maxMs}ms scan budget`; break; }
    const [r, ox, oy] = queue[head++];
    if (!r || !r.querySelectorAll || seen.has(r)) continue;
    seen.add(r);
    roots++;
    let matches, all;
    try { matches = r.querySelectorAll(selector); all = r.querySelectorAll('*'); }
    catch { continue; }
    for (const el of matches) {
      try { visit(el, { ox, oy, inFrame: ox !== 0 || oy !== 0 }); } catch {}
    }
    nodes += all.length;
    // Budget again HERE, not only at the top of the loop: one enormous root (a
    // single 400k-node document) would otherwise be walked to completion and the
    // between-roots check would never fire. Matches in this root were already
    // visited, so stopping here only skips descending further.
    if (nodes >= maxNodes) { truncated = `more than ${maxNodes} composed nodes`; break; }
    if (nowMs() - t0 > maxMs) { truncated = `the ${maxMs}ms scan budget`; break; }
    for (const el of all) {
      try {
        if (el.shadowRoot) queue.push([el.shadowRoot, ox, oy]);
        if (el.tagName === 'IFRAME') {
          const doc = ownedFrameDoc(el);
          if (!doc) continue;
          let nx = ox, ny = oy;
          if (offsets) {
            let fr;
            try { fr = el.getBoundingClientRect(); } catch { continue; }
            nx = ox + fr.x; ny = oy + fr.y;
          }
          queue.push([doc, nx, ny]);
        }
      } catch {}
    }
  }
  return { roots, nodes, ms: Math.round(nowMs() - t0), truncated };
};

// Compute the offset of `el` relative to the outer-page viewport, accounting
// for nested same-origin iframes. Shadow roots don't add offset.
const offsetFor = (el) => {
  let ox = 0, oy = 0, inFrame = false;
  try {
    let win = el.ownerDocument && el.ownerDocument.defaultView;
    while (win && win !== window && win.frameElement) {
      const fr = win.frameElement.getBoundingClientRect();
      ox += fr.x; oy += fr.y;
      inFrame = true;
      win = win.parent === win ? null : win.parent;
    }
  } catch {}
  return { ox, oy, inFrame };
};

// ─────────────────────────────── the index ───────────────────────────────

// One persistent index per page. Survives runPageAction invocations.
const INDEX = (typeof window !== 'undefined' && window.__fastlinkIndex)
  ? window.__fastlinkIndex
  : {
      byEl: new Map(),  // Element → Entry
      byId: new Map(),  // number  → Element
      // Side set of "option-like" elements (role=option/menuitem/mat-option).
      // Lets fast_select_option's poll loop iterate ~tens of items instead
      // of the whole index. Maintained in lockstep with byEl by indexElement
      // / unindexElement so the option lookup is always a Set scan.
      options: new Set(),
      nextId: 0,
      // id → the label a snapshot SHOWED for it (text/label/aria-label). An id acts only
      // while its element still carries that label; an id never shown is refused.
      served: new Map(),
      ready: false,
      capped: false,       // node-walk ceiling hit → index is intentionally partial
      initStarted: false,
      observer: null,
      // Dynamic/self-limiting state (so the content script is never a
      // background parasite on heavy SPAs like GCP):
      lastActivityMs: 0,   // last time a tool call touched this page
      suspended: false,    // observer currently disconnected (idle or storm)
      stormTripped: false,  // breaker fired: page re-renders too hot to watch
      mutWindowStart: 0,    // mutation-rate sampling window start
      mutCount: 0,         // mutations seen in the current window
    };
if (typeof window !== 'undefined') window.__fastlinkIndex = INDEX;

// Decide if an entry should also live in the options side-set.
const isOptionEntry = (entry) => {
  if (!entry || entry.kind !== 'click') return false;
  if (entry.tag === 'mat-option') return true;
  const role = (entry.role || '').toLowerCase();
  return role === 'option' || role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio';
};

// Collapse a string that is just the same unit repeated 2–4× with no
// separator — the tripled-innerText artifact on custom elements / web
// components (LWC LIGHTNING-BUTTON-STATEFUL renders the label in several
// stacked state spans, so textContent = "FooFooFoo"). Scoped by the caller
// to custom/shadow hosts so plain text ("haha") is never touched. Cheap:
// only runs on short strings and bails on the first non-match.
const collapseRepeat = (s) => {
  const n = s.length;
  if (n < 4 || n > 400) return s;
  for (let k = 2; k <= 4; k++) {
    if (n % k !== 0) continue;
    const unit = s.slice(0, n / k);
    if (unit.length >= 2 && unit.repeat(k) === s) return unit;
  }
  return s;
};

// ─────────────────────── live (never-cached) field values ───────────────────
// A form control's VALUE can never be cached in the index. Setting .value
// through the property setter (what fillItem does, and what React/Angular do)
// mutates NO attribute at all, and the observer's attributeFilter deliberately
// excludes `value`/characterData — so a filled field generates ZERO
// MutationRecords and indexElement is never re-run for it. Caching the value
// therefore froze it at index time forever: a snapshot taken right after a
// successful fast_fill still reported the page's pre-fill default (confirmed on
// GCP's "Create OAuth client ID": entry.text stayed "Web client 2" while the DOM
// held "FastLink Bench", with the observer connected and the storm breaker NOT
// tripped). The value is now READ FROM THE DOM at serialize/scan time instead —
// a property read, no layout — for the handful of entries that carry one.
const liveKindOf = (el) => {
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return 'value';
  if (tag === 'SELECT') return 'select';
  const ce = el.getAttribute && el.getAttribute('contenteditable');
  if (ce === '' || ce === 'true') return 'text';
  const role = ((el.getAttribute && el.getAttribute('role')) || '').toLowerCase();
  if (role === 'textbox') return 'text';
  // a custom combobox (Select2's span, Choices' div, MUI's div): its text is the
  // value it SHOWS — textContent also holds its hidden option list, and a cached
  // copy froze on the value it had at index time
  if (role === 'combobox') return 'shown';
  return null;
};

// Re-read `el`'s current value and re-derive the value-dependent fields of its
// entry. THE single place value→text derivation happens: makeClickEntry calls it
// at index time and serializeSnapshot / fast_wait call it again on every read, so
// there is exactly one rule and no cached copy that can drift.
const refreshLiveEntry = (el, entry) => {
  if (!entry || !entry.live) return entry;
  try {
    if (entry.live === 'select') {
      // A <select>'s `text` stays the option list (matching depends on it); only
      // the selected option is live.
      const o = el.selectedOptions ? el.selectedOptions[0] : (el.options && el.options[el.selectedIndex]);
      entry.value = o ? cleanLabel(o.text || o.value || '') : '';
      return entry;
    }
    let v;
    if (entry.live === 'shown') {
      v = shownValueOf(el);
      entry.innerText = v ? v.slice(0, 120) : null;
    } else if (entry.live === 'value' && el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type || '')) {
      // its state is `checked`; its NAME is its label — never the value attribute ("on", "text")
      entry.value = null;
      entry.innerText = null;
      entry.text = (entry.ariaLabel || entry.label || entry.title || '').trim().slice(0, 120);
      return entry;
    } else if (entry.live === 'value') {
      v = el.value == null ? '' : String(el.value);
      // An <input>/<textarea> has no meaningful inner text — a textarea's
      // textContent is only its DEFAULT value, which goes stale the moment it is
      // typed into. Its content IS its value, carried by value/text below.
      entry.innerText = null;
      // A password's live value must never reach the model. Report only that it
      // is filled, and how long — enough to confirm a fill landed, nothing more.
      if (el.type === 'password') {
        entry.value = v ? '•'.repeat(Math.min(v.length, 32)) : '';
        entry.text = (entry.ariaLabel || entry.label || entry.placeholder || entry.title || '').trim().slice(0, 120);
        return entry;
      }
    } else {
      const raw = (el.textContent || '').trim();
      const isCustom = (el.tagName && el.tagName.includes('-')) || !!el.shadowRoot;
      v = isCustom ? collapseRepeat(raw) : raw;
      entry.innerText = v ? v.slice(0, 120) : null;
    }
    entry.value = v;
    entry.text = (v || entry.ariaLabel || entry.label || entry.placeholder || entry.title || '').trim().slice(0, 120);
  } catch {}
  return entry;
};

// Build a click entry. Uses textContent (does NOT force layout) — that's
// critical for letting the MutationObserver re-index on every attribute
// change without thrashing layout. The minor accuracy loss vs innerText
// (no rendered-only-via-CSS text, no respect for display:none kids) is
// the right tradeoff for keeping the page responsive.
const makeClickEntry = (el) => {
  const lbl = labelFor(el);
  // Only de-dup on custom elements / shadow hosts — that's where the
  // host+slot+inner concatenation artifact occurs; normal elements are left
  // exactly as-is so we never mangle legitimately-repeating text.
  const rawText = (el.textContent || '').trim();
  const isCustom = (el.tagName && el.tagName.includes('-')) || !!el.shadowRoot;
  const innerText = (isCustom ? collapseRepeat(rawText) : rawText).slice(0, 120);
  const titleAttr = el.getAttribute('title') || null;
  const describedBy = resolveIdRefs(el, 'aria-describedby');
  // NOTE: el.value is deliberately NOT part of this chain — a live value is never
  // baked into the entry; refreshLiveEntry re-reads it below (and on every read).
  const text = (innerText || el.getAttribute('aria-label') || lbl || el.getAttribute('placeholder') || titleAttr || '').trim().slice(0, 120);
  const entry = {
    kind: 'click',
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || null,
    text,
    innerText: innerText || null,
    label: lbl || null,
    href: el.tagName === 'A' ? el.href : null,
    placeholder: el.getAttribute('placeholder') || null,
    ariaLabel: el.getAttribute('aria-label') || null,
    describedBy: describedBy ? describedBy.slice(0, 120) : null,
    title: titleAttr,
    type: el.getAttribute('type') || null,
    name: el.getAttribute('name') || null,
    live: liveKindOf(el),
    value: null,
    // an <a> with no href, role, onclick or tab stop: clickable only by script
    weak: (el.tagName === 'A' && !el.hasAttribute('href') && !el.getAttribute('role') && !el.hasAttribute('onclick')
      && !(el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1')) || null,
  };
  return refreshLiveEntry(el, entry);
};

const makeContentEntry = (el) => {
  const text = (el.textContent || '').trim();
  return {
    kind: 'content',
    tag: el.tagName.toLowerCase(),
    text: text.slice(0, 500),
  };
};

// Classify what an element should be in the index (or null = don't index).
//   click   → matches SELECTOR
//   content → has its own (non-descendant) text
//
// We INTENTIONALLY do NOT check `closest(SELECTOR)` here — on a deeply
// nested Angular/React tree, that selector eval against ~50 ancestors per
// element × thousands of elements adds up to seconds. Duplicate content
// inside clickables is caught later by the exact-text dedup in
// serializeSnapshot, so the only loss is content entries with text that
// DIFFERS from the wrapping clickable's text — those are useful to keep
// anyway (a button labeled "Submit" with inner "submits the form" hint).
const classifyElement = (el) => {
  if (!el || el.nodeType !== 1 || el.__fastlinkChip) return null;
  const tag = el.tagName.toLowerCase();
  if (SKIP_SUBTREE.has(tag)) return null;
  try { if (el.matches && el.matches(SELECTOR)) return 'click'; } catch {}
  for (const c of el.childNodes) {
    if (c.nodeType === 3 && c.textContent && c.textContent.trim()) return 'content';
  }
  return null;
};

// Add / update / remove an element in the index based on its current state.
// Stable id across re-classifications of the same element.
const indexElement = (el) => {
  const kind = classifyElement(el);
  const existing = INDEX.byEl.get(el);
  if (!kind) {
    if (existing) {
      INDEX.byEl.delete(el);
      INDEX.byId.delete(existing.id);
    }
    return;
  }
  if (existing && existing.kind === kind) {
    // Refresh fields while preserving id.
    const id = existing.id;
    Object.assign(existing, kind === 'click' ? makeClickEntry(el) : makeContentEntry(el));
    existing.id = id;
    if (isOptionEntry(existing)) INDEX.options.add(el); else INDEX.options.delete(el);
    return;
  }
  if (existing) { INDEX.byId.delete(existing.id); INDEX.options.delete(el); }
  // Cap the index so a churning SPA (GCP spawns tens of thousands of text-bearing
  // divs → 'content' entries) can't grow it without bound and blow the serialize
  // loop. Interactive ('click') entries are always allowed — they're what actions
  // target and are far fewer; only NEW 'content' entries are dropped once full.
  if (kind === 'content' && INDEX.byEl.size >= MAX_INDEX) return;
  const entry = kind === 'click' ? makeClickEntry(el) : makeContentEntry(el);
  entry.id = INDEX.nextId++;
  INDEX.byEl.set(el, entry);
  INDEX.byId.set(entry.id, el);
  if (isOptionEntry(entry)) INDEX.options.add(el);
};

const unindexElement = (el) => {
  const entry = INDEX.byEl.get(el);
  if (entry) {
    INDEX.byEl.delete(el);
    INDEX.byId.delete(entry.id);
    INDEX.options.delete(el);
  }
};

// Shared initial-walk state, persisted on INDEX so the async (idle-time) build
// and the snapshot-time build (buildIndexAsync) advance the SAME cursor and
// converge — instead of each restarting DFS from <body>. `walked` is a monotonic
// count of nodes VISITED, enforcing the MAX_WALK ceiling across all slices.
const INIT = INDEX._init || (INDEX._init = { stack: null, walked: 0 });
const ensureInitStack = () => {
  if (INIT.stack) return;
  const root = document.body || document.documentElement;
  INIT.stack = root ? [root] : [];
};

// Process up to `budget` elements off the shared initial-walk stack, stopping
// early when `overBudget()` returns true. Flips INDEX.ready once the walk
// drains. Returns the number of elements processed this slice.
const stepInitWalk = (budget, overBudget) => {
  ensureInitStack();
  const stack = INIT.stack;
  let n = 0;
  while (stack.length && n < budget) {
    // Hard node ceiling: a 50k-node SPA (GCP) must NEVER attempt a full walk —
    // visiting every node is itself the main-thread hog (matches(SELECTOR) per
    // node). Once we've VISITED MAX_WALK nodes, stop expanding: the entries we
    // have plus viewport-only serialization are enough, and a complete walk
    // would just freeze the page. Flagged so snapshots advertise partial:true.
    if (INIT.walked >= MAX_WALK) { INIT.stack = []; INDEX.ready = true; INDEX.capped = true; break; }
    const el = stack.pop();
    n++;
    INIT.walked++;
    if (el && el.nodeType === 1) {
      const tag = el.tagName.toLowerCase();
      if (!SKIP_SUBTREE.has(tag)) {
        indexElement(el);
        if (el.children) for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]);
        if (el.shadowRoot && el.shadowRoot.children) {
          for (let i = el.shadowRoot.children.length - 1; i >= 0; i--) stack.push(el.shadowRoot.children[i]);
        }
        if (tag === 'iframe') {
          const doc = ownedFrameDoc(el);
          if (doc) {
            const inner = doc.body || doc.documentElement;
            if (inner && inner.children) {
              for (let i = inner.children.length - 1; i >= 0; i--) stack.push(inner.children[i]);
            }
          }
        }
      }
    }
    if (overBudget && overBudget()) break;
  }
  if (!stack.length) INDEX.ready = true;
  return n;
};

// Advance the initial walk under a wall-clock deadline, YIELDING between slices.
// Called at snapshot time when INDEX.ready is still false — on ad/tracker-heavy
// pages the main thread never goes idle, so requestIdleCallback is perpetually
// starved and the async (idle) build can stall with the index EMPTY. This forces
// progress while still releasing the main thread every SLICE_MS, so the heavy
// walk NEVER blocks the page into "unresponsive" (issue #7). Never waits on the
// network. Returns true if the walk completed within the deadline.
const buildIndexAsync = async (deadlineMs) => {
  if (INDEX.ready) return true;
  const start = nowMs();
  let sliceStart = start;
  while (!INDEX.ready) {
    let k = 0;
    // Bound this slice by SLICE_MS, sampled every 32 nodes. Each node runs
    // classifyElement→el.matches(SELECTOR) (expensive on deep trees), so a coarse
    // 256-node cadence let a slow selector run hundreds of times before the first
    // time-check — long enough to blow past the slice and jank the page.
    stepInitWalk(5_000_000, () => ((++k & 31) === 0) && (nowMs() - sliceStart) > SLICE_MS);
    if (INDEX.ready) break;
    if ((nowMs() - start) > deadlineMs) break;   // overall deadline → partial index
    await yieldControl();                          // let the page breathe
    sliceStart = nowMs();
  }
  return !!INDEX.ready;
};

// Initial population, chunked and yielded via requestIdleCallback so it never
// blocks paint. A guaranteed per-tick FLOOR is processed regardless of how much
// idle time the callback reports: a busy SPA (GCP / ad-heavy pages) hands back
// callbacks with ~0 timeRemaining, and the old `while timeRemaining > 1` guard
// then made ZERO progress forever — leaving the index empty and INDEX.ready
// stuck false. The floor guarantees forward progress; snapshots additionally
// force-build (yielding) via buildIndexAsync.
const INIT_FLOOR = 400;    // elements indexed per tick even under idle starvation
const INIT_CHUNK = 2000;   // opportunistic extra while real idle time remains
const populateIndexAsync = () => {
  if (INDEX.initStarted) return;
  INDEX.initStarted = true;
  ensureInitStack();
  const step = (deadline) => {
    stepInitWalk(INIT_FLOOR, null);   // unconditional floor — always advances
    if (!INDEX.ready) {
      stepInitWalk(INIT_CHUNK, () => deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() <= 1);
    }
    if (!INDEX.ready) {
      if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(step, { timeout: 200 });
      else setTimeout(() => step(null), 0);
    }
  };
  if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(step, { timeout: 200 });
  else setTimeout(() => step(null), 0);
};

// Deferred observer. The MutationObserver callback itself does almost no
// work — just stuffs mutated nodes into pending sets. The actual re-indexing
// happens in requestIdleCallback time, so heavy mutation bursts (Cloud
// Console's Angular re-renders) don't block the page. Snapshot reads call
// drainPendingSync(budget) up front, so a moderate amount of fresh data is
// included in each snapshot without any "stale" surprises in normal flows.
const PENDING = INDEX._pending || (INDEX._pending = {
  adds: new Set(),
  removes: new Set(),
  reindex: new Set(),
  scheduled: false,
  // An in-progress, resumable subtree walk. A single huge re-render (one giant
  // added subtree) is processed across multiple slices via this cursor instead
  // of in one uninterruptible call, so the wall-clock cap below can't be blown
  // by a single op. Persisted on INDEX so it survives runPageAction calls.
  cursor: null,
});

const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

// Yield the main thread for one macrotask so the page can paint / handle input
// between work slices. MessageChannel is used (not setTimeout) because timers
// are clamped to ≥1s in BACKGROUND tabs — which is exactly the relay case where
// Claude drives a backgrounded tab — and requestAnimationFrame is paused there
// entirely. MessageChannel postMessage is not throttled, so a heavy snapshot in
// a background tab still progresses promptly. scheduler.yield() is preferred
// when available (keeps us ahead of the line on re-entry).
const yieldControl = () => {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    try { return scheduler.yield(); } catch {}
  }
  return new Promise((resolve) => {
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
    } catch { setTimeout(resolve, 0); }
  });
};

// Pull the next unit of indexing work into a resumable cursor.
//   removes / adds → descend the whole subtree (a node was attached/detached).
//   reindex        → single element only (an attribute / text change); descend
//                    is false so we DON'T re-walk its subtree, matching the
//                    original behaviour where a reindex touched just that node.
const nextWork = () => {
  for (const el of PENDING.removes) { PENDING.removes.delete(el); return { stack: [el], onEl: unindexElement, descend: true }; }
  for (const el of PENDING.adds)    { PENDING.adds.delete(el);    return { stack: [el], onEl: indexElement,   descend: true }; }
  for (const el of PENDING.reindex) { PENDING.reindex.delete(el); return { stack: [el], onEl: indexElement,   descend: false }; }
  return null;
};

// Process exactly ONE element off the cursor's stack. Keeping the unit of work
// at element granularity is what lets the time cap be honoured mid-subtree.
const stepCursor = (cur) => {
  const el = cur.stack.pop();
  if (!el || el.nodeType !== 1) return;
  const tag = el.tagName.toLowerCase();
  if (SKIP_SUBTREE.has(tag)) return;
  try { cur.onEl(el); } catch {}
  if (!cur.descend) return;
  if (el.children) for (let i = el.children.length - 1; i >= 0; i--) cur.stack.push(el.children[i]);
  if (el.shadowRoot && el.shadowRoot.children) {
    for (let i = el.shadowRoot.children.length - 1; i >= 0; i--) cur.stack.push(el.shadowRoot.children[i]);
  }
  if (tag === 'iframe') {
    const doc = ownedFrameDoc(el);
    if (doc) {
      const inner = doc.body || doc.documentElement;
      if (inner && inner.children) {
        for (let i = inner.children.length - 1; i >= 0; i--) cur.stack.push(inner.children[i]);
      }
    }
  }
};

const hasPending = () =>
  PENDING.adds.size > 0 || PENDING.removes.size > 0 || PENDING.reindex.size > 0 ||
  !!(PENDING.cursor && PENDING.cursor.stack.length);

// Run up to `budget` element-steps, stopping early when `overBudget()` is true.
// Shared by the synchronous snapshot-time drain and the idle-time drain.
const drainSteps = (budget, overBudget) => {
  let n = 0;
  while (n < budget) {
    if (!(PENDING.cursor && PENDING.cursor.stack.length)) {
      PENDING.cursor = nextWork();
      if (!PENDING.cursor) return;
    }
    stepCursor(PENDING.cursor);
    if (!PENDING.cursor.stack.length) PENDING.cursor = null;
    n++;
    if (overBudget && overBudget()) return;
  }
};

// Drain up to `budget` element-steps synchronously, bailing after `timeBudgetMs`
// of wall clock. The time check is now per-ELEMENT (not per-subtree), so one
// giant re-render can no longer monopolise a snapshot — its walk is spread
// across slices via PENDING.cursor and finished on idle.
const drainPendingSync = (budget, timeBudgetMs) => {
  const start = nowMs();
  drainSteps(budget, () => timeBudgetMs && (nowMs() - start) > timeBudgetMs);
};

const scheduleDrain = () => {
  if (PENDING.scheduled || !hasPending()) return;
  PENDING.scheduled = true;
  const step = (deadline) => {
    PENDING.scheduled = false;
    drainSteps(200, () => deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() < 1);
    if (hasPending()) scheduleDrain();
  };
  // {timeout:200} is critical: on a busy Angular SPA (GCP) the main thread is
  // never idle, so a bare requestIdleCallback may NEVER fire — the drain then
  // never runs and the PENDING sets grow without bound (pinning detached nodes)
  // until the renderer OOMs. The timeout forces the drain to run regardless.
  if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(step, { timeout: 200 });
  else setTimeout(() => step(null), 0);
};

// Self-limiting MutationObserver. Two protections so this is never a background
// parasite on heavy SPAs (the bug that wedged GCP):
//   • STORM BREAKER — if mutations exceed STORM_RATE in a sampling window, the
//     observer DISCONNECTS and sets stormTripped. The page is telling us it
//     re-renders too hot to track live; we get out of the way and rebuild the
//     index on demand (serializeSnapshot drains pending / re-walks as needed).
//   • IDLE SUSPEND — checked at snapshot time: if no tool call for IDLE_MS, the
//     observer disconnects until the next tool call re-arms it (armObserver).
const STORM_WINDOW_MS = 1000;
const STORM_RATE = 1500;   // mutations/sec above which we stop watching live
const IDLE_MS = 15000;     // disconnect the observer after this much inactivity

// A MutationRecord caused by FastLink's own flash chip (flashEl), not the page.
const isOwnMutation = (m) => {
  if (m.type !== 'childList') return !!(m.target && m.target.__fastlinkChip);
  for (const n of m.addedNodes) if (!n.__fastlinkChip) return false;
  for (const n of m.removedNodes) if (!n.__fastlinkChip) return false;
  return true;
};

// Is the page still changing? True when the observer saw a mutation within
// ACTIVITY_MS, or a resource finished loading within it (the observer may be
// off on a storm-tripped page; resource timing still tells).
const ACTIVITY_MS = 400;
const pageActivity = () => {
  const now = nowMs();
  const sinceMut = INDEX.lastMutMs ? now - INDEX.lastMutMs : Infinity;
  let sinceNet = Infinity;
  try {
    const rs = performance.getEntriesByType('resource');
    for (let i = rs.length - 1; i >= 0 && i >= rs.length - 40; i--) {
      const end = rs[i].responseEnd || rs[i].startTime || 0;
      if (end) sinceNet = Math.min(sinceNet, now - end);
    }
  } catch {}
  return { settling: sinceMut < ACTIVITY_MS || sinceNet < ACTIVITY_MS, sinceMutMs: Math.round(sinceMut), sinceNetMs: Math.round(sinceNet) };
};
// Wait until the DOM has been quiet for quietMs (no observer mutations), at
// most maxMs. { settled, waitedMs }.
const settleDom = async (maxMs, quietMs = 150) => {
  const start = nowMs();
  for (;;) {
    const sinceMut = INDEX.lastMutMs ? nowMs() - INDEX.lastMutMs : Infinity;
    if (sinceMut >= quietMs) return { settled: true, waitedMs: Math.round(nowMs() - start) };
    if (nowMs() - start >= maxMs) return { settled: false, waitedMs: Math.round(nowMs() - start) };
    await new Promise((r) => setTimeout(r, Math.min(50, Math.max(1, quietMs - sinceMut))));
  }
};

const disconnectObserver = (reason) => {
  if (INDEX.observer) { try { INDEX.observer.disconnect(); } catch {} INDEX.observer = null; }
  INDEX.suspended = true;
  if (reason === 'storm') { INDEX.stormTripped = true; INDEX.stormAt = nowMs(); }
};
// A storm is usually a burst (a panel animating in, a table re-rendering). After this long
// the next tool call re-arms the observer; a page still too hot simply trips it again. A
// permanently deaf observer left settles and waits blind (live Oracle 4cbfe776: sinceMutMs
// 81,240 while panels opened and closed).
const STORM_RETRY_MS = 10000;
// How long a click waits for the page to START reacting (see fast_click): a popup opener, any other button.
const REACT_OPENER_MS = 800, REACT_CLICK_MS = 300;

const setupObserver = () => {
  if (INDEX.observer || typeof MutationObserver === 'undefined') return;
  try {
    const obs = new MutationObserver((muts) => {
      // Storm sampling: count mutations per window; trip the breaker if too hot.
      const t = nowMs();
      // Activity stamp for settleDom/pageActivity. Our own flash chips are not
      // page activity, so a batch made only of them leaves the stamp alone.
      if (!muts.every(isOwnMutation)) INDEX.lastMutMs = t;
      if (t - INDEX.mutWindowStart > STORM_WINDOW_MS) { INDEX.mutWindowStart = t; INDEX.mutCount = 0; }
      INDEX.mutCount += muts.length;
      if (INDEX.mutCount > STORM_RATE) { disconnectObserver('storm'); return; }
      // Backstop the rate breaker: a SUSTAINED sub-threshold mutation rate
      // (~500-1400/s on GCP, under STORM_RATE) never trips the spike detector,
      // but if the drain can't keep up the PENDING sets grow without bound and
      // OOM the renderer. Cap total backlog → trip the breaker and let snapshots
      // rebuild on demand instead.
      if (PENDING.adds.size + PENDING.reindex.size + PENDING.removes.size > 20000) {
        disconnectObserver('storm'); return;
      }

      for (const m of muts) {
        if (m.type === 'childList') {
          for (const node of m.removedNodes) if (node.nodeType === 1) PENDING.removes.add(node);
          for (const node of m.addedNodes)   if (node.nodeType === 1) PENDING.adds.add(node);
        } else if (m.type === 'characterData') {
          const p = m.target.parentElement;
          if (p) PENDING.reindex.add(p);
        } else if (m.type === 'attributes' && m.target && m.target.nodeType === 1) {
          PENDING.reindex.add(m.target);
        }
      }
      scheduleDrain();
    });
    // Narrow config = the browser builds far smaller MutationRecord batches.
    // Dropped characterData (fired on every text re-render) and the `value`
    // attribute (fires per keystroke) — the two biggest record generators on
    // Angular. Content-entry text staleness is fine; it's refreshed by the
    // snapshot-time drain / detached cleanup. This is PREVENTIVE (fewer records
    // ever made), complementing the reactive storm breaker.
    obs.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'role','aria-label','aria-labelledby','href','contenteditable','tabindex','type','placeholder',
      ],
    });
    INDEX.observer = obs;
    INDEX.suspended = false;
    INDEX.mutWindowStart = nowMs();
    INDEX.mutCount = 0;
  } catch {}
};

// Re-arm the observer on a tool call (after idle-suspend or a storm trip). On a
// storm-tripped page we stay disconnected and rely on on-demand index rebuilds
// in serializeSnapshot — re-attaching would just re-trip. Idle-suspend re-arms
// freely. Always stamps activity so idle-suspend measures from the last call.
const armObserver = () => {
  INDEX.lastActivityMs = nowMs();
  if (INDEX.stormTripped) {
    if (!(INDEX.stormAt && nowMs() - INDEX.stormAt > STORM_RETRY_MS)) return;   // stay out of the way while it is hot
    INDEX.stormTripped = false;          // cooled down: listen again
  }
  if (!INDEX.observer) setupObserver();
};
// Is the observer recording page mutations right now (so settleDom's quiet signal means something)?
const observerLive = () => !!INDEX.observer && !INDEX.suspended && !INDEX.stormTripped;

// Called at snapshot time: if FastLink has been idle, disconnect the observer
// so an unused-but-live tab carries no background watcher.
const maybeIdleSuspend = () => {
  if (INDEX.observer && INDEX.lastActivityMs && (nowMs() - INDEX.lastActivityMs) > IDLE_MS) {
    disconnectObserver('idle');
  }
};

// Kick off init. Called on every runPageAction but no-op after the first.
// Observer is enabled with a deferred drain queue (PENDING + scheduleDrain
// above) so heavy mutation bursts don't block the page.
const initIndex = () => {
  if (INDEX.initStarted) return;
  const start = () => { populateIndexAsync(); setupObserver(); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
};

// Known transient-popover / portal containers. Radix, react-select, MUI,
// Angular cdk-overlay, and any [role=menu]/[role=listbox] mount their items
// into a PORTAL (usually end of <body>), and/or animate open — so a snapshot
// taken at the wrong instant misses the very items the agent needs to click.
const OVERLAY_CONTAINERS =
  '[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],' +
  '.cdk-overlay-container,[class*="react-select__menu"],' +
  '[class*="MuiPopover"],[class*="MuiMenu"]';

// Find every interactive element living inside an open overlay container,
// across the composed tree (shadow roots + same-origin iframes). Force-indexes
// each so it gets a stable id and is clickable/markable even if the
// MutationObserver hasn't drained the portal's added nodes yet (beats the
// open-animation race). Returns a Set<Element> for inOverlay tagging.
const OVERLAY_MAX_ELS = 500;   // never let the portal sweep itself become the freeze
const OVERLAY_BUDGET_MS = 60;
const collectOverlayEls = () => {
  const set = new Set();
  const start = nowMs();
  // walkDeep can't break early, but the callbacks bail cheaply once we hit the
  // element cap or wall-clock budget — so a giant open listbox can't hang here.
  walkDeep(document, OVERLAY_CONTAINERS, (container) => {
    if (set.size >= OVERLAY_MAX_ELS || (nowMs() - start) > OVERLAY_BUDGET_MS) return;
    try { walkDeep(container, SELECTOR, (el) => { if (set.size < OVERLAY_MAX_ELS) set.add(el); }); } catch {}
  });
  for (const el of set) { try { indexElement(el); } catch {} }
  return set;
};

// What a snapshot showed an item as — compared again before an id is acted on. Pure.
// A field is identified by its NAME (a dropdown's shown text is its value, which changes
// legitimately); anything else by its aria-label, else its text.
const servedLabel = (it) => cleanLabel(String(it.label || it.ariaLabel || it.text || '')).slice(0, 200);
// An item's kind for re-resolving an id: its role, else its tag (+ input type). Pure.
const itemKind = (it) => String(it.role || (it.tag === 'input' ? `input:${it.type || 'text'}` : it.tag) || '').toLowerCase();
// Record every id a result hands out — snapshot and preview items, dialog items, a wait's
// found element, anything carrying a numeric `i` with a tag — at the ONE exit every page.js
// result leaves through (window.__fastlink.run). Live Oracle 46acec38: an id from a wait
// hit was refused as "not listed by any snapshot".
const noteServedDeep = (v, depth = 0) => {
  if (!v || typeof v !== 'object' || depth > 6) return;
  if (Array.isArray(v)) { for (const x of v) noteServedDeep(x, depth + 1); return; }
  if (typeof v.i === 'number' && v.tag) {
    if (!INDEX.served) INDEX.served = new Map();
    if (INDEX.served.size > 50000) INDEX.served.clear();
    INDEX.served.set(v.i, { label: servedLabel(v), kind: itemKind(v), tag: String(v.tag).toLowerCase() });
  }
  for (const k of Object.keys(v)) { const x = v[k]; if (x && typeof x === 'object') noteServedDeep(x, depth + 1); }
};

// The dialog the user is in, or null. A declared one (<dialog open>, role=dialog /
// alertdialog, aria-modal) that is visible — the last in document order is the one
// on top; else the portal layer holding focus: an ancestor of the focused element
// that is position:fixed, a direct child of <body> (where portals mount) and holds a
// button. That covers dialogs that declare nothing (live Azure: the resource group
// "Create new" callout inside the reactblade frame reported no dialog; the model
// typed the name and never pressed its OK). Bounded: 50 declared candidates, 40
// ancestors. Pure given the DOM.
const DIALOG_SEL = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
const activeDialogRoot = () => {
  try {
    const els = document.querySelectorAll(DIALOG_SEL);
    for (let i = Math.min(els.length, 50) - 1; i >= 0; i--) {
      let r; try { r = els[i].getBoundingClientRect(); } catch { continue; }
      if (visible(els[i], r)) return els[i];
    }
    // The undeclared fallback must look like a dialog, not like page chrome (live Azure
    // 0a0b5258: the fixed top header with its focused search box was read as a dialog,
    // ranked first, and crowded the blade's form out of the snapshot): it covers the
    // viewport centre or ≥30% of the viewport, is not a full-width strip pinned to the top
    // or bottom edge, and holds no navigation / banner landmark.
    const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
    const looksLikeDialog = (el) => {
      let r; try { r = el.getBoundingClientRect(); } catch { return false; }
      if (!r || r.width < 2 || r.height < 2) return false;
      const coversCentre = r.left <= vw / 2 && r.right >= vw / 2 && r.top <= vh / 2 && r.bottom >= vh / 2;
      const bigEnough = vw > 0 && vh > 0 && (r.width * r.height) >= 0.3 * vw * vh;
      const strip = r.width >= 0.9 * vw && r.height < 0.4 * vh && (r.top <= 2 || r.bottom >= vh - 2);
      if (strip || !(coversCentre || bigEnough)) return false;
      try { if (el.matches('header,nav,[role="banner"],[role="navigation"]') || el.querySelector('header,nav,[role="banner"],[role="navigation"]')) return false; } catch {}
      return true;
    };
    let a = document.activeElement;
    for (let k = 0; a && a !== document.body && a !== document.documentElement && k < 40; k++, a = a.parentElement) {
      if (a.parentElement !== document.body) continue;
      let cs = null; try { cs = getComputedStyle(a); } catch {}
      if (cs && cs.position === 'fixed' && a.querySelector('button,[role="button"],input[type="submit"],input[type="button"]') && looksLikeDialog(a)) return a;
    }
  } catch {}
  return null;
};
// How the snapshot names a dialog: aria-label, aria-labelledby, its first heading, else its first text. Pure.
const dialogLabel = (d) => {
  try {
    const own = d.getAttribute('aria-label');
    if (own) return cleanLabel(own).slice(0, 80);
    const by = (d.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean);
    if (by.length) return cleanLabel(by.map((e) => e.textContent).join(' ')).slice(0, 80);
    const h = d.querySelector('h1,h2,h3,h4,[role="heading"]');
    if (h) return cleanLabel(h.textContent).slice(0, 80);
    // its first own text that is not a control or a control's label
    const tw = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
    for (let t = tw.nextNode(), k = 0; t && k < 200; t = tw.nextNode(), k++) {
      const p = t.parentElement;
      if (p && p.closest('button,label,input,select,textarea,option,[role="button"],[role="option"],script,style')) continue;
      const txt = cleanLabel(t.nodeValue);
      if (txt) return txt.slice(0, 60);
    }
    return '';
  } catch { return ''; }
};

// Read the index → snapshot payload. Single layout pass for all rect reads.
// Cleans up entries whose elements have been detached (defense in depth;
// MutationObserver usually catches removals first).
const serializeSnapshot = async (viewportOnly, opts) => {
  // ALWAYS bound the serialize. Previously budgetMs was undefined on the
  // pre-action matching snapshots (serializeSnapshot(false) in fast_click/fill/
  // etc.), so the per-element time guard below was dead code and the loop walked
  // the ENTIRE index — tens of thousands of nodes on a heavy SPA like GCP — until
  // the 30s broker timeout wedged the renderer. Default to a hard budget so a
  // match snapshot can never hang the page.
  const budgetMs = (opts && opts.budgetMs) || 2500;
  const drainMs = (opts && opts.drainMs) || 40;
  const startMs = nowMs();
  // Disconnect the observer if FastLink has gone idle (no background watcher on
  // an unused tab).
  maybeIdleSuspend();
  // If the initial index walk hasn't finished, advance it synchronously under
  // the snapshot indexer's OWN deadline so we return a POPULATED partial index
  // rather than empty-and-hanging. This does NOT wait on network idle (which
  // often never fires on ad/tracker-heavy pages) — it's a bounded DOM walk.
  let indexPartial = false;
  if (!INDEX.ready) {
    const indexMs = (opts && opts.indexMs) || 2500;
    await buildIndexAsync(indexMs);
    indexPartial = !INDEX.ready;
  }
  // Auto-degrade: on a giant DOM (node ceiling hit, or an index already past
  // HUGE_INDEX entries) force viewport-only output. Reading + offsetting rects
  // for tens of thousands of entries is the freeze; viewport-only keeps the
  // payload small and the loop short. Heavy pages get partial-but-usable data
  // instead of a hang.
  const heavy = INDEX.capped || INDEX.byEl.size > HUGE_INDEX;
  if (heavy) viewportOnly = true;
  // On a storm-tripped page the observer is OFF, so the index isn't being kept
  // live by mutations. Re-walk the DOM on demand here (bounded) so this snapshot
  // still reflects current state — this is the "rebuild on demand instead of
  // watch forever" path. The walk is queued and drained under the same budget.
  if (INDEX.stormTripped) {
    // Re-seed a full-DOM walk ONLY when the previous one has fully drained —
    // do NOT null the cursor, which threw away the in-progress walk every call
    // so each snapshot restarted DFS from <body> and only ever re-indexed the
    // same first ~2000 nodes (deep GCP elements never got indexed). Letting the
    // resumable cursor finish converges the index across snapshots.
    const root = document.body || document.documentElement;
    if (root && !hasPending()) PENDING.adds.add(root);
  }
  // Drain a chunk of pending mutations synchronously so post-click /
  // post-nav snapshots reflect the dropdown / modal that just appeared.
  // Bounded by both op count AND wall-clock time so a giant listbox
  // expansion can't hang the snapshot.
  drainPendingSync(2000, drainMs);
  // Opt-in overlay/portal sweep: directly scan known popover containers and
  // force-index their interactive items so currently-open Radix/MUI/react-select
  // menus and [role=menu/listbox] panes are included even when the index race
  // would otherwise miss them. Default snapshots skip this entirely.
  let overlayEls = null;
  if (opts && opts.overlay) {
    try { overlayEls = collectOverlayEls(); } catch { overlayEls = null; }
  }
  // An open dialog leads the snapshot: its controls rank first (a capped preview never
  // drops its OK), and `dialog` names it with the ids of what is inside.
  const dialogRoot = activeDialogRoot();
  const dialogItems = [];
  const items = [];
  const content = [];
  let timedOut = false;
  let seen = 0;
  let offscreenItems = 0;   // visible interactive entries skipped by viewportOnly
  let fillable = 0;         // visible, EMPTY fillable fields on this view (the batching nudge)
  // matchAll: the internal match pool for click/fill keeps offscreen interactive
  // entries (tagged offscreen:true) even when a heavy page forces viewport-only —
  // the rect is read for the visibility test anyway, so this costs no layout.
  const matchAll = !!(opts && opts.matchAll);
  const vh = window.innerHeight, vw = window.innerWidth;
  const detached = [];
  let sliceStart = nowMs();
  // Memoize the per-iframe offset for THIS pass: every element in a given
  // document shares the same frame-offset chain (shadow roots add none), so we
  // compute it once per ownerDocument instead of walking + reading a rect per
  // frame-ancestor on EVERY element — the dominant layout cost on framed pages.
  const offsetCache = new Map();
  const offsetForCached = (el) => {
    const doc = el.ownerDocument || document;
    let off = offsetCache.get(doc);
    if (off === undefined) { off = offsetFor(el); offsetCache.set(doc, off); }
    return off;
  };
  for (const [el, entry] of INDEX.byEl) {
    // Check the budget OFTEN (every 16 items): each item does 3-5 layout reads,
    // so a coarse 64-item cadence could run ~300 layouts between checks and blow
    // a whole frame before yielding. Two bounds:
    //   • overall budget → bail with a partial-but-rich snapshot flagged
    //     snapshotTimedOut, never hang the whole call to the broker timeout.
    //   • per-slice SNAP_SLICE_MS → YIELD the main thread so even a 10k-entry
    //     serialize can't freeze the page into "unresponsive" (issue #7).
    if ((++seen & 15) === 0) {
      const t = nowMs();
      if (budgetMs && (t - startMs) > budgetMs) { timedOut = true; break; }
      if ((t - sliceStart) > SNAP_SLICE_MS) { await yieldControl(); sliceStart = nowMs(); }
    }
    if (!el.isConnected) { detached.push(el); continue; }
    if (entry.weak && !entry.text) continue;   // a script target with no text/title/label: nothing to name it by
    let rect;
    try { rect = el.getBoundingClientRect(); } catch { continue; }
    let proxied = false;
    if (!visible(el, rect)) {
      const pr = entry.kind === 'click' ? labelProxyRect(el) : null;
      if (!pr) continue;
      rect = pr; proxied = true;
    }
    const isOverlayEl = overlayEls && overlayEls.has(el);
    const outOfView = !isOverlayEl && (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw);
    // Every returned control outside this document's viewport says so, with its
    // position: a full read lists controls below the fold too (live Azure: Region and
    // Image sit below the blade frame's fold), and the flag tells the caller they are
    // there but not on screen (actions scroll them into view first).
    const offscreen = outOfView && entry.kind === 'click';
    if (viewportOnly && outOfView) {
      if (entry.kind === 'click') offscreenItems++;
      if (!(matchAll && entry.kind === 'click')) continue;
    }
    const off = offsetForCached(el);
    const x = Math.round(rect.x + off.ox);
    const y = Math.round(rect.y + off.oy);
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (entry.kind === 'click') {
      // LIVE VALUE: re-read form controls straight from the DOM. Costs one
      // property read on the handful of entries that carry a value, and only for
      // items this snapshot actually RETURNS (we are already past the visibility /
      // viewport filters) — so it stays O(items returned), not a re-walk. Without
      // it a filled field reports its pre-fill default forever (no mutation record
      // is ever produced for a .value write).
      if (entry.live) refreshLiveEntry(el, entry);
      // Emit only keys that carry a meaningful value — null/undefined/empty-string
      // fields are dropped entirely (roughly halves the payload with zero info
      // loss; every consumer reads `it.X && …` / `(it.X || '')`, so absent and
      // null are equivalent to them). i, tag, text and geometry are always kept.
      // A field reads as NAME then VALUE, first: a combobox's `text` is what it shows
      // (its current value), so without this the field's name hid in ariaLabel (live
      // Azure: "Ubuntu Server 24.04 LTS - x64 Gen2" with the name "Image" only in ariaLabel,
      // and the model reported the Image control absent).
      const isField = !!entry.value || /^(input|select|textarea)$/.test(entry.tag) || /^(combobox|listbox|textbox|searchbox|spinbutton)$/.test(entry.role || '');
      const fieldName = isField ? (entry.label || entry.ariaLabel || entry.placeholder || entry.name || null) : entry.label;
      const item = { i: entry.id, tag: entry.tag };
      if (fieldName)         item.label = fieldName;
      if (entry.value)       item.value = entry.value;   // live DOM value, never cached
      Object.assign(item, { text: entry.text, x, y, w, h });
      if (entry.role)        item.role = entry.role;
      if (entry.innerText)   item.innerText = entry.innerText;
      if (entry.href)        item.href = entry.href;
      if (entry.name)        item.name = entry.name;
      if (entry.placeholder) item.placeholder = entry.placeholder;
      if (entry.ariaLabel)   item.ariaLabel = entry.ariaLabel;
      if (entry.describedBy) item.describedBy = entry.describedBy;
      if (entry.title)       item.title = entry.title;
      if (entry.type)        item.type = entry.type;
      if (off.inFrame)       item.inFrame = true;
      if (overlayEls && overlayEls.has(el)) item.inOverlay = true;
      if (dialogRoot && dialogRoot.contains(el)) { item.inDialog = true; dialogItems.push(item); }
      if (offscreen)         item.offscreen = true;
      if (entry.weak)        item.clickable = 'script';
      if (proxied)           item.via = 'label';   // the input is hidden; its <label> is what is drawn
      const chk = checkedOf(el);
      if (chk !== null) { item.checked = chk; if (!item.role) item.role = implicitRoleOf(entry.tag, entry.type); }
      if (!offscreen && isEmptyFillable(el, entry)) fillable++;
      items.push(item);
    } else {
      content.push({ tag: entry.tag, text: entry.text, x, y, w, h, inFrame: off.inFrame || undefined });
      // cursor:pointer text is ALSO a (weak) click target; identical content text is deduped below
      if (entry.text && pointerContent(el)) items.push({ i: entry.id, tag: entry.tag, text: entry.text.slice(0, 120), x, y, w, h, clickable: 'script', ...(off.inFrame ? { inFrame: true } : {}) });
    }
  }
  for (const el of detached) unindexElement(el);
  // Exact-text dedup: drop content blocks whose text matches a click item.
  if (content.length) {
    const clickTexts = new Set();
    for (const it of items) if (it.text) clickTexts.add(it.text);
    for (let i = content.length - 1; i >= 0; i--) {
      if (clickTexts.has(content[i].text)) content.splice(i, 1);
    }
  }
  // (Cross-origin frames on screen are named by withFrameNotice on every snapshot result.)
  let hint;
  // Batching nudge, as data: 2+ empty fields on one view → one fast_fill{fields}
  // (or one fast_batch), never field-by-field turns.
  if (fillable >= 2) hint = `${fillable} empty fillable fields visible; fill them in one fast_fill {fields:{label:value}} or one fast_batch` + (hint ? ' | ' + hint : '');
  return {
    url: location.href, title: document.title,
    ...(dialogRoot && dialogItems.length ? { dialog: { label: dialogLabel(dialogRoot), items: dialogItems.slice(0, 20).map((it) => ({ i: it.i, tag: it.tag, ...(it.role ? { role: it.role } : {}), ...(it.label ? { label: it.label } : {}), ...(it.text ? { text: it.text.slice(0, 60) } : {}), ...(it.value ? { value: it.value } : {}) })) } } : {}),
    fillable: fillable || undefined,
    hint: hint || undefined,
    count: items.length, items,
    contentCount: content.length, content,
    indexing: !INDEX.ready || undefined,
    partial: (indexPartial || INDEX.capped) || undefined,
    capped: INDEX.capped || undefined,
    snapshotTimedOut: timedOut || undefined,
    offscreenItems: offscreenItems || undefined,
  };
};

// Synthetic key events carry the legacy keyCode/which too: Google's widgets
// (Maps suggestions) and older handlers switch on event.keyCode, which is 0
// unless set explicitly — an ArrowDown without it is a no-op there.
const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ' ': 32, Space: 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
const keyInit = (key, extra) => {
  const code = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  return { key, code: key === ' ' ? 'Space' : key, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true, ...(extra || {}) };
};

// Options panel of an ARIA select: the ids named by aria-controls / aria-owns on
// the field itself, on its inner combobox/input, or on a [aria-haspopup]
// descendant (mat-select / cfc-select set them on open). Pure: takes any object
// with getAttribute + querySelectorAll (unit-tested with a fake DOM).
const ARIA_PANEL_HOSTS = '[role="combobox"],input,[aria-haspopup],[aria-controls],[aria-owns]';
const ariaPanelIds = (field) => {
  const ids = [];
  const take = (el) => {
    for (const attr of ['aria-controls', 'aria-owns']) {
      let v = null; try { v = el.getAttribute(attr); } catch {}
      if (v) for (const id of String(v).trim().split(/\s+/)) if (id && !ids.includes(id)) ids.push(id);
    }
  };
  if (!field) return ids;
  take(field);
  let inner = []; try { inner = Array.from(field.querySelectorAll(ARIA_PANEL_HOSTS)).slice(0, 20); } catch {}
  for (const el of inner) take(el);
  return ids;
};

// Outline path of an element: the titles of every heading/legend whose span
// (anchor → next same-or-higher-level anchor) holds it, outermost first. Pure
// over (anchors in document order, level(a), contains(a,b), follows(a,b),
// title(a)) so a fake DOM can drive it (fast-runner/test/fill-ambiguity.test.mjs).
const outlineTitles = (anchors, el, level, contains, follows, title) => {
  const stack = [];
  for (const a of anchors) {
    if (!follows(a, el)) break;
    if (stack.length && contains(stack[stack.length - 1].a, a)) continue;   // <h2> nested in its own <legend>: one section
    const lvl = level(a);
    while (stack.length && stack[stack.length - 1].lvl >= lvl) stack.pop();
    stack.push({ a, lvl });
  }
  return stack.map(s => title(s.a)).filter(Boolean);
};
// For each candidate's outline path, the deepest title the OTHER candidates do
// not all share — the `section:` value that would single it out (GCP: both
// "URIs 1" rows sit under an <h3>Item 1</h3>, so the h2 above distinguishes).
const distinguishingSections = (paths) => paths.map((p, i) => {
  const others = paths.filter((_, j) => j !== i);
  for (let k = p.length - 1; k >= 0; k--) if (!others.every(o => o.includes(p[k]))) return p[k];
  return p[p.length - 1] || null;
});
// The buttons of a section that has no input yet, ranked by how likely each
// CREATES the field. Pure over [{name, text, iconOnly, tooltip}] (name = the
// accessible name, text = visible text) — fast-runner/test/fill-miss-hint.test.mjs.
// Tier 0: an add/new/create/insert/append word or a "+" glyph; 1: visible text;
// 2: icon-only. Demoted below all (never named in a hint): a help/info/learn
// more/tooltip/close/remove/delete/clear/cancel name, or an icon-only button
// that carries a tooltip / aria-describedby (a help "?" icon).
const CREATE_WORD = /(?:^|[^\p{L}\p{N}])(?:add|new|create|insert|append)(?:$|[^\p{L}\p{N}])|[+＋➕]/iu;
const NOT_CREATE_WORD = /(?:^|[^\p{L}\p{N}])(?:help|info|information|learn more|more info|tooltip|close|dismiss|remove|delete|clear|cancel)(?:$|[^\p{L}\p{N}])/iu;
const rankCreateButtons = (btns) => {
  const ranked = btns.map((b, k) => {
    const words = `${b.name || ''} ${b.text || ''}`;
    const demoted = NOT_CREATE_WORD.test(words) || !!(b.iconOnly && b.tooltip);
    const tier = demoted ? 3 : CREATE_WORD.test(words) ? 0 : b.iconOnly ? 2 : 1;
    return { ...b, tier, demoted, k };
  });
  return ranked.sort((a, b) => a.tier - b.tier || a.k - b.k);
};
// A fill miss the page already EXPLAINS is final: the label is a section (with or
// without a button that creates its field), a select control, several matching
// fields (candidates carry index:N), or no value was given. Pure.
const explainedMiss = (m) => !!(m && (m.skipped || m.section || m.selectField || (Array.isArray(m.candidates) && m.candidates.some(c => c && typeof c.index === 'number'))));
// Top-level hint of a fast_fill miss (single, or the head of {fields}): the first
// explained miss's own hint; the generic "may not be rendered yet" settle hint
// only when the page is still changing AND some miss is unexplained — never on
// top of a section/select/duplicate hint it would contradict. Pure.
const missHead = (misses, settling, settleHint) => {
  const own = (misses.find(m => explainedMiss(m) && m.hint) || {}).hint;
  const head = {};
  if (settling && misses.some(m => !explainedMiss(m))) {
    head.settling = true;
    const other = (misses.find(m => !explainedMiss(m) && m.hint) || {}).hint;
    head.hint = [own, [settleHint, other].filter(Boolean).join('; ')].filter(Boolean).join(' | ');
  } else if (own) head.hint = own;
  return head;
};

// fast_scroll's destination. `to` (top|bottom|"N%") or `pixels` (a delta) when
// given; with neither, ONE visible screenful of the scroller (its view height
// minus a small overlap, so the last line in view stays in view) — a scroll
// named on an element with no amount is a request to page through it, not an
// error (holdout: fast_scroll {selector:"#demo-tree"} errored four times). Pure.
const SCROLL_OVERLAP_PX = 40;
const scrollDest = (args, { top, max, viewH }) => {
  if (args.to === 'top') return { dest: 0 };
  if (args.to === 'bottom') return { dest: max };
  if (typeof args.to === 'string' && /^\s*-?\d+(\.\d+)?\s*%\s*$/.test(args.to)) return { dest: max * (parseFloat(args.to) / 100) };
  if (args.to != null) return { error: `fast_scroll: to must be top, bottom or a percentage like "50%" (got ${JSON.stringify(args.to)})` };
  if (typeof args.pixels === 'number' && Number.isFinite(args.pixels)) return { dest: top + args.pixels };
  if (args.pixels != null) return { error: 'fast_scroll: pixels must be a number (positive = down)' };
  const page = Math.max(1, Math.round(viewH - Math.min(SCROLL_OVERLAP_PX, viewH * 0.1)));
  return { dest: top + page, screenful: page };
};
// What a scroll actually did: how far it moved and whether it is now at the end
// it was moving toward (a second call would move nothing). Pure.
const scrollOutcome = (before, after, max, dest) => {
  const moved = Math.round(after - before);
  const down = dest >= before;
  return { moved, atEnd: down ? after >= max - 1 : after <= 0.5 };
};

// An autocomplete / combobox whose typed text no option was picked for holds NO
// value the app accepted: the input shows the text, the form's value is still
// empty (live: fast_fill "Zones":"Zone No.2" read the input back as the typed
// text and came back verified:true while the page's Zones value was ""). Such a
// write is NOT verified, whatever the input reads. `ac` is the open-suggestions
// report ({committed:false, suggestions, hint}) or null. Pure.
const commitGate = (head, ac) => {
  if (!ac || ac.committed !== false) return head;
  return {
    ...head, verified: false, committed: false,
    reason: `the text was typed but no option was picked — the input shows ${JSON.stringify(head.value ?? '')}, the page holds no committed value; do not report it as set`,
  };
};

// The head of a fast_fill {fields} result, from its per-field outcomes. ONE rule:
// verified only when every field was written, held, AND committed — a missed,
// reverted or uncommitted field makes the whole call verified:false (a batch
// step / report gate reads this head, so a green head over a failed field is a
// lie told to every check built on it). Each failed field is named in `summary`;
// an uncommitted one also carries its own hint (pick the option). Pure.
const rollUpFill = (fields, total) => {
  const keys = Object.keys(fields);
  const missedK = keys.filter(k => fields[k] && fields[k].error);
  const uncommitted = keys.filter(k => fields[k] && !fields[k].error && fields[k].committed === false);
  const reverted = keys.filter(k => fields[k] && !fields[k].error && fields[k].committed !== false && fields[k].verified !== true);
  const bad = missedK.length + uncommitted.length + reverted.length;
  const head = { verified: bad === 0, filled: total - missedK.length, missed: missedK.length, total };
  if (bad) {
    const parts = [];
    if (missedK.length) parts.push(`missed: ${missedK.join(', ')}`);
    if (uncommitted.length) parts.push(`typed but no option picked (NOT set): ${uncommitted.join(', ')}`);
    if (reverted.length) parts.push(`did not hold: ${reverted.join(', ')}`);
    head.summary = `${total - bad}/${total} verified; ${parts.join('; ')}`;
  }
  if (reverted.length) head.reverted = reverted;
  if (uncommitted.length) {
    head.uncommitted = uncommitted;
    head.hint = uncommitted.map(k => `${JSON.stringify(k)}: ${fields[k].hint || 'pick the option (fast_select_option)'}`).join(' | ') + ' (one field at a time)';
  }
  return head;
};

// A field the model still has to fill: text-like input / textarea / select /
// contenteditable with no value yet (checkbox, radio, button, file… excluded).
const NON_FILL_TYPES = new Set(['hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color']);
const isEmptyFillable = (el, entry) => {
  try {
    if (!entry.live) return false;
    if (entry.live === 'select') return !el.value;
    if (entry.tag === 'input' && NON_FILL_TYPES.has((entry.type || '').toLowerCase())) return false;
    return !(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : (el.textContent || '').trim());
  } catch { return false; }
};

// ─────────────────────── output trimming (rank + cap) ───────────────────────
// serializeSnapshot returns the FULL index (every matchable element) — that's
// what the internal fast_click/fast_fill match walks consume. capSnapshot is
// applied ONLY to the snapshot handed back to the model: it RANKS items so
// interactive controls + on-screen / above-the-fold elements come first and the
// long tail (dozens of footer/nav links far down the page) comes last, then CAPS
// to keep the payload small. A `truncated` count tells the model more exist;
// fast_snapshot's `full`/`limit` args bypass the cap for the complete set.
const ITEM_CAP_DEFAULT    = 70;   // explicit fast_snapshot default
const CONTENT_CAP_DEFAULT = 30;   // content text array default
const AUTO_ITEM_CAP       = 20;   // action-result preview: the controls around the action, not the page
const AUTO_CONTENT_CAP    = 3;
const RANK_INTERACTIVE_TAGS  = new Set(['input', 'button', 'select', 'textarea']);
const RANK_INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'option', 'menuitem', 'tab',
  'combobox', 'switch', 'textbox',
]);
const rankItemScore = (it, vh, vw) => {
  let r = 0;
  if (it.inOverlay || it.inDialog) r += 1000;               // open menu/dropdown/dialog items: always first
  if (it.clickable) r -= 10;                                 // script-only target: after real controls/links
  else if (RANK_INTERACTIVE_TAGS.has(it.tag)) r += 100;
  else if (it.tag === 'a' && it.text) r += 40;
  if (RANK_INTERACTIVE_ROLES.has((it.role || '').toLowerCase())) r += 50;
  const onScreen = it.y >= 0 && it.y <= vh && it.x >= 0 && it.x <= vw;
  if (onScreen) r += 60;                                     // in-viewport
  else if (it.y >= 0 && it.y < vh) r += 30;                  // above-the-fold-ish
  if (it.y > vh * 3) r -= 20;                                // deep long tail (footers)
  return r;
};
// Rank → keep top N (in rank order, so interactive/on-screen lead). Dropped
// counts accumulate in snap.dropped; markTruncated() turns them into the loud
// leading `truncated:true` block. Mutates and returns `snap`.
const noteDropped = (snap, key, n) => { if (n > 0) { snap.dropped = snap.dropped || {}; snap.dropped[key] = (snap.dropped[key] || 0) + n; } };
// `near` {x,y} (an action's target): an item or block closer to it ranks higher — an
// action's preview shows what surrounds what was acted on.
const nearPenalty = (o, near) => {
  if (!near || typeof o.x !== 'number') return 0;
  const cx = o.x + (o.w || 0) / 2, cy = o.y + (o.h || 0) / 2;
  return Math.hypot(cx - near.x, cy - near.y) / 5;
};
const capSnapshot = (snap, itemCap, contentCap, near = null) => {
  if (!snap || typeof snap !== 'object') return snap;
  const vh = window.innerHeight, vw = window.innerWidth;
  if (Array.isArray(snap.items) && itemCap >= 0 && snap.items.length > itemCap) {
    const ranked = snap.items
      .map((it, idx) => ({ it, idx, s: rankItemScore(it, vh, vw) - nearPenalty(it, near) }))
      .sort((a, b) => (b.s - a.s) || (a.idx - b.idx));
    noteDropped(snap, 'items', snap.items.length - itemCap);
    snap.items = ranked.slice(0, itemCap).map((x) => x.it);
    snap.count = snap.items.length;
  }
  if (Array.isArray(snap.content) && contentCap >= 0 && snap.content.length > contentCap) {
    const ranked = snap.content
      .map((c, idx) => ({ c, idx, s: (c.y >= 0 && c.y <= vh ? 100 : 0) - (c.y > vh * 3 ? 20 : 0) - nearPenalty(c, near) }))
      .sort((a, b) => (b.s - a.s) || (a.idx - b.idx));
    noteDropped(snap, 'content', snap.content.length - contentCap);
    snap.content = ranked.slice(0, contentCap).map((x) => x.c);
    snap.contentCount = snap.content.length;
  }
  return snap;
};

// Turn accumulated loss (count cap, byte cap, viewport-only skips) into the
// FIRST fields of the snapshot: { truncated:true, dropped:{items,content,
// offscreen,textTrimmed}, hint } — a model reading top-down cannot miss that
// the view is partial, and the hint names the exact call that returns the rest.
// Returns a NEW object (key order matters), or `snap` untouched when complete.
// Frames this document does not read itself but the user SEES: iframes whose
// document is closed to the page (cross-origin) or has its own http(s) URL
// (ownedFrameDoc), on screen, at least FRAME_NOTICE_MIN in size. The background
// reads them (frames.js); the ones it cannot are named up front — live: the
// Azure portal's whole body is a cross-origin blade, fast_snapshot came back
// header-only and the model burned 56s on waits for text plainly on screen,
// then reported "page never rendered". Reads only the <iframe> elements' own
// src and box from the top document: no injection. Bounded for pages with tens
// of thousands of iframes: a lazy element collection, a scan cap and a clock,
// zero-size frames skipped before anything else is read. Pure given (doc, win).
const FRAME_NOTICE_MIN = { w: 100, h: 50 };
const FRAME_NOTICE_LIST = 4;
const FRAME_SCAN_MAX = 3000, FRAME_SCAN_MS = 25;
const opaqueFrames = (doc = document, win = window) => {
  const out = [];
  let scanned = 0, partial = false;
  try {
    const vw = win.innerWidth || 0, vh = win.innerHeight || 0;
    const t0 = Date.now();
    for (const tag of ['iframe', 'frame']) {
      const els = doc.getElementsByTagName(tag);
      for (let i = 0; i < els.length; i++) {
        if (++scanned > FRAME_SCAN_MAX || ((scanned & 63) === 0 && Date.now() - t0 > FRAME_SCAN_MS)) { partial = true; break; }
        const el = els[i];
        const r = el.getBoundingClientRect();
        if (r.width < FRAME_NOTICE_MIN.w || r.height < FRAME_NOTICE_MIN.h) continue;
        if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
        if (ownedFrameDoc(el)) continue;   // read here, as part of this document
        try { const cs = win.getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue; } catch {}
        let origin = '';
        try { origin = new URL(el.getAttribute('src') || '', doc.baseURI).origin; } catch {}
        // src + cx/cy (the frame's content-box origin in this viewport) are for the
        // background's frame reach (frames.js); notices show only origin and box
        let src = '';
        try { src = new URL(el.getAttribute('src') || '', doc.baseURI).href; } catch {}
        out.push({ origin: origin && origin !== 'null' ? origin : '(unknown origin)', x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
          src, cx: r.left + (el.clientLeft || 0), cy: r.top + (el.clientTop || 0) });
      }
      if (partial) break;
    }
  } catch {}
  out.sort((a, b) => b.w * b.h - a.w * a.h);
  return { frames: out, partial };
};
// "<origin> at x, y, WxH; …" for up to FRAME_NOTICE_LIST frames. Pure.
const frameList = (frames) => {
  const shown = frames.slice(0, FRAME_NOTICE_LIST).map((f) => `${f.origin} at ${f.x},${f.y} ${f.w}x${f.h}`);
  const more = frames.length > shown.length ? ` and ${frames.length - shown.length} more` : '';
  return `${shown.join('; ')}${more}`;
};
// The sentence a snapshot leads with for frames DOM tools could NOT read. The
// background reads every frame it can (frames.js) and keeps this only for the
// rest, so it does not steer toward coordinates: models cannot point reliably
// (live: three Grok models missed a 450x23 box on the same screenshot). Pure.
const frameNotice = ({ frames }) => {
  if (!frames || !frames.length) return '';
  return `${frames.length} frame(s) DOM tools cannot read: ${frameList(frames)} (visible in fast_screenshot only)`;
};
// Lead a snapshot result with the notice (a fresh scan). Returns `out` unchanged when none.
const noticeBoxes = (frames) => frames.slice(0, FRAME_NOTICE_LIST).map(({ origin, x, y, w, h }) => ({ origin, x, y, w, h }));
const withFrameNotice = (out) => {
  if (!out || typeof out !== 'object' || NO_FRAME_NOTICE.on) return out;
  const scan = opaqueFrames();
  const notice = frameNotice(scan);
  if (!notice) return out;
  return frontload(out, { frameNotice: notice, opaqueFrames: noticeBoxes(scan.frames) });
};

// `preview` (an action's auto-snapshot): the same counts under `omitted`, with no
// `truncated` flag — a preview is bounded by design and lists what to act on; the
// "truncated:true → read again before acting" rule belongs to a fast_snapshot the caller
// asked for (live df6a2ba2: a wait hit carried the frame's fields, its preview said
// truncated:true, and the model spent a turn re-reading before acting).
const markTruncated = (snap, hintFor, { preview = false } = {}) => {
  if (!snap || typeof snap !== 'object') return snap;
  const d = snap.dropped || {};
  const off = snap.offscreenItems || 0;
  delete snap.dropped; delete snap.offscreenItems;
  if (!(d.items || d.content || d.textTrimmed || off)) {
    if (preview) { const { url, title, ...body } = snap; return withFrameNotice(body); }
    return withFrameNotice(snap);
  }
  const dropped = { ...d };
  if (off) dropped.offscreen = off;
  const parts = [hintFor(dropped)];
  if (snap.hint) parts.push(snap.hint);
  delete snap.hint;   // serializeSnapshot emits hint:undefined — spreading it would erase ours
  if (preview) {
    // a preview says how much it left out, nothing more (the runner explains `omitted`)
    const { url, title, ...body } = snap;
    return withFrameNotice(parts.length > 1 ? { omitted: dropped, hint: parts.slice(1).join(' | '), ...body } : { omitted: dropped, ...body });
  }
  return withFrameNotice({ truncated: true, dropped, hint: parts.join(' | '), ...snap });
};
const offscreenHint = (d) => d.offscreen
  ? `${d.offscreen} interactive element(s) are outside the viewport (below/above the fold) and NOT listed — call fast_snapshot without viewport:true, or fast_scroll, before concluding a control is absent`
  : '';
const explicitHint = (d) => [
  (d.items || d.content) ? `capped view: ${d.items || 0} item(s) / ${d.content || 0} content block(s) not shown — call fast_snapshot with full:true for everything, or limit:N for more items` : '',
  offscreenHint(d),
].filter(Boolean).join('; ');
const autoHint = (d) => [
  (d.items || d.content || d.textTrimmed) ? `auto-snapshot preview capped (~${AUTO_SNAP_MAX_CHARS} chars): ${d.items || 0} item(s) / ${d.content || 0} content block(s) not shown${d.textTrimmed ? ', long texts trimmed' : ''} — pass full:true or limit:N on the action, or call fast_snapshot (full:true) before reporting` : '',
  offscreenHint(d),
].filter(Boolean).join('; ');

// Byte cap for the AUTO-snapshot attached to action results (fast_click / fill /
// wait / select …). The count caps above leave click results at ~37k chars on
// text-heavy pages (Wikipedia, GCP) — ~0.9s of fresh prefill per model turn, per
// the Grok latency profile — because a single content block can be 500 chars.
// Order of loss: content text trimmed → content blocks dropped from the (ranked)
// tail → item text trimmed → items dropped from the tail, never below
// AUTO_MIN_ITEMS. Item ids (`i`) and geometry are never touched, so a caller can
// still act on anything listed. Loss is recorded in snap.dropped for
// markTruncated().
const AUTO_SNAP_MAX_CHARS = 4000;
const AUTO_MIN_ITEMS      = 8;
const SETTLE_MAX_MS       = 1000;  // post-action DOM-quiet wait before the auto-snapshot
const AUTO_WAIT_MS        = 1500;  // fill/click/select keep looking for a missing target this long
const AUTO_TEXT_TRIM      = 100;   // content block text after the first trim pass
const AUTO_ITEM_TEXT_TRIM = 60;    // item text/innerText after the item trim pass
const byteCapSnapshot = (snap, max = AUTO_SNAP_MAX_CHARS) => {
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.items)) return snap;
  const size = () => { try { return JSON.stringify(snap).length; } catch { return 0; } };
  let trimmed = false, droppedContent = 0, droppedItems = 0;
  if (size() > max && Array.isArray(snap.content)) {
    for (const c of snap.content) if (c.text && c.text.length > AUTO_TEXT_TRIM) { c.text = c.text.slice(0, AUTO_TEXT_TRIM) + '…'; trimmed = true; }
    while (snap.content.length && size() > max) { snap.content.pop(); droppedContent++; }
  }
  if (size() > max) {
    for (const it of snap.items) {
      if (it.text && it.text.length > AUTO_ITEM_TEXT_TRIM) { it.text = it.text.slice(0, AUTO_ITEM_TEXT_TRIM) + '…'; trimmed = true; }
      if (it.innerText && it.innerText.length > AUTO_ITEM_TEXT_TRIM) { it.innerText = it.innerText.slice(0, AUTO_ITEM_TEXT_TRIM) + '…'; trimmed = true; }
    }
    while (snap.items.length > AUTO_MIN_ITEMS && size() > max) { snap.items.pop(); droppedItems++; }
  }
  noteDropped(snap, 'items', droppedItems);
  noteDropped(snap, 'content', droppedContent);
  if (trimmed) { snap.dropped = snap.dropped || {}; snap.dropped.textTrimmed = true; }
  snap.count = snap.items.length;
  if (Array.isArray(snap.content)) snap.contentCount = snap.content.length;
  return snap;
};
// The action-result preview: count caps, then the byte cap, then the leading
// truncated block. `full:true` on the action returns the whole serialize
// uncapped (only viewport-only loss can remain); `limit:N` overrides the item cap.
// Returns a possibly NEW object — always assign the return value.
const capAutoSnapshot = (snap, args, near = null) => {
  if (args && (args.full === true || args.full === 'true')) return markTruncated(snap, autoHint, { preview: true });
  const itemCap = (args && typeof args.limit === 'number' && args.limit >= 0) ? args.limit : AUTO_ITEM_CAP;
  capSnapshot(snap, itemCap, AUTO_CONTENT_CAP, near);
  return markTruncated(byteCapSnapshot(snap), autoHint, { preview: true });
};
// Rebuild `obj` with `head`'s keys first (JSON key order = what the model reads first).
const frontload = (obj, head) => {
  const out = { ...head };
  for (const k of Object.keys(obj)) if (!(k in head)) out[k] = obj[k];
  return out;
};

// Look up an element by snapshot id. Stable for the page's lifetime.
const elById = (id) => INDEX.byId.get(id);

// ──────────────────────────── action dispatch ────────────────────────────

async function runPageAction(action, args) {
 try {
  initIndex();
  // Re-arm the observer (after idle-suspend / build it lazily on first call)
  // and stamp activity so idle-suspend measures from this call.
  armObserver();

  // Match-ranking & helpers used by multiple actions.
  const matchScore = (it, t) => {
    const inT = (s) => s && s.toLowerCase().includes(t);
    let score = 0;
    if (inT(it.innerText))   score = Math.max(score, 4);
    if (inT(it.label))       score = Math.max(score, 3);
    if (inT(it.placeholder)) score = Math.max(score, 3);
    if (inT(it.name))        score = Math.max(score, 2);
    if (inT(it.ariaLabel))   score = Math.max(score, 1);
    if (inT(it.title))       score = Math.max(score, 0.5);
    if (score === 0 && inT(it.text)) score = 0.25;
    // Type preference: nudge real interactive CONTROLS above generic links/text
    // when scores are close. Without this a plain <a>"External" (innerText=4)
    // outranks the radio whose name "External" comes from a <label> (label=3).
    // Additive (CONTROL_BONUS crosses ~one tier), never a hard override.
    if (score > 0 && isControlItem(it)) score += CONTROL_BONUS;
    // A script-only target (no-href <a>, cursor:pointer text) always ranks BELOW
    // every real control/link match (min real score 0.25 > max weak 0.04), but is
    // still a candidate — never "nothing to click" when it carries the text.
    if (it.clickable) score *= 0.01;
    return score;
  };
  const matchItems = (items, text) => {
    const t = (text || '').toLowerCase();
    if (!t) return [];
    const scored = [];
    for (const it of items) {
      const s = matchScore(it, t);
      if (s > 0) scored.push({ it, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.map(x => x.it);
  };
  const elAt = (it) => elById(it.i) || document.elementFromPoint(it.x + it.w / 2, it.y + it.h / 2);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // Stable DOM-order comparator on snapshot items. Used wherever an explicit
  // `index` disambiguates repeated matches — rank order shuffles when sibling
  // sections re-render, so index:N must address a fixed document-order slot.
  // Falls back to visual top→bottom / left→right when the elements live in
  // different trees (iframe/shadow → compareDocumentPosition is DISCONNECTED).
  const docOrderCmp = (a, b) => {
    const ea = elById(a.i), eb = elById(b.i);
    if (ea && eb && ea !== eb) {
      try {
        const pos = ea.compareDocumentPosition(eb);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      } catch {}
    }
    return (a.y - b.y) || (a.x - b.x);
  };

  // When a matched element is a descendant link (or a link sharing a <label>)
  // inside a matched CONTROL with the same text, the inner <a> competes with the
  // real control and can win — e.g. a checkbox beside "I agree to the
  // <a>Policy</a>", or a radio named "External" wrapping an <a>External</a>.
  // Drop the redundant plain link so the control is reachable by its label text.
  const dropRedundantDescendantLinks = (list) => {
    if (list.length < 2) return list;
    const els = new Map();
    for (const it of list) els.set(it, elById(it.i));
    return list.filter((it) => {
      if (it.tag !== 'a' || isControlItem(it)) return true;   // only plain links
      const el = els.get(it);
      if (!el) return true;
      const lbl = (el.closest && el.closest('label')) || null;
      for (const other of list) {
        if (other === it || !isControlItem(other)) continue;
        const oe = els.get(other);
        if (!oe || oe === el) continue;
        // control contains the link, OR both sit under the same wrapping <label>.
        if (oe.contains(el) || (lbl && lbl.contains(oe))) return false;
      }
      return true;
    });
  };

  // Auto-attach a fresh viewport snapshot to action returns so callers don't
  // have to follow every fast_click / fast_fill / etc. with a separate
  // fast_snapshot. Yields one requestAnimationFrame so click handlers, Angular
  // zones, React effects, etc. have a chance to mutate before we serialize.
  // Opt-out per call with args.noSnapshot. Skipped on error returns and when
  // an action already returns its own snapshot.
  const withSnap = async (result, preSnap, { settleMs = SETTLE_MAX_MS } = {}) => {
    if (!result || typeof result !== 'object') return result;
    // noSnapshot opt-out — coerce defensively: a param not declared in the tool's
    // inputSchema can reach us STRINGIFIED (e.g. the string "false", which is
    // truthy and would wrongly suppress the snapshot the caller asked for). Treat
    // only a genuine true / "true" / 1 as opt-out; false / "false" / 0 / unset all
    // mean "include the snapshot".
    const noSnapOptOut = args.noSnapshot === true || args.noSnapshot === 'true' || args.noSnapshot === 1;
    if (result.error || result.snapshot || noSnapOptOut) return result;
    // Yield ~one frame so click handlers / framework effects settle before we
    // serialize — but NEVER hang on it. requestAnimationFrame is FROZEN in a
    // backgrounded / occluded tab (the relay drives exactly such tabs: the
    // claude.ai tab is foreground while the target tab is hidden), so the rAF
    // callback may never fire and the bare `await requestAnimationFrame` would
    // stall withSnap — and therefore the whole action — until the 30s broker/
    // relay timeout, even though the action (e.g. a fill) already completed.
    // Race the frame against a wall-clock cap so a foreground tab still waits a
    // real frame while a hidden tab falls through promptly. (BUG-4)
    await Promise.race([
      new Promise(r => (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame(() => r())
        : setTimeout(r, 0)),
      // Hard cap. Background tabs clamp setTimeout to ~1s, which is the effective
      // bound here — still orders of magnitude under the 30s tool timeout — so a
      // hidden tab whose rAF never fires falls through instead of hanging.
      new Promise(r => setTimeout(r, 250)),
    ]);
    // Then let the re-render the action triggered finish (DOM quiet for 150ms,
    // ≤ SETTLE_MAX_MS) so the snapshot shows the result of the action, not the
    // frame before it. A page still mutating at the cap is flagged `settling`.
    const tSettle = nowMs();
    // With no observer recording, settleDom has no mutation signal and returns at once —
    // serializing the DOM from BEFORE what the action set off (a panel closing still listed its
    // options). Give the page a fixed 150ms instead, only in that state.
    if (!observerLive()) await wait(Math.min(150, settleMs));
    const settle = await settleDom(settleMs);
    phase('settleMs', nowMs() - tSettle);
    // FRESH POST-ACTION SNAPSHOT (field-feedback #1): re-walk the DOM AFTER the
    // action settles so the returned snapshot reflects what the action DID — a
    // dropdown it opened, a framework re-render, a revealed panel — instead of the
    // match-time (pre-action) DOM. This removes the recurring need to fire a second
    // fast_snapshot right after every click/fill, which was the single biggest
    // round-trip tax on form-heavy flows. The match-time snapshot (preSnap, the
    // FULL serialize the action did to FIND its target) is kept only as a FALLBACK
    // for when the fresh walk can't run: a navigating click that tore the frame
    // down, or a heavy page whose serialize bailed empty. We accept the second
    // (viewport-only, time-boxed) walk — fewer round-trips beats one cheaper call.
    const hasPre = preSnap && typeof preSnap === 'object' && Array.isArray(preSnap.items) && preSnap.items.length > 0;
    // where the action happened: the clicked item, else the focused control
    let near = null;
    try {
      const c = result.clicked;
      if (c && typeof c.x === 'number') near = { x: c.x + (c.w || 0) / 2, y: c.y + (c.h || 0) / 2 };
      else if (document.activeElement && document.activeElement !== document.body) {
        const ar = document.activeElement.getBoundingClientRect(); const off = offsetFor(document.activeElement);
        near = { x: ar.x + off.ox + ar.width / 2, y: ar.y + off.oy + ar.height / 2 };
      }
    } catch {}
    const attachStale = (res) => {
      try {
        const vh = window.innerHeight, vw = window.innerWidth;
        const inView = (it) => !!it.inOverlay || !(it.y + it.h < 0 || it.y > vh || it.x + it.w < 0 || it.x > vw);
        const items = preSnap.items.filter(inView);
        const content = Array.isArray(preSnap.content) ? preSnap.content.filter(inView) : [];
        res.snapshot = capAutoSnapshot(
          { ...preSnap, count: items.length, items, contentCount: content.length, content },
          args, near,
        );
        res.snapshotStale = true; // match-time DOM: the fresh post-action walk was unavailable
        if (preSnap.snapshotTimedOut || preSnap.partial || preSnap.capped) {
          res.snapshotPartial = true;
          if (preSnap.snapshotTimedOut) res.snapshotTimedOut = true;
          if (preSnap.capped) res.snapshotNote = 'page too heavy — viewport-only / partial index returned';
        }
      } catch { res.snapshot = preSnap; res.snapshotStale = true; }
      return res;
    };
    // The auto-snapshot is a convenience, never the point of the call. Bound it
    // and swallow failures so a slow/huge serialize can NEVER turn a successful
    // action into a broker timeout. On overrun whatever partial was gathered is
    // returned with snapshotTimedOut:true so the agent still has rich text.
    try {
      // Time-boxed + abortable: serialize yields the main thread every SLICE_MS
      // and bails at budgetMs, so a heavy page can't turn a click/fill into a 30s
      // timeout or freeze the renderer. drainMs first flushes the mutations the
      // action just produced so they appear in THIS fresh walk.
      const tSer = nowMs();
      const snap = await serializeSnapshot(true, { budgetMs: 2000, drainMs: 30, indexMs: 1500 });
      phase('serializeMs', nowMs() - tSer);
      // A navigating click can tear the page down so the fresh walk returns empty
      // — fall back to the match-time snapshot rather than returning nothing.
      if ((!snap || !Array.isArray(snap.items) || snap.items.length === 0) && hasPre) {
        attachStale(result);
      } else {
        result.snapshot = capAutoSnapshot(snap, args, near);
        result.snapshotFresh = true; // post-action capture: reflects what the action did
        if (snap && (snap.snapshotTimedOut || snap.partial || snap.capped)) {
          result.snapshotPartial = true;
          if (snap.snapshotTimedOut) result.snapshotTimedOut = true;
          if (snap.capped) result.snapshotNote = 'page too heavy — viewport-only / partial index returned';
        }
      }
    } catch (e) {
      // Fresh serialize failed — fall back to the match-time snapshot if we have
      // one, else no snapshot.
      if (hasPre) attachStale(result);
      else {
        result.snapshot = null;
        result.snapshotPartial = true;
        result.snapshotNote = 'snapshot skipped — page too heavy to serialize';
      }
    }
    // A navigating click returns the about-to-unload page (or its stale fallback);
    // flag that the real destination needs a post-load read.
    if (result.willNavigate) {
      result.snapshotNote = 'navigation triggered — this snapshot may be the pre-navigation page; call fast_snapshot after the new page loads';
    }
    if (!settle.settled || pageActivity().settling) {
      const settleHint = `page was still changing when this snapshot was taken (waited ${settle.waitedMs}ms) — the view below may be incomplete; fast_wait for text that identifies the finished state before reading or reporting`;
      return frontload(result, { settling: true, hint: result.hint ? `${result.hint} | ${settleHint}` : settleHint });
    }
    return result;
  };

  // Compact description of one element for result heads (focused element,
  // key target): tag + the names a model can act on + the live value.
  const describeEl = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const o = { tag: el.tagName.toLowerCase() };
    try {
      if (el === document.body) return o;
      indexElement(el);
      const e = INDEX.byEl.get(el);
      if (e) {
        if (e.role) o.role = e.role;
        if (e.label) o.label = e.label;
        if (e.ariaLabel) o.ariaLabel = e.ariaLabel;
        if (e.placeholder) o.placeholder = e.placeholder;
        if (e.name) o.name = e.name;
        if (e.live) { refreshLiveEntry(el, e); o.value = e.value == null ? '' : String(e.value).slice(0, 200); }
        else if (e.text) o.text = e.text.slice(0, 80);
      }
      if (el.id) o.id = el.id;
    } catch {}
    return o;
  };
  // Live value of a filled control, as the page holds it now (password masked).
  const liveValueOf = (el) => {
    if (!el) return null;
    if (el.tagName === 'SELECT') { const o = el.selectedOptions ? el.selectedOptions[0] : el.options[el.selectedIndex]; return o ? cleanLabel(o.text || o.value || '') : ''; }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value == null ? '' : String(el.value);
    return (el.innerText || el.textContent || '');
  };
  const maskIfPassword = (el, v) => (el && el.type === 'password') ? '•'.repeat(Math.min(String(v).length, 32)) : v;

  const flashEl = (el, label) => {
    try {
      if (!el || !el.style) return;
      const prev = { outline: el.style.outline, outlineOffset: el.style.outlineOffset, boxShadow: el.style.boxShadow };
      el.style.outline = '2px solid #5cc8ff';
      el.style.outlineOffset = '2px';
      el.style.boxShadow = '0 0 0 4px rgba(92,200,255,0.25)';
      let tagEl = null;
      try {
        const r = el.getBoundingClientRect();
        // The chip is fixed-positioned on the outer document, so an iframe-local
        // rect needs the frame offset added to land in outer-page coords.
        const { ox, oy } = offsetFor(el);
        tagEl = document.createElement('div');
        tagEl.__fastlinkChip = true;   // never indexed, never counted as page activity
        tagEl.textContent = label || '';
        tagEl.style.cssText = `position:fixed;left:${Math.max(0,r.x+ox)}px;top:${Math.max(0,r.y+oy-18)}px;background:#5cc8ff;color:#0b0d12;font:11px/1 -apple-system,BlinkMacSystemFont,sans-serif;font-weight:600;padding:2px 5px;border-radius:4px;z-index:2147483647;pointer-events:none;`;
        document.documentElement.appendChild(tagEl);
      } catch {}
      setTimeout(() => {
        try { el.style.outline = prev.outline; el.style.outlineOffset = prev.outlineOffset; el.style.boxShadow = prev.boxShadow; } catch {}
        if (tagEl) try { tagEl.remove(); } catch {}
      }, 700);
    } catch {}
  };

  const isFillable = (it) => {
    // Native <select> is fillable: fillItem matches the value against option
    // text/value and sets it. Lets fast_fill / fast_fill_form set native
    // dropdowns alongside text inputs in one call.
    if (it.tag === 'input' || it.tag === 'textarea' || it.tag === 'select') return true;
    const el = elAt(it);
    return el ? (el.isContentEditable || el.getAttribute('role') === 'textbox') : false;
  };
  const fieldMatchesText = (it, m) =>
    (it.placeholder && it.placeholder.toLowerCase().includes(m)) ||
    (it.label       && it.label.toLowerCase().includes(m)) ||
    (it.ariaLabel   && it.ariaLabel.toLowerCase().includes(m)) ||
    (it.name        && it.name.toLowerCase().includes(m)) ||
    (it.text        && it.text.toLowerCase().includes(m));
  // EXACT field match (label / aria / placeholder / name equal, not substring).
  // Preferred over the loose substring match so "URIs 1" doesn't grab "URIs 10"
  // or a different section's "URIs" field.
  const fieldMatchesExact = (it, m) =>
    (it.label       && it.label.toLowerCase() === m) ||
    (it.ariaLabel   && it.ariaLabel.toLowerCase() === m) ||
    (it.placeholder && it.placeholder.toLowerCase() === m) ||
    (it.name        && it.name.toLowerCase() === m);
  // ─────────────────────────── section scoping ───────────────────────────
  // `section` (alias `near`) restricts candidate fields to one titled group, so a
  // repeated label ("URIs 1" under BOTH "Authorized JavaScript origins" and
  // "Authorized redirect URIs" on GCP's Create-OAuth-client form) can be targeted
  // by section instead of a guessed occurrence index.
  //
  // Sections are resolved by DOCUMENT OUTLINE, never by ancestry:
  //  • closest() cannot work — on Angular Material / GCP's cfc-form-stack the
  //    <fieldset> that holds the <legend> contains ZERO inputs; the fields render
  //    outside it.
  //  • "nearest preceding heading" alone cannot work either — GCP emits an
  //    <h3>"Item 1" per URI row directly above each input, so the nearest heading
  //    is that sub-heading and NO field ever resolved into the requested section.
  // A section therefore spans from its anchor until the next anchor of the SAME OR
  // HIGHER level (an <h2> ends an <h2> section; a nested <h3> does not), which is
  // the standard outline rule and puts each "Item 1" row in its parent section.
  const SECTION_ANCHORS = 'h1,h2,h3,h4,h5,h6,legend,[role="heading"]';
  const MAX_ANCHORS = 400;
  // A heading's text as a section NAME: the permalink glyph docs generators append
  // (Sphinx/MkDocs "¶", "§", "🔗", "⚓", a spaced or zero-width-joined "#") is not
  // part of it — select2.org's "Single select boxes¶" came back as the field name.
  const PERMALINK_TAIL = /(?:[\s​]*[¶§🔗⚓])+$|[\s​]+#$/u;
  const stripPermalink = (s) => String(s || '').replace(PERMALINK_TAIL, '').replace(/​/g, '').trim();
  const headingTitle = (a) => stripPermalink(cleanLabel(a.textContent)).slice(0, 80);
  const anchorLevel = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag.length === 2 && tag[0] === 'h' && tag[1] >= '1' && tag[1] <= '6') return +tag[1];
    const lvl = parseInt(el.getAttribute('aria-level') || '', 10);
    if (lvl >= 1 && lvl <= 6) return lvl;
    return 2;   // <legend> / [role=heading] with no level: section-level
  };
  const follows = (a, b) => {   // b strictly after a in document order
    try { return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); } catch { return false; }
  };
  // Fillable controls, resolved from the LIVE DOM rather than filtered out of the
  // snapshot: a heavy page (GCP) forces snapshots viewport-only, so a section
  // below the fold would otherwise look empty. Main document only — section
  // membership is a document-order test, and compareDocumentPosition across a
  // shadow root / iframe boundary returns DISCONNECTED with an ARBITRARY
  // ordering bit, which could place a field in the wrong section. One selector
  // query, no '*' walk.
  const FILLABLE_SEL = 'input:not([type="hidden"]),textarea,select,[contenteditable="true"],[contenteditable=""],[role="textbox"]';
  // Dropdown-ish controls, for fast_select_option's titled-section lookup.
  const DROPDOWN_SEL = 'select,[role="combobox"],[role="listbox"],input[id^="react-select-"],[aria-haspopup="listbox"],[aria-haspopup="menu"],[aria-haspopup="true"]';
  const MAX_SECTION_FIELDS = 500;
  // Visibility of a FIELD, not its input: a widget's invisible typing input is
  // visible when its widget box is (hiddenInputBox).
  const fieldVisible = (el, rect) => visible(el, rect) || !!hiddenInputBox(el);
  // Resolve a section request. ALWAYS returns a report — callers must NOT fall
  // back to the unscoped pool on a miss (a silent wrong-field write is worse than
  // an error), which is exactly what the old `if (scoped.length)` guard did.
  //   { matched: n, sections: [every section title on the page], items: [scoped
  //     VISIBLE controls, indexed], els: [every `sel` element in the span, hidden
  //     ones included — only with opts.hidden], inSpan(el) }
  const resolveSection = (wantRaw, sel = FILLABLE_SEL, opts = {}) => {
    const wantLo = stripPermalink(String(wantRaw || '').toLowerCase());
    let anchors;
    try { anchors = Array.from(document.querySelectorAll(SECTION_ANCHORS)).slice(0, MAX_ANCHORS); }
    catch { anchors = []; }
    const sections = [];
    for (const a of anchors) {
      const t = headingTitle(a);
      if (t && !sections.includes(t)) sections.push(t);
    }
    const matched = wantLo ? anchors.filter(a => headingTitle(a).toLowerCase().includes(wantLo)) : [];
    if (!matched.length) return { matched: 0, sections, items: [], els: [], inSpan: () => false };
    // Span end = the first LATER anchor at the same-or-higher level that is not
    // nested inside this one. The nested test merges GCP's <h2> rendered INSIDE
    // its own <legend> (same title, twice) instead of yielding a zero-width span.
    // querySelectorAll order is document order, so index order is span order.
    const spans = matched.map((a) => {
      const lvl = anchorLevel(a);
      let end = null;
      for (let j = anchors.indexOf(a) + 1; j < anchors.length; j++) {
        const b = anchors[j];
        if (a.contains(b) || anchorLevel(b) > lvl) continue;
        end = b; break;
      }
      return { start: a, end };
    });
    const inAnySpan = (el) => (el.getRootNode ? el.getRootNode() === document : true)
      && spans.some(({ start, end }) =>
        (start.contains(el) || follows(start, el)) && (!end || follows(el, end)));
    let fillable;
    try { fillable = Array.from(document.querySelectorAll(sel)).slice(0, MAX_SECTION_FIELDS); }
    catch { fillable = []; }
    const items = [], els = [];
    for (const el of fillable) {
      if (!inAnySpan(el)) continue;
      if (opts.hidden) els.push(el);
      let rect; try { rect = el.getBoundingClientRect(); } catch { continue; }
      if (!fieldVisible(el, rect)) continue;     // hidden fields are not fillable targets
      indexElement(el);                           // stable id + a fresh (live-value) entry
      const entry = INDEX.byEl.get(el);
      if (!entry || entry.kind !== 'click') continue;
      const off = offsetFor(el);
      items.push({
        i: entry.id, tag: entry.tag, role: entry.role, text: entry.text,
        label: entry.label, placeholder: entry.placeholder, ariaLabel: entry.ariaLabel,
        name: entry.name, value: entry.value,
        x: Math.round(rect.x + off.ox), y: Math.round(rect.y + off.oy),
        w: Math.round(rect.width), h: Math.round(rect.height),
      });
    }
    return { matched: matched.length, sections, items, els, inSpan: inAnySpan };
  };
  // A heading/legend whose text IS `name` (a trailing ":" / "*" / "(…)" ignored):
  // the name belongs to an outline section, not to a field still mounting.
  // Returns that heading's title, else null. One selector query.
  const normHeading = (s) => stripPermalink(cleanLabel(s)).toLowerCase().replace(/\s*\([^)]*\)$/, '').replace(/[\s:*]+$/, '');
  const sectionTitleFor = (name) => {
    let anchors; try { anchors = document.querySelectorAll(SECTION_ANCHORS); } catch { return null; }
    const want = normHeading(name);
    if (!want) return null;
    for (let i = 0; i < anchors.length && i < MAX_ANCHORS; i++) {
      const t = headingTitle(anchors[i]);
      if (t && normHeading(t) === want) return t;
    }
    return null;
  };
  // ─────────────────────────── repeated row groups ───────────────────────────
  // A data grid / repeatable section: the SAME field labels repeat once per row
  // (Form.io "Children": First Name / Gender / Birthdate per row). The row of `el`
  // = its nearest ancestor whose same-shaped siblings (tag + class tokens, state
  // and numbered tokens ignored) hold a form field sharing a label with it. A form's
  // field groups never qualify (each holds a DIFFERENT label). null when not in rows.
  const ROW_STATE_TOKEN = /^(?:is-|has-)|hidden|none|active|selected|open|show|collapse|visible|invisible|disabled|error|invalid|valid|focus|hover|even|odd|first|last/i;
  const rowSig = (el) => el.tagName + '|' + Array.from(el.classList || []).filter(c => !ROW_STATE_TOKEN.test(c)).map(c => c.replace(/\d+/g, '#')).sort().join(' ');
  // BOUNDED + MEMOIZED, per page action. A row scan must cost more only as a ROW
  // grows, never as the PAGE does. Before these bounds rowContextOf re-walked
  // ancestor subtrees that grew toward the whole document, and resolved every
  // field's label with two document-wide querySelector('label[for=…]') calls, so
  // its cost was O(fields × document) and it ran 3-6× per element per action —
  // on a console SPA that alone blew fast_select_option's 20s deadline (2026-09-15).
  const ROW_SCAN_NODES = 1500;   // nodes visited inside one candidate row before it is "not a row"
  const ROW_MAX_SIBS   = 200;    // children examined while looking for same-shaped siblings
  const ROW_FIELD_CAP  = 60;     // fields read per candidate row
  const ROW_KEY_CAP    = 40;     // distinct labels compared per row
  const rowCtxCache = new WeakMap();
  // ONE label[for] map per invocation, shared by every fieldKey.
  let rowForMap = null;
  const rowForLookup = (el) => {
    if (!rowForMap) {
      rowForMap = new Map();
      try { for (const l of document.querySelectorAll('label[for]')) if (!rowForMap.has(l.htmlFor)) rowForMap.set(l.htmlFor, cleanLabel(l.textContent)); } catch {}
    }
    return el.id && rowForMap.has(el.id) ? rowForMap.get(el.id) : null;
  };
  const fieldKey = (el) => {
    try {
      const l = cleanLabel(labelFor(el, rowForLookup) || el.getAttribute('aria-label') || '').toLowerCase();
      return l || String(el.getAttribute('name') || '').replace(/\d+/g, '#').toLowerCase();
    } catch { return ''; }
  };
  // Fillable fields inside `root`, document order, DFS under a hard node budget.
  // null = this subtree is already too big to be one row.
  const fieldsWithin = (root, cap = ROW_FIELD_CAP) => {
    const out = [];
    let seen = 0;
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n !== root) {
        if (++seen > ROW_SCAN_NODES) return null;
        try { if (n.matches(FILLABLE_SEL)) { out.push(n); if (out.length >= cap) return out; } } catch {}
      }
      const kids = n.children;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  };
  const fieldKeys = (root) => {
    const fields = fieldsWithin(root);
    if (!fields) return null;
    const keys = new Set();
    for (const f of fields) { const k = fieldKey(f); if (k) keys.add(k); if (keys.size >= ROW_KEY_CAP) break; }
    return keys;
  };
  const computeRowContext = (el) => {
    let a = el;
    for (let hops = 0; a && a.parentElement && hops < 16; hops++, a = a.parentElement) {
      const p = a.parentElement;
      if (p === document.body || p === document.documentElement) break;
      const sig = rowSig(a);
      const rows = [];
      let scanned = 0;
      for (const c of p.children) {
        if (++scanned > ROW_MAX_SIBS) break;
        if (c === a || rowSig(c) === sig) rows.push(c);
        if (rows.length > 80) break;
      }
      if (rows.length < 2) continue;
      const keys = fieldKeys(a);
      if (keys === null) break;   // already bigger than any row — so is every higher hop
      if (!keys.size) continue;
      const shares = (r) => {
        const fields = fieldsWithin(r);
        if (!fields) return false;
        for (const f of fields) if (keys.has(fieldKey(f))) return true;
        return false;
      };
      if (rows.slice(0, 20).some(r => r !== a && shares(r))) return { row: a, rows, index: rows.indexOf(a) };
    }
    return null;
  };
  const rowContextOf = (el) => {
    if (!el) return null;
    if (rowCtxCache.has(el)) return rowCtxCache.get(el);
    const ctx = computeRowContext(el);
    rowCtxCache.set(el, ctx);
    return ctx;
  };
  // What tells a row apart for a person: its first non-empty field value (first
  // name, an id), else the start of its text.
  const rowFirstValue = (row) => {
    try {
      for (const f of row.querySelectorAll(FILLABLE_SEL)) {
        if (f.tagName === 'INPUT' && /^(checkbox|radio|button|submit|hidden)$/i.test(f.type || '')) continue;
        if (typeof f.checkVisibility === 'function' && !f.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
        const v = cleanLabel(String(liveValueOf(f) || ''));
        if (v) return v.slice(0, 40);
      }
      return shownValueOf(row).slice(0, 40) || '(empty row)';
    } catch { return ''; }
  };
  const rowInfoOf = (el) => {
    const ctx = rowContextOf(el);
    return ctx ? { row: ctx.index, rows: ctx.rows.length, rowFirst: rowFirstValue(ctx.row) } : null;
  };
  // Does any of `others` sit in ANOTHER row of `el`'s row group?
  const inOtherRow = (el, others) => {
    const ctx = rowContextOf(el);
    return !!ctx && others.some(o => o !== el && ctx.rows.some(r => r !== ctx.row && r.contains(o)));
  };
  // Apply `section`/`near`. Returns { pool } or { error, … } — never a silent
  // fallback to the page-wide pool.
  const applySectionScope = (sectionArg) => {
    const sec = resolveSection(sectionArg.toLowerCase());
    if (!sec.matched) {
      return { error: `section "${sectionArg}" not found — no heading/legend/[role=heading] on this page matches it, so the field was NOT filled (refusing to fall back to a page-wide match, which would silently write the wrong field). Use one of the section titles listed in \`sections\`, or target the field positionally with index:N.`, sections: sec.sections.slice(0, 40) };
    }
    if (!sec.items.length) {
      return { error: `section "${sectionArg}" was found but holds no visible fillable field, so nothing was filled (refusing to fall back to a page-wide match). The field may still be collapsed/unrendered (open the section first), or it may live in a shadow root / iframe, which section scoping cannot order reliably — use index:N there.`, sections: sec.sections.slice(0, 40) };
    }
    return { pool: sec.items };
  };
  // Why a fill missed. A bare "No fillable element" left the model guessing
  // (Wikipedia: the search input EXISTS but is display:none until the header's
  // search toggle is clicked — the fill was right to refuse, the error said
  // nothing). Report (a) matching fields that exist but are hidden, straight from
  // the live DOM, and (b) the visible fillable fields it could have meant.
  // Bounded: one selector query, ≤MAX_SECTION_FIELDS elements, no full walk.
  const fieldBrief = (it) => {
    const o = { tag: it.tag };
    if (it.label) o.label = it.label;
    if (it.placeholder) o.placeholder = it.placeholder;
    if (it.ariaLabel) o.ariaLabel = it.ariaLabel;
    if (it.name) o.name = it.name;
    if (it.type) o.type = it.type;
    return o;
  };
  // Fields carrying the same label/name as `m` that are NOT visible (another
  // row's copy, a collapsed panel's). Main document, one selector query, ≤12.
  const hiddenCopiesOf = (m, exact, visibleEls) => {
    const out = [];
    try {
      const forMap = new Map();
      for (const l of document.querySelectorAll('label[for]')) if (!forMap.has(l.htmlFor)) forMap.set(l.htmlFor, cleanLabel(l.textContent));
      const all = Array.from(document.querySelectorAll(FILLABLE_SEL)).slice(0, MAX_SECTION_FIELDS);
      for (const el of all) {
        if (out.length >= 12) break;
        if (visibleEls.includes(el)) continue;
        const it = { label: labelFor(el, (e) => forMap.get(e.id) ?? null), ariaLabel: el.getAttribute('aria-label'), placeholder: el.getAttribute('placeholder'), name: el.getAttribute('name') };
        if (!(exact ? fieldMatchesExact(it, m) : fieldMatchesText(it, m))) continue;
        let r; try { r = el.getBoundingClientRect(); } catch { continue; }
        if (visible(el, r) || labelProxyRect(el)) continue;   // visible ones are in the match pool
        out.push(el);
      }
    } catch {}
    return out;
  };
  const fillMissReport = (m, pool) => {
    const report = { candidates: pool.slice(0, 12).map(fieldBrief) };
    const hidden = [];
    try {
      const all = Array.from(document.querySelectorAll(FILLABLE_SEL)).slice(0, MAX_SECTION_FIELDS);
      for (const el of all) {
        if (hidden.length >= 6) break;
        const attrs = [labelFor(el), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), el.getAttribute('title'), el.id];
        if (!attrs.some(a => a && String(a).toLowerCase().includes(m))) continue;
        let rect; try { rect = el.getBoundingClientRect(); } catch { continue; }
        if (visible(el, rect)) continue;   // visible ones are already in the pool (or capped out)
        hidden.push({ tag: el.tagName.toLowerCase(), label: labelFor(el) || null, ariaLabel: el.getAttribute('aria-label'), placeholder: el.getAttribute('placeholder'), name: el.getAttribute('name'), id: el.id || null });
      }
    } catch {}
    if (hidden.length) {
      report.hiddenMatches = hidden;
      report.hint = `${hidden.length} matching field(s) exist but are hidden (display:none / zero size) — a toggle, tab, or expander must reveal them first (fast_click the control that opens the search/form), then fill again.`;
    } else if (!report.candidates.length) {
      report.hint = 'no visible fillable field on this view at all — the form may sit in a cross-origin iframe (fast_screenshot + fast_click_xy / fast_type) or still be loading.';
    }
    return report;
  };
  // A visible select-type control (native select, ARIA combobox/listbox, popup
  // button, react-select input) whose label / aria-label / placeholder holds `m`.
  // Bounded: one composed-tree query of DROPDOWN_SEL, ≤300 controls.
  const selectControlByLabel = (m) => {
    const found = [];
    try { walkDeep(document, DROPDOWN_SEL, (el) => { if (found.length < 300) found.push(el); }); } catch {}
    for (const el of found) {
      const name = labelFor(el) || containerLabel(el) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
      if (!name || !name.toLowerCase().includes(m)) continue;
      let r; try { r = el.getBoundingClientRect(); } catch { continue; }
      if (fieldVisible(el, r)) return { el, name: cleanLabel(name).slice(0, 120) };
    }
    return null;
  };
  // Nearest preceding heading/legend — the section name a model can pass back.
  const headingAbove = (el) => {
    try {
      const hs = document.querySelectorAll(SECTION_ANCHORS);
      for (let i = hs.length - 1; i >= 0; i--) { if (follows(hs[i], el)) { const h = headingTitle(hs[i]); if (h) return h; } }
    } catch {}
    return null;
  };
  // Every section title whose outline span holds `el`, outermost first.
  const sectionPathOf = (el) => {
    if (!el) return [];
    try {
      const anchors = Array.from(document.querySelectorAll(SECTION_ANCHORS)).slice(0, MAX_ANCHORS);
      return outlineTitles(anchors, el, anchorLevel, (a, b) => a.contains(b), follows, headingTitle);
    } catch { return []; }
  };
  // The full pointer sequence a person's click produces (over → down → up →
  // click), at the element's centre. Widgets that act on mousedown (Select2,
  // Choices, react-select) or mouseup (Select2 options) respond to it; bare
  // el.click() fires only the last event. Stops when a handler detached the node.
  const pointerSeq = (el) => {
    let r = null; try { r = el.getBoundingClientRect(); } catch {}
    const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r ? r.x + r.width / 2 : 0, clientY: r ? r.y + r.height / 2 : 0 };
    const P = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    const ptr = { pointerId: 1, isPrimary: true, pointerType: 'mouse' };
    el.dispatchEvent(new P('pointerover', { ...base, ...ptr }));
    el.dispatchEvent(new MouseEvent('mouseover', base));
    el.dispatchEvent(new P('pointerdown', { ...base, ...ptr, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    if (!el.isConnected) return;
    el.dispatchEvent(new P('pointerup', { ...base, ...ptr }));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    if (!el.isConnected) return;
    el.dispatchEvent(new MouseEvent('click', { ...base, detail: 1 }));
  };
  // Which control a pick/fill acted on — label / aria / name / id / the heading
  // above it — so an ambiguous target is visibly attributed, never silent.
  const describeField = (el) => {
    const o = { tag: el.tagName.toLowerCase() };
    try {
      const role = el.getAttribute('role'); if (role) o.role = role;
      const lbl = labelFor(el) || containerLabel(el); if (lbl) o.label = lbl.slice(0, 120);
      const al = el.getAttribute('aria-label'); if (al) o.ariaLabel = al.slice(0, 120);
      const ph = el.getAttribute('placeholder'); if (ph) o.placeholder = ph;
      const nm = el.getAttribute('name'); if (nm) o.name = nm;
      if (el.id) o.id = el.id;
      const h = headingAbove(el); if (h) o.section = h;
    } catch {}
    return o;
  };
  // Is `el` (or what it sits in) a SELECT-type control — native <select>, a
  // react-select instance (its input, control, value chips, "Remove X" buttons)
  // or an ARIA combobox with a listbox popup? Returns the control element for
  // the hint, else null. Bounded 8-hop climb.
  const RS_INPUT_SEL = 'input[id^="react-select-"]';
  const TEXT_INPUT_SEL = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([id^="react-select-"]),textarea';
  const selectControlOf = (el) => {
    if (!el || el.nodeType !== 1) return null;
    try {
      if (el.tagName === 'SELECT') return el;
      if (el.matches(RS_INPUT_SEL)) return el;
      // A typeable input inside a [role=combobox] wrapper is an AUTOCOMPLETE
      // (Google Maps' search box, GCP's filter) — typing is the right tool there.
      if (el.matches(TEXT_INPUT_SEL)) return null;
      const closedList = (p) => !(p.querySelector && p.querySelector(TEXT_INPUT_SEL));
      if (el.getAttribute('role') === 'combobox' && closedList(el)) return el;
      let p = el;
      for (let hops = 0; p && hops < 8; hops++, p = p.parentElement) {
        if (p.tagName === 'SELECT') return p;
        if (p.querySelector && /(?:^|\s)[\w-]*control(?:\s|$)/i.test(String(p.className || ''))) {
          const rs = p.querySelector(RS_INPUT_SEL);
          if (rs) return rs;
        }
        const role = p.getAttribute && p.getAttribute('role');
        if ((role === 'combobox' || role === 'listbox') && closedList(p)) return p;
        if (p.getAttribute && /^(listbox|true)$/.test(p.getAttribute('aria-haspopup') || '') && closedList(p)) return p;
      }
    } catch {}
    return null;
  };
  // The one-line redirect a click/fill returns when its target is a dropdown.
  const selectHintFor = (el) => {
    const ctrl = selectControlOf(el);
    if (!ctrl) return null;
    const f = describeField(ctrl);
    const name = f.label || f.ariaLabel || f.placeholder || f.name || f.section || f.id || 'this field';
    return { selectField: f, hint: `this is a select control (field ${JSON.stringify(name)}); use fast_select_option {field:${JSON.stringify(name)}, option:"<choice>"} instead of clicking/typing its value` };
  };
  // A verified fill/pick is settled by definition — the generic "page still
  // changing" settle hint on such a result only provokes needless waits. So is a
  // {fields} result whose writes held and whose every miss is explained (`settled`).
  const calmIfVerified = (out, settled = !!out && out.verified === true) => {
    if (out && settled && out.settling) {
      delete out.settling;
      if (out.hint) { const keep = String(out.hint).split(' | ').filter(h => !/still changing/.test(h)); if (keep.length) out.hint = keep.join(' | '); else delete out.hint; }
    }
    return out;
  };
  // ── Autocomplete inputs: ONE path for fast_fill / fast_key_press / fast_click /
  // fast_wait. An autocomplete's typed text is not the app's value until the app
  // accepts it (a suggestion picked, Enter) — a fill that "holds" is not a commit.
  // Autocomplete = a typeable control that is an ARIA combobox (on itself or its
  // ARIA 1.1 wrapper), declares aria-autocomplete, or names a popup via
  // aria-controls / aria-owns / aria-haspopup. A native <input list=datalist> is
  // NOT one: its typed text is the value.
  const comboWrapperOf = (el) => {
    let p = el.parentElement;
    for (let i = 0; p && i < 3; i++, p = p.parentElement) if (p.getAttribute && p.getAttribute('role') === 'combobox') return p;
    return null;
  };
  const isAutocomplete = (el) => {
    try {
      if (!el || el.nodeType !== 1) return false;
      if (!(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return false;
      if (el.tagName === 'INPUT' && !/^(text|search|url|email|tel|)$/i.test(el.getAttribute('type') || '')) return false;
      const ac = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
      const hp = (el.getAttribute('aria-haspopup') || '').toLowerCase();
      return (ac && ac !== 'none') || el.getAttribute('role') === 'combobox' || !!el.getAttribute('aria-controls') || !!el.getAttribute('aria-owns')
        || (hp && hp !== 'false') || !!comboWrapperOf(el);
    } catch { return false; }
  };
  // Visible option rows of the control's OPEN popup (aria-controls / aria-owns on
  // the control, its descendants or its combobox wrapper), outermost only (a grid
  // row wrapping a row would double-count). [] when no popup is open.
  const OPTION_ROWS = '[role="option"],[role="row"],[role="menuitem"],[role="treeitem"]';
  const panelOptions = (el) => {
    try {
      if (!el || el.nodeType !== 1) return [];
      const wrap = comboWrapperOf(el);
      const ids = ariaPanelIds(el);
      if (wrap) for (const id of ariaPanelIds(wrap)) if (!ids.includes(id)) ids.push(id);
      for (const id of ids) {
        const panel = lookupId(el, id) || document.getElementById(id);
        if (!panel) continue;
        let r; try { r = panel.getBoundingClientRect(); } catch { continue; }
        if (!visible(panel, r)) continue;
        const opts = [];
        for (const o of panel.querySelectorAll(OPTION_ROWS)) {
          let or; try { or = o.getBoundingClientRect(); } catch { continue; }
          if (visible(o, or)) opts.push(o);
        }
        const outer = opts.filter(o => !opts.some(p => p !== o && p.contains(o)));
        if (outer.length) return outer;
      }
    } catch {}
    return [];
  };
  // Icon-font glyphs (Private Use Area) are not text a model can click by.
  const optionText = (o) => cleanLabel(String(o.textContent || '').replace(/[-]/g, ' '));
  const AC_OPEN_HINT = 'autocomplete is open; pick a suggestion (fast_click its text) or fast_key_press Enter, then read back';
  // The control's open suggestion list, reported the same way by every tool.
  const openSuggestions = (el) => {
    const seen = [];
    for (const o of panelOptions(el)) {
      if (seen.length >= 5) break;
      const t = optionText(o).slice(0, 80);
      if (t && !seen.includes(t)) seen.push(t);
    }
    return seen.length ? { committed: false, suggestions: seen, hint: AC_OPEN_HINT } : null;
  };
  // Apps open the list on a debounce / after a network round-trip (Maps: the
  // grid shows ~0.3-1s after the input event), so a read right after the write
  // sees nothing. Bounded poll; returns at once for a non-autocomplete.
  const AC_PANEL_WAIT_MS = 1200;
  // A value write fires input/change, but many autocompletes filter on the KEY
  // events a person's typing produces (the W3C APG combobox opens on keyup,
  // jQuery UI schedules its search on keydown). Send the last character's
  // keydown/keyup after the write (Backspace for a cleared field) — no text is
  // inserted by synthetic key events.
  const typedKeys = (el, value) => {
    const v = String(value ?? '');
    const k = v ? v[v.length - 1] : 'Backspace';
    try { const o = keyInit(k); el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keyup', o)); } catch {}
  };
  const awaitSuggestions = async (el) => {
    if (!isAutocomplete(el)) return null;
    const tEnd = nowMs() + AC_PANEL_WAIT_MS;
    for (;;) {
      const s = openSuggestions(el);
      if (s || nowMs() >= tEnd) return s;
      await wait(50);
    }
  };
  // Per-page record of autocomplete values written by fast_fill and not yet
  // seen accepted (kept on INDEX so it survives between calls). An entry is
  // settled when the app took it: a suggestion pick / Enter that closed the
  // list, the live value changed from what was typed, or the URL moved.
  const acField = (el) => { const f = describeField(el); return f.label || f.ariaLabel || f.placeholder || f.name || f.id || 'the autocomplete input'; };
  // "The URL moved" = origin + path; query-only replaceState noise (Google's ?zx=) is not a commit.
  const pagePath = () => location.origin + location.pathname;
  const acRecord = (el, value) => {
    const list = (INDEX.acPending || []).filter(p => p.el !== el && p.el.isConnected).slice(-3);
    list.push({ el, value: String(value), url: pagePath(), committed: false });
    INDEX.acPending = list;
  };
  const acSettle = (el) => { for (const p of INDEX.acPending || []) if (p.el === el) p.committed = true; };
  // fast_wait timeout: the focused or last-filled autocomplete that is still open
  // or never accepted is the likely reason the awaited view never came.
  const acWaitHint = () => {
    const cands = [document.activeElement, ...(INDEX.acPending || []).map(p => p.el).reverse()];
    const seen = new Set();
    for (const el of cands) {
      if (!el || seen.has(el) || !el.isConnected || !isAutocomplete(el)) continue;
      seen.add(el);
      const name = JSON.stringify(acField(el));
      const sug = openSuggestions(el);
      if (sug) return { hint: `${name} has an open suggestion list; submit it (Enter or pick a suggestion) before waiting`, field: acField(el), suggestions: sug.suggestions };
      const p = (INDEX.acPending || []).find(q => q.el === el);
      if (p && !p.committed && liveValueOf(el) === p.value && pagePath() === p.url) return { hint: `${name} has an uncommitted value; submit it (Enter or pick a suggestion) before waiting`, field: acField(el) };
    }
    return null;
  };
  // The entry of an open suggestion list (aria-controls panel of the focused
  // control) whose text matches — those rows/gridcells are not index entries, so
  // fast_click reaches them through this. Exact > startsWith > substring.
  const suggestionByText = (text) => {
    try {
      const t = String(text || '').toLowerCase().trim();
      const el = document.activeElement;
      if (!t || !el) return null;
      // ONLY a typeahead's own popup is a suggestion list. Without this gate any
      // focused element that names a panel — a [role=tab] naming its tab panel,
      // a disclosure button naming its section — turned every [role=row] /
      // [role=option] inside that panel into a "suggestion", so clicking a
      // selectable GRID ROW was refused as "a suggestion the control did not
      // accept" instead of being clicked (Syncfusion EJ2 wizard: focus sat on
      // the "Train List" tab, whose aria-controls panel holds the train grid).
      if (!isAutocomplete(el)) return null;
      const outer = panelOptions(el);
      const target = pickByText(outer, (o) => optionText(o).toLowerCase(), t);
      if (target) return { el: target, input: el, index: outer.indexOf(target) };
    } catch {}
    return null;
  };
  // Commit a suggestion the way a person does: ArrowDown to it, Enter — the
  // control's own keyboard handler applies it (Maps ignores synthetic mouse
  // events on its rows). Falls back to pointer/mouse events on the entry when
  // the list is still open afterwards. Returns what changed.
  const commitSuggestion = async (sug) => {
    const { el, input, index } = sug;
    const before = liveValueOf(input);
    const key = (target, k) => { const o = keyInit(k); target.dispatchEvent(new KeyboardEvent('keydown', o)); target.dispatchEvent(new KeyboardEvent('keyup', o)); };
    const urlBefore = location.href;
    const took = () => liveValueOf(input) !== before || location.href !== urlBefore || !openSuggestions(input);
    for (let i = 0; i <= index; i++) { key(input, 'ArrowDown'); await wait(40); }
    key(input, 'Enter');
    await wait(300);
    if (took()) { acSettle(input); return { via: 'keyboard', committed: true }; }
    flashEl(el, 'click');
    pointerSeq(el);
    await wait(300);
    const ok = took();
    if (ok) acSettle(input);
    return { via: 'mouse', committed: ok };
  };
  // Bring an offscreen target into view before acting on it (a heavy page's
  // match pool now includes offscreen controls).
  const revealIfOffscreen = (it, el) => {
    if (!it.offscreen || !el || !el.scrollIntoView) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch { try { el.scrollIntoView(); } catch {} }
    return true;
  };
  // Match list for a miss/out-of-range report: where each candidate is.
  const matchBrief = (m) => {
    const o = { tag: m.tag };
    if (m.role) o.role = m.role;
    if (m.text) o.text = m.text.slice(0, 80);
    if (m.label) o.label = m.label;
    if (m.offscreen) { o.offscreen = true; const el = elById(m.i); const h = el && headingAbove(el); if (h) o.section = h; }
    return o;
  };
  const fillItem = (found, value, append) => {
    const el = elAt(found);
    if (!el) return { error: 'no element' };
    // NEVER write the literal "undefined"/"null". A missing value must be caught
    // before we stringify, or String(undefined) -> "undefined" lands in the field
    // (confirmed bug: a "Customer name" field read `undefined`). An explicit ""
    // is a REAL value that CLEARS the field, so only null/undefined is rejected.
    if (value == null) return { error: "fast_fill: no value provided — pass value (use value:'' to clear the field)" };
    const v = String(value); // safe now: value is present (may be "")
    flashEl(el, 'fill');
    // Checkbox / radio: the value is a STATE (true → ticked), set the way a person
    // does (a click, so the page's handlers run) — writing "true" into .value
    // ticked nothing while the result read back "true" (h_repeat "Dependant").
    if (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type || '')) {
      const s = v.trim().toLowerCase();
      const want = /^(true|yes|on|1|checked|check|tick|ticked|x|✓|✔)$/.test(s) ? true : /^(false|no|off|0|unchecked|uncheck|untick|)$/.test(s) ? false : null;
      const name = found.label || found.name || el.type;
      if (want === null) return { error: `${JSON.stringify(name)} is a ${el.type}: pass value:true to tick it or value:false to clear it (or fast_click its label) — nothing was changed` };
      if (el.type === 'radio' && !want) return { error: `${JSON.stringify(name)} is a radio: it cannot be cleared by value — pick another option of the group (fast_click its label); nothing was changed` };
      if (el.checked !== want) el.click();
      return { filled: { tag: found.tag, type: el.type, label: found.label, name: found.name }, valueSet: want, kind: el.type };
    }
    el.focus();
    // Native <select>: don't type into it — match the value against option TEXT
    // or VALUE (exact > startsWith > substring on text, then exact value), set
    // .value and fire change. Lets fast_fill_form set native dropdowns inline.
    if (el.tagName === 'SELECT') {
      const all = Array.from(el.options);
      const target = pickByText(all, o => (o.text || '').trim().toLowerCase(), v)
                  || all.find(o => (o.value || '').toLowerCase() === v.toLowerCase());
      if (!target) return { error: 'option not found in <select>', available: all.map(o => o.text) };
      el.value = target.value;
      // composed:true so the input/change cross any shadow boundary — a web-
      // component / Angular-Material control whose validator listens OUTSIDE the
      // select's shadow root only revalidates if the event escapes it.
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return { filled: { tag: found.tag, label: found.label, name: found.name }, valueSet: target.text, kind: 'native-select' };
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, append ? (el.value + v) : v); // v==="" -> empties the field
      // composed:true so validators across a shadow boundary still see input/change.
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } else {
      el.innerText = append ? (el.innerText + v) : v; // contenteditable: "" clears
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: v }));
    }
    return { filled: { tag: found.tag, label: found.label, placeholder: found.placeholder, name: found.name }, valueSet: v };
  };

  const pickByText = (items, getText, query) => {
    const lo = query.toLowerCase();
    return items.find(o => getText(o) === lo)
        || items.find(o => getText(o).startsWith(lo))
        || items.find(o => getText(o).includes(lo));
  };

  // Diagnostic for "why didn't this match?" — runs only on a 0-match miss.
  // This is ONLY a hint; it must NEVER freeze the page. The old version walked
  // the WHOLE DOM doing getComputedStyle + getBoundingClientRect + closest() per
  // textual hit (5-10s freeze on GCP's 50k-node tree). Now:
  //   • hard-cap elements EXAMINED and a wall-clock BUDGET, both checked often;
  //   • the scan does NO layout — text test uses own text-nodes + a few short
  //     attributes (cheap, no quadratic textContent), type test is matches();
  //   • layout reads (style/rect/closest) run on at most a handful of the best
  //     interactive candidates AFTER the scan;
  //   • over budget → degrade to a cheap count-only answer.
  // fast_click's last resort before "nothing to click": a VISIBLE element whose
  // own text / aria-label / title / alt IS the query and whose computed cursor is
  // pointer — something the page made clickable by script without any control
  // semantics (an icon <div aria-label="Next">, an <img alt>). Bounded walk.
  // A pointer cursor still WINS when the page has one (the script-made <div>
  // "Next"), but a plain one is taken too: a grid cell, a tree row or a list row
  // with no role, no ARIA and no pointer cursor is exactly what a person clicks,
  // and refusing it left coordinates as the only way in (Syncfusion EJ2 grid
  // rows, Wunderbaum tree rows). The smallest such element wins, so a row beats
  // the pane that contains it. Returns { el, via } or null.
  const textTargetByText = (queryText) => {
    const q = cleanLabel(queryText).toLowerCase();
    if (!q) return null;
    const start = nowMs();
    let n = 0, pointerHit = null, plainHit = null, plainArea = Infinity;
    walkDeep(document, '*', (el) => {
      if (pointerHit || n > 4000 || ((++n & 63) === 0 && nowMs() - start > 120)) return;
      let own = '';
      for (const c of el.childNodes) if (c.nodeType === 3) own += c.data;
      const names = [own, el.getAttribute('aria-label'), el.getAttribute('title'), el.tagName === 'IMG' ? el.getAttribute('alt') : null];
      if (!names.some(s => s && cleanLabel(s).toLowerCase() === q)) return;
      let r; try { r = el.getBoundingClientRect(); } catch { return; }
      if (!visible(el, r)) return;
      let cursor = ''; try { cursor = getComputedStyle(el).cursor; } catch {}
      if (cursor === 'pointer') { pointerHit = el; return; }
      const area = r.width * r.height;
      if (area < plainArea) { plainArea = area; plainHit = el; }
    });
    return pointerHit ? { el: pointerHit, via: 'pointer-cursor' } : plainHit ? { el: plainHit, via: 'text' } : null;
  };
  const DIAG_MAX_EXAMINE = 1500;
  const DIAG_BUDGET_MS = 150;
  const DIAG_LAYOUT_CAP = 24;
  const diagnoseNoMatch = (queryText) => {
    const q = (queryText || '').toLowerCase();
    if (!q) return ['empty text query'];
    const out = [];
    const start = nowMs();
    let examined = 0, stopped = false;
    let interactiveHits = 0, nonInteractiveHits = 0;
    const layoutCandidates = [];
    walkDeep(document, '*', (el) => {
      if (stopped) return;
      if (examined >= DIAG_MAX_EXAMINE || ((examined & 15) === 0 && (nowMs() - start) > DIAG_BUDGET_MS)) { stopped = true; return; }
      examined++;
      // Cheap, bounded text source: short attributes + this element's OWN text
      // nodes (not the whole subtree → no quadratic textContent blowup). The
      // sought text lives on some leaf whose own text contains it, so leaves are
      // still found.
      let txt = (el.getAttribute?.('aria-label') || '') + ' ' +
                (el.getAttribute?.('placeholder') || '') + ' ' +
                (el.getAttribute?.('title') || '') + ' ' + (el.value || '');
      if (el.childNodes) {
        for (const c of el.childNodes) {
          if (c.nodeType === 3 && c.data) { txt += ' ' + c.data; if (txt.length > 300) break; }
        }
      }
      if (!txt.toLowerCase().includes(q)) return;
      const isInteractive = el.matches?.(SELECTOR);   // no layout
      if (isInteractive) { interactiveHits++; if (layoutCandidates.length < DIAG_LAYOUT_CAP) layoutCandidates.push(el); }
      else nonInteractiveHits++;
    });
    // Layout reads ONLY for the capped sample of interactive candidates.
    let hidden = 0, ariaHidden = 0, offScreen = 0, visibleInteractive = 0;
    const hiddenTags = [];
    for (const el of layoutCandidates) {
      let cs = null, rect = null;
      try { cs = el.ownerDocument?.defaultView?.getComputedStyle?.(el); } catch {}
      try { rect = el.getBoundingClientRect?.(); } catch {}
      const isHidden = cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0');
      const isAriaHidden = el.closest?.('[aria-hidden="true"]') != null;
      const isOff = rect && (rect.width < 2 || rect.height < 2);
      if (isHidden) { hidden++; hiddenTags.push(el.tagName.toLowerCase()); }
      else if (isAriaHidden) ariaHidden++;
      else if (isOff) offScreen++;
      else visibleInteractive++;
    }
    const totalHits = interactiveHits + nonInteractiveHits;
    const more = (examined >= DIAG_MAX_EXAMINE || layoutCandidates.length >= DIAG_LAYOUT_CAP) ? '+' : '';
    if (totalHits === 0) {
      if (stopped) out.push(`Text "${queryText}" not found in the first ${examined} elements (page too large to scan fully). Try more specific/visible text, fast_scroll, or narrow with role/tag.`);
      else out.push(`Text "${queryText}" not found in document, open shadow DOM, or same-origin iframes.`);
    } else {
      if (visibleInteractive > 0) out.push(`${visibleInteractive}${more} interactive match(es) appear visible but were skipped — the snapshot should already include them; try increasing window size or scroll first.`);
      if (hidden) {
        const tags = [...new Set(hiddenTags)].slice(0, 4).join(', ');
        out.push(`${hidden}${more} match(es) hidden via display:none / visibility:hidden / opacity:0 (${tags}). A parent likely needs opening first — dropdown, accordion, or modal.`);
      }
      if (ariaHidden) out.push(`${ariaHidden}${more} match(es) sit under aria-hidden="true" — usually behind an active modal/overlay.`);
      if (offScreen) out.push(`${offScreen}${more} interactive match(es) have 0×0 / off-screen bounds. Try fast_scroll to bring them into view.`);
      if (nonInteractiveHits) out.push(`${nonInteractiveHits}${more} non-interactive match(es) — fast_click only fires on buttons/links/inputs/[role]/[onclick]/etc. Use fast_evaluate to dispatch a click on a plain element if needed.`);
      if (stopped) out.push(`(diagnostic stopped early at ${examined} elements / ${DIAG_BUDGET_MS}ms — counts are partial.)`);
    }
    return out;
  };

  // Internal (the background's frame reach, not a tool): the visible cross-origin
  // frames of this document with src and content-box origin; with `unread` (a
  // list of srcs) also the notice naming only those.
  if (action === 'fast_frames') {
    const scan = opaqueFrames();
    const out = { frames: scan.frames, partial: scan.partial };
    if (Array.isArray(args.unread)) {
      const left = scan.frames.filter((f) => args.unread.includes(f.src));
      const notice = frameNotice({ frames: left });
      if (notice) { out.frameNotice = notice; out.opaqueFrames = noticeBoxes(left); }
    }
    return out;
  }

  if (action === 'fast_snapshot') {
    const snap = await serializeSnapshot(!!args.viewport, { overlay: !!args.overlay });
    // full:true → the complete, uncapped set. Otherwise rank + cap (interactive /
    // on-screen first); `limit` overrides the default item cap. Any loss (cap or
    // viewport-only skips) leads the result as truncated:true + dropped + hint.
    if (args.full) return markTruncated(snap, explicitHint);
    // autoCap: the bounded preview an action's auto-snapshot carries (frames.js attaches a
    // frame's items to a wait that hit inside that frame)
    if (args.autoCap) {
      let near = null;
      if (args.nearText) {
        const q = String(args.nearText).toLowerCase();
        const hit = (snap.items || []).find((it) => [it.text, it.label, it.ariaLabel].some((t) => t && String(t).toLowerCase().includes(q)))
          || (snap.content || []).find((c) => c.text && c.text.toLowerCase().includes(q));
        if (hit && typeof hit.x === 'number') near = { x: hit.x + (hit.w || 0) / 2, y: hit.y + (hit.h || 0) / 2 };
      }
      return capAutoSnapshot(snap, args, near);
    }
    const itemCap = (typeof args.limit === 'number' && args.limit >= 0) ? args.limit : ITEM_CAP_DEFAULT;
    return markTruncated(capSnapshot(snap, itemCap, CONTENT_CAP_DEFAULT), explicitHint);
  }

  if (action === 'fast_key_press') {
    // Untrusted DOM key events on the focused element (a real chord is fast_key).
    // Returns what the key did: target, url change and a settled snapshot.
    const key = args.key;
    if (!key) return { error: 'key required' };
    const el = document.activeElement || document.body;
    const urlBefore = location.href;
    const opts = keyInit(key);
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    const out = await withSnap({ keyDispatched: key });
    const head = { keyDispatched: key, target: describeEl(el), url: location.href, urlChanged: location.href !== urlBefore };
    const sug = openSuggestions(document.activeElement);
    if (sug) Object.assign(head, sug);
    else if (key === 'Enter' || key === 'Tab') acSettle(el);   // submitted and no list left open
    return frontload(out, head);
  }

  if (action === 'fast_wait') {
    const t = (args.text || '').toLowerCase();
    const selector = args.selector ? String(args.selector) : '';
    if (!t && !selector) return { error: 'fast_wait needs text, selector, or networkIdle:true' };
    if (selector) { try { document.querySelector(selector); } catch { return { error: `fast_wait: invalid CSS selector ${JSON.stringify(selector)}` }; } }
    const deadline = Date.now() + (args.timeoutMs || 5000);
    // A match must be REAL: a content entry's cached text can outlive the text
    // (a panel emptied by a re-render still matches from the index), and a
    // container that holds the text but has no visible box is not "the view
    // mounted". Such hits keep polling; if one is all there is at the deadline
    // the result says so (emptyContainer:true) instead of resolving on it.
    let emptyHit = null;   // { el, text } — the last stale/invisible match seen
    const liveHasText = (el) => { try { return !!el && (el.textContent || '').toLowerCase().includes(t); } catch { return false; } };
    const boxVisible = (el) => { let r; try { r = el.getBoundingClientRect(); } catch { return false; } return visible(el, r); };
    // Cheap text-only scan over the index — no rect reads, no layout.
    // Only when we find a match do we serialize that ONE entry with
    // coords, so a polling fast_wait doesn't repeatedly force layout
    // on the whole page while it's still rendering.
    // Scan the index for a match. Prefer an interactive ('click') entry so the
    // clickable path keeps returning coords; fall back to a non-interactive
    // ('content') entry — headings, paragraphs, <pre> JSON, body text — so
    // fast_wait can resolve on plain page content too. Returns { el, content }.
    const findEntryByText = () => {
      // Bound the per-poll scan so polling (every 150ms) can never jank: on a
      // 10k-entry index an unbounded scan + drain every tick adds up. Cap nodes
      // and wall-clock; a real match is found in the first slice on normal pages.
      let scanned = 0;
      const start = nowMs();
      let contentEl = null;
      for (const [el, entry] of INDEX.byEl) {
        if ((++scanned & 511) === 0 && (nowMs() - start) > 20) break;
        if (scanned > 12000) break;
        if (entry.kind === 'click') {
          // Same live re-read as the serializer: waiting on a field's CURRENT
          // value must not be answered from a cached pre-fill one.
          if (entry.live) refreshLiveEntry(el, entry);
          if (entry.text && entry.text.toLowerCase().includes(t)) return { el, content: false };
        } else if (entry.kind === 'content') {
          // Remember the first content hit but keep scanning — a clickable hit
          // (richer result with coords) is preferred if one also matches.
          if (!contentEl && entry.text && entry.text.toLowerCase().includes(t)) contentEl = el;
        }
      }
      return contentEl ? { el: contentEl, content: true } : null;
    };
    // Cheap, bounded descent to the smallest element fully containing `t`, so a
    // content match can still carry coords. One child scan per level, depth-
    // capped — never a full-document walk.
    // Returns null when the ONLY place the text lives is script/style/template
    // text — body.textContent includes inline <script> bodies (JSON state blobs,
    // templates), which are not "the view mounted". Skipping those subtrees keeps
    // the descent on rendered content.
    const NON_VIEW_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
    const smallestContaining = () => {
      try {
        let el = document.body;
        if (!el || !(el.textContent || '').toLowerCase().includes(t)) return null;
        for (let depth = 0; depth < 200; depth++) {
          let next = null, onlyNonView = false;
          for (const child of el.children) {
            if (child.nodeType !== 1 || !(child.textContent || '').toLowerCase().includes(t)) continue;
            if (NON_VIEW_TAGS.has(child.tagName)) { onlyNonView = true; continue; }
            next = child; break;
          }
          if (!next) {
            // Own text nodes may still hold it; if only a script/style child did, it is not on the page.
            if (onlyNonView) {
              let own = '';
              for (const c of el.childNodes) if (c.nodeType === 3) own += c.data;
              if (!own.toLowerCase().includes(t)) return null;
            }
            break;
          }
          el = next;
        }
        return el;
      } catch { return null; }
    };
    return new Promise((settle) => {
      // Cancellable: when the background finds the text inside a sub-frame first
      // (frames.js waitTextAnyFrame), it calls window.__fastlink.cancelWaits() so
      // this wait stops polling instead of running on to its deadline.
      let done = false;
      const resolve = (v) => { done = true; ACTIVE_WAITS.delete(cancel); settle(v); };
      const cancel = () => resolve({ cancelled: true, error: 'fast_wait cancelled: the text was found in a sub-frame first' });
      ACTIVE_WAITS.add(cancel);
      const resolveEmpty = () => {
        const el = emptyHit.el;
        const found = { text: emptyHit.text, tag: el.tagName ? el.tagName.toLowerCase() : undefined, contentMatch: true };
        return resolve(withSnap({ found, emptyContainer: true, waitedMs: (args.timeoutMs || 5000), hint: `"${args.text || selector}" matched only an element with no visible box/content (stale or hidden container) — the view has not rendered; wait for text that only the finished view shows, or read again` }));
      };
      // A content/body match: resolve found.contentMatch without requiring an
      // interactive element. Attach coords when we can locate a containing
      // element (visible), but never drop the match for lack of one. Still
      // attaches the bounded post-wait snapshot (honors noSnapshot).
      const resolveContent = (el, matched) => {
        const found = { text: matched, contentMatch: true };
        if (el && el.isConnected) {
          let rect; try { rect = el.getBoundingClientRect(); } catch { rect = null; }
          if (rect && visible(el, rect)) {
            const off = offsetFor(el);
            found.x = Math.round(rect.x + off.ox);
            found.y = Math.round(rect.y + off.oy);
            found.w = Math.round(rect.width);
            found.h = Math.round(rect.height);
          }
        }
        return resolve(withSnap({ found }));
      };
      // Attribute text the index scan cannot see when the observer is off: a
      // combobox/search input's aria-label or placeholder ("Choose starting
      // point, or click on the map..." on Google Maps) is not body textContent,
      // so the fallback below never matched it. Bounded direct probe.
      const ATTR_PROBE_SEL = 'input,textarea,[role="combobox"],[role="textbox"],[role="searchbox"],[aria-label],[placeholder]';
      const probeAttrText = () => {
        try {
          const els = document.querySelectorAll(ATTR_PROBE_SEL);
          const n = Math.min(els.length, 1500);
          for (let i = 0; i < n; i++) {
            const el = els[i];
            const a = el.getAttribute('aria-label'), p = el.getAttribute('placeholder');
            if ((a && a.toLowerCase().includes(t)) || (p && p.toLowerCase().includes(t))) return { el, text: a && a.toLowerCase().includes(t) ? a : p };
          }
        } catch {}
        return null;
      };
      let polls = 0;
      // selector mode: the first visible match wins; a matched-but-invisible
      // element is an emptyHit (reported at the deadline).
      const pollSelector = () => {
        let el = null;
        try { el = document.querySelector(selector); } catch { return null; }
        if (!el) return null;
        if (!boxVisible(el)) { emptyHit = { el, text: selector }; return null; }
        indexElement(el);
        const entry = INDEX.byEl.get(el);
        const rect = el.getBoundingClientRect(); const off = offsetFor(el);
        return resolve(withSnap({ found: {
          i: entry ? entry.id : undefined, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined,
          text: (entry && entry.text) || cleanLabel(el.textContent).slice(0, 120), selector,
          x: Math.round(rect.x + off.ox), y: Math.round(rect.y + off.oy), w: Math.round(rect.width), h: Math.round(rect.height),
        } }));
      };
      const poll = () => {
        if (done) return;
        polls++;
        if (selector) {
          if (pollSelector() !== null) return;
          if (Date.now() > deadline) {
            if (emptyHit) return resolveEmpty();
            // a selector is matched in this document only; name the frames it could be in
            const fr = opaqueFrames().frames;
            return resolve({ error: `Timed out waiting for selector ${JSON.stringify(selector)}${fr.length ? ` in this document — it may be inside a visible frame (${frameList(fr)}); pass frame:"<part of the frame URL>" to wait there` : ''}`, ...pageActivity(), ...(acWaitHint() || {}) });
          }
          return setTimeout(poll, 150);
        }
        // Storm-tripped page (Maps, GCP): the observer is OFF, so nothing new is
        // ever indexed unless a walk is re-seeded — snapshots do this on demand;
        // fast_wait must too, or it polls a frozen index to the deadline while the
        // awaited view is already on screen. Same resumable-cursor rule as
        // serializeSnapshot: re-seed only when the previous walk fully drained.
        if (INDEX.stormTripped && !hasPending()) {
          const root = document.body || document.documentElement;
          if (root) PENDING.adds.add(root);
        }
        drainPendingSync(2000, 30);
        const hit = findEntryByText();
        if (hit && hit.el && hit.el.isConnected) {
          const entry = INDEX.byEl.get(hit.el);
          if (hit.content) {
            // Non-interactive content entry — resolve as a content match, but
            // only if the text is still there and the element has a box.
            if (!liveHasText(hit.el)) { indexElement(hit.el); emptyHit = emptyHit || { el: hit.el, text: (entry && entry.text) || args.text }; }
            else if (!boxVisible(hit.el)) emptyHit = { el: hit.el, text: (entry && entry.text) || args.text };
            else return resolveContent(hit.el, (entry && entry.text) || args.text);
          } else {
          // Interactive entry: only now read rect/visibility for the match.
          let rect; try { rect = hit.el.getBoundingClientRect(); } catch { rect = null; }
          if (rect && visible(hit.el, rect)) {
            const off = offsetFor(hit.el);
            // Attach a post-wait snapshot (like fast_click/fast_fill) so the
            // agent can chain off the now-settled view without a second call.
            // withSnap is bounded + non-fatal and honors noSnapshot:true.
            return resolve(withSnap({ found: {
              i: entry.id, tag: entry.tag, role: entry.role,
              text: entry.text, label: entry.label, href: entry.href,
              ariaLabel: entry.ariaLabel,
              x: Math.round(rect.x + off.ox), y: Math.round(rect.y + off.oy),
              w: Math.round(rect.width), h: Math.round(rect.height),
            }}));
          }
          // Click entry matched but not yet visible — fall through to the body
          // fallback / keep polling.
          }
        }
        // Fallback: visible text that isn't an index entry (e.g. a raw <pre>
        // JSON blob may not be indexed as a content entry). Runs ONLY after the
        // cheap index scan misses. textContent does NOT force layout; gate to
        // every other poll so even a multi-MB body can't jank a 150ms loop.
        if (polls & 1) {
          try {
            const tc = document.body && document.body.textContent;
            if (tc && tc.toLowerCase().includes(t)) {
              const host = smallestContaining();   // null → the text is only inside script/style, not on the page
              if (host && boxVisible(host)) return resolveContent(host, args.text);
              if (host) emptyHit = { el: host, text: args.text };
            }
          } catch {}
          const attrHit = probeAttrText();
          if (attrHit) {
            let rect; try { rect = attrHit.el.getBoundingClientRect(); } catch { rect = null; }
            if (rect && visible(attrHit.el, rect)) {
              indexElement(attrHit.el);   // give it a stable id so the agent can chain a fill/click off it
              const entry = INDEX.byEl.get(attrHit.el);
              const off = offsetFor(attrHit.el);
              return resolve(withSnap({ found: {
                i: entry ? entry.id : undefined, tag: attrHit.el.tagName.toLowerCase(), role: attrHit.el.getAttribute('role'),
                text: attrHit.text, ariaLabel: attrHit.el.getAttribute('aria-label'), placeholder: attrHit.el.getAttribute('placeholder'),
                x: Math.round(rect.x + off.ox), y: Math.round(rect.y + off.oy), w: Math.round(rect.width), h: Math.round(rect.height),
              }}));
            }
          }
        }
        if (Date.now() > deadline) {
          if (emptyHit && emptyHit.el && emptyHit.el.isConnected) return resolveEmpty();
          // Direct DOM read (no snapshot/INDEX): give the agent a peek at the
          // current view so it can tell it landed somewhere wrong.
          const headings = [];
          try {
            const hs = document.querySelectorAll('h1,h2,h3,[role="heading"]');
            for (const h of hs) {
              if (headings.length >= 6) break;
              let r; try { r = h.getBoundingClientRect(); } catch { r = null; }
              if (!r || !visible(h, r)) continue;
              const txt = (h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
              if (txt) headings.push(txt);
            }
          } catch {}
          return resolve({ error: `Timed out waiting for "${args.text}"`, ...pageActivity(), headings, ...(acWaitHint() || {}) });
        }
        setTimeout(poll, 150);
      };
      poll();
    });
  }

  if (action === 'fast_select_option') {
    // `lastWalk` carries the most recent scan's budget status, so a miss can say the
    // page was too big to scan rather than pretending nothing matched.
    let lastWalk = null;
    const queryAllDeep = (root, selector) => {
      const out = [];
      lastWalk = walkDeep(root, selector, (el) => out.push(el));
      return out;
    };

    // Name/id lookups are explicit; label/aria/placeholder lookups only consider
    // VISIBLE control-like elements (controls first, then aria-labelled custom
    // widgets) and never a landmark/container — GCP's hidden "Skip links"
    // [aria-label] div once won "Application type" over the real combobox.
    const CONTROLISH = 'select,input,textarea,[role="combobox"],[role="listbox"],[role="textbox"],[role="searchbox"],[aria-haspopup],[contenteditable="true"],[contenteditable=""]';
    // What may be named as a dropdown at all (see isSelectish below): DROPDOWN_SEL's
    // popup semantics, a control that declares an expanded state, or a native control.
    const SELECTISH = `${DROPDOWN_SEL},[aria-expanded],select,input,textarea`;
    const LANDMARK_ROLES = /^(banner|complementary|contentinfo|main|navigation|region|form|group|dialog|alertdialog|search|toolbar|tabpanel|presentation|none|heading|list|table|grid)$/;
    // Cost model (a heavy SPA under a render storm: thousands of [aria-label]
    // elements, every layout read forced): ONE composed-tree walk that also
    // collects the <label>s; label text computed from that set, never per
    // candidate by document-wide query; layout (toControls) read only for a
    // candidate whose TEXT already matches. (GCP "Application type": resolve 5.6s before.)
    // A hidden native <select> that a visible widget enhances (Select2 / Tom Select
    // right after it, Choices around it) is that widget's BACKING STORE: the widget
    // is the control a person sets, and its shown value is the read-back. Returns
    // the one visible widget, else null (two candidates next to it = not ours to guess).
    const widgetFor = (sel) => {
      const vis = (w) => { let r; try { r = w.getBoundingClientRect(); } catch { return false; } return fieldVisible(w, r); };
      const around = sel.parentElement && sel.parentElement.closest('[role="combobox"],[aria-haspopup="listbox"]');
      if (around && vis(around)) return around;
      const next = sel.nextElementSibling;
      if (!next) return null;
      const found = [];
      for (const w of [next, ...next.querySelectorAll(DROPDOWN_SEL)]) {
        if (w.tagName === 'SELECT' || !w.matches(DROPDOWN_SEL) || !vis(w)) continue;
        if (!found.some(o => o.contains(w) || w.contains(o))) found.push(w);
      }
      return found.length === 1 ? found[0] : null;
    };
    // Matches → one candidate per CONTROL, document order: { el, visible, backing? }.
    // A wrapper and the control inside it are one control (the earlier-listed wins:
    // controls are listed first); a landmark/container is never a candidate.
    // LINEAR, not O(n²). "Is a wrapper of this already kept" was a scan over every
    // kept candidate (out.some(… contains …)); on a console SPA whose match set runs
    // to tens of thousands that is ~a billion contains() calls — 57.5% of CPU in a
    // profile, and it read a rect for EVERY match on the way (GCP: 34,409 rect
    // reads in one resolve). Now: an ancestor-Set lookup (O(depth), crossing shadow
    // hosts), and layout is read only for candidates that survive it.
    const toControls = (els) => {
      const kept = new Set();      // candidates taken
      const blocked = new Set();   // ancestors of a taken candidate — a later wrapper loses to it
      const out = [];
      const upFrom = (el) => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
      const ancestorKept = (el) => {
        let p = upFrom(el);
        for (let hops = 0; p && hops < 200; hops++, p = upFrom(p)) if (kept.has(p)) return true;
        return false;
      };
      const take = (el) => {
        kept.add(el);
        let p = upFrom(el);
        for (let hops = 0; p && hops < 200; hops++, p = upFrom(p)) blocked.add(p);
      };
      // Same answer as the old pairwise scan: of any containment-related group the
      // FIRST-listed wins (controls are listed before the wrappers around them).
      const related = (el) => kept.has(el) || blocked.has(el) || ancestorKept(el);
      for (const el of els) {
        if (related(el)) continue;
        const role = el.getAttribute && el.getAttribute('role');
        if (role && LANDMARK_ROLES.test(role)) continue;
        if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'hidden') continue;
        let r; try { r = el.getBoundingClientRect(); } catch { continue; }
        let c = { el, visible: fieldVisible(el, r) };
        if (!c.visible && el.tagName === 'SELECT') { const w = widgetFor(el); if (w) c = { el: w, visible: true, backing: el }; }
        if (c.el !== el && related(c.el)) continue;
        take(c.el);
        out.push(c);
      }
      return out.sort((a, b) => (follows(a.el, b.el) ? -1 : follows(b.el, a.el) ? 1 : 0));
    };
    // EVERY control the name could mean, not the first: name/id (explicit) → the
    // first name tier (label, aria-label, placeholder) with a visible match (an
    // EXACT name beats a substring: "Country" is not "Country code") → a titled
    // section's dropdowns (hidden ones included, so a backing select maps to its
    // widget). Hidden-only matches are kept for the miss report.
    const findFields = (fieldRaw, fieldLo) => {
      const nameSel = `[name="${CSS.escape(fieldRaw)}" i]`;
      const all = queryAllDeep(document, `${nameSel},${CONTROLISH},[aria-labelledby],[aria-label],[placeholder],label`);
      const byName = all.find(el => el.matches && el.matches(nameSel));
      if (byName) return toControls([byName]);
      const byId = lookupId(document.documentElement, fieldRaw);
      if (byId) return toControls([byId]);
      const forText = new Map();   // root → (for-id → text of the FIRST such label, as querySelector found it)
      const hitLabels = [];        // labels whose text holds the wanted name
      const pool = [];
      for (const el of all) {
        if (el.tagName !== 'LABEL') { pool.push(el); continue; }
        const t = cleanLabel(el.textContent);
        if (t.toLowerCase().includes(fieldLo)) hitLabels.push(el);
        const f = el.getAttribute('for');
        if (!f) continue;
        const root = el.getRootNode ? el.getRootNode() : document;
        let m = forText.get(root); if (!m) forText.set(root, m = new Map());
        if (!m.has(f)) m.set(f, t);
      }
      const forLookup = (el) => {
        const own = forText.get(el.getRootNode ? el.getRootNode() : document);
        if (own && own.has(el.id)) return own.get(el.id);
        const doc = forText.get(document);
        return doc && doc.has(el.id) ? doc.get(el.id) : null;
      };
      // containerLabel answers with ONE label of the ≤5-ancestor field group, so it
      // can only match when a hit label sits inside that group — skip it otherwise.
      const nearHit = (el) => { let a = el; for (let i = 0; i < 5 && a.parentElement; i++) a = a.parentElement; return hitLabels.some(l => a.contains(l)); };
      // A DROPDOWN is select-like: popup/expanded semantics, or a native form
      // control. Matching on name alone over every [aria-label]/[placeholder]
      // element let a LANDMARK win — GCP's breadcrumb <nav> and its <a>s carry
      // the field name from a nearby label and were reported as "4 visible
      // dropdowns match", so even at full speed the pick was refused. Narrowing
      // here (before the tier loop, not in toControls after it) is also what
      // keeps the scan cheap: the pool drops from every labelled element on the
      // page to the handful that could actually be a dropdown.
      const isSelectish = (el) => { try { return el.matches(SELECTISH); } catch { return false; } };
      const selPool = pool.filter(isSelectish);
      const isCtl = (el) => el.matches && el.matches(CONTROLISH);
      const ordered = selPool.filter(isCtl).concat(selPool.filter(el => !isCtl(el)));
      // Tiers: wired label (for=/wrapping/aria-labelledby) OR a sibling <label> in
      // the same field group (rescues react-select inputs whose only aria-label is
      // an opaque internal id — Greenhouse), then aria-label, then placeholder.
      const tiers = [
        (el) => labelFor(el, forLookup) || (hitLabels.length && nearHit(el) ? containerLabel(el) : ''),
        (el) => el.getAttribute && el.getAttribute('aria-label'),
        (el) => el.getAttribute && el.getAttribute('placeholder'),
      ];
      const wantNorm = normHeading(fieldLo);
      let hiddenOnly = null;
      for (const nameOf of tiers) {
        const hits = [], exact = [];
        for (const el of ordered) {
          const n = nameOf(el);
          if (!n || !n.toLowerCase().includes(fieldLo)) continue;
          hits.push(el);
          if (normHeading(n) === wantNorm) exact.push(el);
        }
        let c = toControls(exact.length ? exact : hits);
        if (!c.some(x => x.visible) && exact.length) c = toControls(hits);
        if (c.some(x => x.visible)) return c;
        if (c.length && !hiddenOnly) hiddenOnly = c;
      }
      // HEADING-TITLED dropdowns: no label/aria/placeholder carries the name, but a
      // heading does (react-select.com's demo: <h4>Single</h4> above an unlabelled
      // combobox; select2.org's "Single select boxes¶"). Every dropdown-ish control
      // in that outline section — same resolver + same "never a page-wide guess"
      // rule as fast_fill's `section`.
      const sec = resolveSection(fieldLo, DROPDOWN_SEL, { hidden: true });
      if (sec.matched && sec.els.length) { const c = toControls(sec.els); if (c.length) return c; }
      return hiddenOnly || [];
    };
    // A candidate as the model sees it in an ambiguity / out-of-range report.
    // `index` = its position among the VISIBLE candidates (what index:N picks).
    const listCands = (cands) => {
      let vi = 0;
      return cands.slice(0, 12).map((c) => {
        const f = describeField(c.el);
        const o = { tag: f.tag };
        if (f.role) o.role = f.role;
        o.label = f.label || f.ariaLabel || f.placeholder || f.name || null;
        if (f.name && f.name !== o.label) o.name = f.name;
        if (f.section) o.section = f.section;
        o.visible = c.visible;
        o.value = shownValueOf(!c.visible || !c.el.isConnected ? (c.backing || c.el) : c.el);
        if (c.visible) o.index = vi++;
        if (c.backing) o.backing = 'hidden <select> behind this widget';
        const ri = rowInfoOf(c.el);
        if (ri) Object.assign(o, ri);
        return o;
      });
    };
    // What a miss could have meant: every visible dropdown-ish control with the
    // name it WOULD match on (label / aria / placeholder / titled section), so the
    // model can retry with a real name instead of falling back to coordinates.
    const dropdownCandidates = () => {
      const out = [];
      try {
        for (const el of queryAllDeep(document, DROPDOWN_SEL)) {
          if (out.length >= 12) break;
          let rect; try { rect = el.getBoundingClientRect(); } catch { continue; }
          if (!fieldVisible(el, rect)) continue;
          const c = { tag: el.tagName.toLowerCase() };
          const role = el.getAttribute('role'); if (role) c.role = role;
          const lbl = labelFor(el) || containerLabel(el); if (lbl) c.label = lbl;
          const al = el.getAttribute('aria-label'); if (al) c.ariaLabel = al;
          const ph = el.getAttribute('placeholder') || (el.getAttribute('aria-describedby') ? resolveIdRefs(el, 'aria-describedby') : null); if (ph) c.placeholder = ph;
          const nm = el.getAttribute('name'); if (nm) c.name = nm;
          if (el.id) c.id = el.id;
          // Nearest preceding heading = the name a titled-section lookup accepts.
          const h = headingAbove(el);
          if (h) c.section = h;
          out.push(c);
        }
      } catch {}
      return out;
    };

    const optText = (o) => (o.textContent || '').trim().toLowerCase();

    // What the control DISPLAYS after the pick — the read-back that `verified`
    // compares against `picked`. The VISIBLE control is read, never a backing
    // <select> behind a widget (it can hold a value the widget does not show).
    const readShown = (el, kind, ctrl) => {
      if (kind === 'react-select' && ctrl) {
        try {
          const vals = Array.from(ctrl.querySelectorAll('[class*="singleValue"],[class*="single-value"],[class*="multiValue__label"],[class*="multi-value__label"]'))
            .map(v => cleanLabel(v.textContent)).filter(Boolean);
          if (vals.length) return vals.join(', ');
        } catch {}
        return shownValueOf(ctrl);
      }
      return shownValueOf(el);
    };
    // Returns as soon as the control's read-back shows the pick and its popup is
    // closed (polled every 30ms), else at the cap — never a fixed DOM-quiet wait,
    // which on a storming page (GCP) always ran to SETTLE_MAX_MS.
    const withReadback = async (res, el, ctrl, timing = {}, pre = {}) => {
      const t0 = nowMs();
      const open = () => { try { return el.getAttribute('aria-expanded') === 'true'; } catch { return false; } };
      let value = '';
      for (;;) {
        value = readShown(el, res.kind, ctrl);
        if (showsValue(value, res.picked) && !open()) break;
        if (nowMs() - t0 >= SETTLE_MAX_MS) break;
        await wait(30);
      }
      timing.readbackMs = Math.round(nowMs() - t0);
      // A control the page tore down during the pick cannot be read back at all —
      // report that, not a value comparison against an empty read.
      const gone = !el || el.isConnected === false;
      const verified = !gone && showsValue(value, res.picked);
      const head = { verified, picked: res.picked, value, field: describeField(el) };
      if (pre.row) head.row = pre.row;
      if (pre.backing) head.backingValue = shownValueOf(pre.backing);
      if (!verified) head.reason = gone
        ? `unreadable: the dropdown is no longer in the page after the pick (replaced or removed by a re-render), so its value cannot be read back — nothing confirms "${res.picked}" was selected; read the page before reporting it`
        : `the dropdown now shows ${JSON.stringify(value)}, not "${res.picked}" — the pick did not take (or landed on another control: see field); do not report it as selected`;
      return frontload({ ...res, timing }, head);
    };

    // Set ONE dropdown. Returns a plain result object (no snapshot) so it can be
    // looped for batch mode. Success { verified, picked, value, field, kind },
    // miss { error, ... }. Shared by both forms. The field lookup is retried
    // until AUTO_WAIT_MS so a control still mounting is not a false miss.
    // Resolve ONE field to ONE visible control, or refuse — never a silent first
    // pick. `section` restricts to one outline section; `index` = N-th VISIBLE
    // candidate in document order. Without either: exactly one visible candidate
    // is taken (a hidden backing select behind a visible widget IS the widget), 2+
    // is an ambiguity error listing each, and a single visible one whose label also
    // exists (hidden) in ANOTHER row of the same repeated row group is refused too.
    const setOne = async (fieldRaw, optionRaw, pick = {}) => {
      const fieldLo = stripPermalink(String(fieldRaw == null ? '' : fieldRaw).toLowerCase());
      const optionText = String(optionRaw == null ? '' : optionRaw);
      if (!fieldLo || !optionText) return { error: 'field and option required' };
      const sectionRaw = String(pick.section ?? '').trim();
      const idxGiven = typeof pick.index === 'number' && pick.index >= 0;

      const t0 = nowMs();
      const timing = {};   // performance.now() marks per phase, reported on every result
      let cands = [], secErr = null;
      const resolve = () => {
        cands = findFields(fieldRaw, fieldLo);
        if (!sectionRaw) return;
        const sec = resolveSection(sectionRaw, DROPDOWN_SEL);
        if (!sec.matched) { secErr = { error: `section "${sectionRaw}" not found — no heading/legend/[role=heading] matches it, so nothing was selected (refusing a page-wide match). Use one of \`sections\`, or index:N.`, sections: sec.sections.slice(0, 40) }; cands = []; return; }
        cands = cands.filter(c => sec.inSpan(c.el) || (c.backing && sec.inSpan(c.backing)));
      };
      resolve();
      while (!secErr && !cands.some(c => c.visible) && nowMs() - t0 < AUTO_WAIT_MS) { await wait(150); resolve(); }
      timing.resolveMs = Math.round(nowMs() - t0);
      if (secErr) return secErr;
      // Row/ambiguity resolution is its OWN timed phase: when this went super-linear
      // (9d18d4d) the call died on the 20s deadline with every reported phase cheap,
      // so nothing pointed at it.
      const tRows = nowMs();
      const rowsDone = () => { timing.rowsMs = Math.round(nowMs() - tRows); return timing; };
      // a hidden candidate in a row (or widget) that already has a VISIBLE one is that
      // row's widget internals (Choices' search input), not another copy of the field
      {
        const visRows = cands.filter(c => c.visible).map(c => (rowContextOf(c.el) || {}).row || c.el.parentElement);
        cands = cands.filter(c => c.visible || !visRows.some(r => r && r.contains(c.backing || c.el)));
      }
      const vis = cands.filter(c => c.visible);
      const where = sectionRaw ? ` in section "${sectionRaw}"` : '';
      if (!vis.length) {
        const act = pageActivity();
        return { error: `field "${fieldRaw}" not found${where} — no visible dropdown/combobox/select carries that label, aria-label, placeholder, name, id, or titled section. Nothing was changed. Retry with one of the names in \`candidates\`.`, waitedMs: Math.round(nowMs() - t0), settling: act.settling, ...(act.settling ? { hint: 'the page was still changing — the control may not be rendered yet: fast_wait for text that identifies its view, then retry' } : {}), ...(cands.length ? { hiddenMatches: listCands(cands) } : {}), ...(lastWalk && lastWalk.truncated ? { scan: { truncated: lastWalk.truncated, rootsScanned: lastWalk.roots, nodesScanned: lastWalk.nodes, ms: lastWalk.ms }, hint: `this page is too large to scan by name — the search stopped after ${lastWalk.truncated} (${lastWalk.nodesScanned || lastWalk.nodes} composed nodes across ${lastWalk.roots} roots/frames), so the control may exist but was never reached. Target it by the id from fast_snapshot, or narrow the search with section:"<heading>" or index:N.` } : {}), candidates: dropdownCandidates(), timing: rowsDone() };
      }
      const hiddenRows = (c) => cands.filter(o => !o.visible && o.el !== c.el && inOtherRow(c.el, [o.backing || o.el]));
      let chosen = null;
      if (idxGiven) {
        if (pick.index >= vis.length) return { error: `Only ${vis.length} visible dropdown(s) match ${JSON.stringify(fieldRaw)}${where}, index ${pick.index} out of range — nothing was selected`, candidates: listCands(cands), hint: 'index counts the VISIBLE candidates in document order (see each candidate\'s index / row); a hidden one appears only after another step in its row' };
        chosen = vis[pick.index];
      } else if (vis.length > 1 || (!sectionRaw && hiddenRows(vis[0]).length)) {
        const list = listCands(cands);
        const hidden = list.filter(c => !c.visible && c.row != null).map(c => c.row);
        return { error: `${vis.length} visible dropdown(s) match ${JSON.stringify(fieldRaw)}${where}${hidden.length ? ` and it also exists (hidden) in row(s) ${hidden.join(', ')}` : ''} — nothing was selected`, candidates: list, hint: `pass index:N (0..${vis.length - 1}, the VISIBLE candidates in document order — each candidate names its row/section) or section:"<heading>" to pick one${hidden.length ? '; a hidden row\'s dropdown appears only after another step in that row' : ''}` };
      } else chosen = vis[0];
      let field = chosen.el;
      const backing = chosen.backing || null;
      const pre = { backing, row: rowInfoOf(field) };   // before the pick: a re-render can detach the field
      rowsDone();
      try { const r = field.getBoundingClientRect(); if (r.bottom < 0 || r.top > window.innerHeight) field.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {}

      if (field.tagName === 'SELECT') {
        const all = Array.from(field.options);
        const target = pickByText(all, o => (o.text || '').trim().toLowerCase(), optionText)
                    || all.find(o => (o.value || '').toLowerCase() === optionText.toLowerCase());
        if (!target) return { error: 'option not found in <select>', field: describeField(field), available: all.map(o => o.text) };
        const tp = nowMs();
        field.value = target.value;
        // composed:true so a validator listening OUTSIDE the select's shadow root
        // (web-component / Angular-Material composite control) revalidates — a
        // non-composed change does not cross the shadow boundary (GitHub #1).
        field.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        timing.pickMs = Math.round(nowMs() - tp);
        return withReadback({ picked: target.text, kind: 'native-select' }, field, null, timing, pre);
      }

      // react-select detection must be CLASS-PREFIX-AGNOSTIC. The classNamePrefix
      // is configurable: the default build uses `react-select__control`, but many
      // sites (Greenhouse) set prefix="select" → `select__control`. Matching only
      // `.react-select__control` missed those, so the field fell through to the
      // generic ARIA branch below, which opened the wrong widget and returned the
      // FIRST react-select's options on the page (the intl phone-country dial-code
      // list). `[class*="select__control"]` covers both prefixes; the
      // react-select-<N>-input id (always present regardless of prefix) is a
      // structural fallback for any other custom prefix.
      const rsInput = (field.matches && field.matches('input[id^="react-select-"]')) ? field
        : (field.querySelector && field.querySelector('input[id^="react-select-"]')) || null;
      let ctrl = field.closest('[class*="select__control"]');
      if (!ctrl && rsInput) ctrl = rsInput.closest('[class*="__control"]');
      // No classNamePrefix at all → emotion-only classes (`css-1y6m8t7-control`,
      // react-select.com's own demos): the control is the nearest ancestor with a
      // class token ENDING in "control". Bounded climb from the input.
      if (!ctrl && rsInput) {
        let p = rsInput.parentElement;
        for (let hops = 0; p && hops < 6 && !ctrl; hops++, p = p.parentElement) {
          if (/(?:^|\s)[\w-]*control(?:\s|$)/i.test(String(p.className || ''))) ctrl = p;
        }
      }
      if (ctrl) {
        // Open state: the `--menu-is-open` modifier only exists WITH a prefix;
        // aria-expanded on the combobox input is always maintained.
        const menuOpen = /--menu-is-open/.test(ctrl.className) || (rsInput && rsInput.getAttribute('aria-expanded') === 'true');
        const tOpen = nowMs();
        // react-select opens on the control's MOUSEDOWN (onControlMouseDown), not
        // on click — a bare .click() only ever worked when the typed filter text
        // opened the menu, which a non-searchable (dummy-input) select never does.
        if (!menuOpen) pointerSeq(ctrl);
        await wait(250);
        const input = rsInput || ctrl.querySelector('input[id^="react-select-"]') || (field.tagName === 'INPUT' ? field : null);
        if (input) {
          input.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, optionText);
          input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          await wait(400);
        }
        // SCOPE options to THIS react-select instance. Each instance's options are
        // ids `react-select-<N>-option-<M>`, so an id-prefix query can only ever
        // return THIS control's options — it can NOT fall back to another
        // react-select (the phone-country widget) elsewhere on the page. Fall back
        // to the id-derived listbox, then the control's own menu container, never a
        // global first-match [role=listbox].
        const instId = input?.id ? input.id.replace(/-input$/, '') : null; // react-select-<N>
        let opts = [];
        if (instId) opts = Array.from(document.querySelectorAll(`[id^="${instId}-option"]`));
        if (!opts.length) {
          const listbox = (instId && document.getElementById(`${instId}-listbox`))
            || (ctrl.parentElement && ctrl.parentElement.querySelector('[class*="select__menu"]'))
            || null;
          opts = listbox ? Array.from(listbox.querySelectorAll('[id*="-option-"], [role="option"]')) : [];
        }
        const target = pickByText(opts, optText, optionText);
        timing.openMs = Math.round(nowMs() - tOpen);
        if (!target) {
          return { error: 'no matching option in react-select', tried: optionText, kind: 'react-select', field: describeField(field), instance: instId || undefined, available: opts.slice(0, 10).map(o => (o.textContent || '').trim()), timing };
        }
        const tp = nowMs();
        pointerSeq(target);
        timing.pickMs = Math.round(nowMs() - tp);
        return withReadback({ picked: (target.textContent || '').trim(), kind: 'react-select', opened: menuOpen ? 'already' : 'mousedown' }, field, ctrl, timing, pre);
      }

      // Generic ARIA listbox / menu (the ARIA contract only: role=combobox|button
      // + aria-haspopup / aria-expanded / aria-controls|aria-owns → role=listbox
      // with role=option|menuitem — no framework selectors). Options resolve
      // SYNCHRONOUSLY from (1) the panel aria-controls/aria-owns names, (2) the
      // portal/overlay sweep, (3) the index's option side-set — VISIBLE ones only
      // (a closed APG listbox keeps its options in the DOM under display:none).
      // OPEN CHAIN when no panel is open: click the trigger → ArrowDown → Enter,
      // each followed by a MutationObserver wait for the panel (no timer loop);
      // `opened` says which step worked, `opened:false` + `tried` when none did.
      const optTextLo = optionText.toLowerCase();
      const OPTION_SEL = '[role="option"],[role="treeitem"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],li[data-value],[data-option-value]';
      const visibleOnly = (els) => {
        const out = [];
        for (let i = 0; i < els.length && i < 400; i++) { let r; try { r = els[i].getBoundingClientRect(); } catch { continue; } if (visible(els[i], r)) out.push(els[i]); }
        return out;
      };
      // Cheap: the panel the control names (attribute reads + that panel's rects).
      const ariaOptionEls = () => {
        for (const id of ariaPanelIds(field)) {
          const panel = lookupId(field, id) || document.getElementById(id);
          if (!panel) continue;
          const els = visibleOnly(panel.querySelectorAll(OPTION_SEL));
          if (els.length) return { els, via: 'aria-controls' };
        }
        return null;
      };
      // Expensive: document-wide overlay sweep (walk + indexing), then the index's
      // options. Never ANOTHER widget's options: an option inside a different
      // combobox (Choices draws each widget's selected value as a role=listbox of
      // role=option — Form.io's rows then offered Mary's "Female" to Ada's field).
      const ownFirst = (els) => els.filter(o => field.contains(o)).concat(els.filter(o => !field.contains(o)));
      const ownOption = (o) => { const c = o.closest && o.closest('[role="combobox"]'); return !c || c === field || c === trigger || c.contains(field) || field.contains(c); };
      const sweptOptionEls = () => {
        let swept = null; try { swept = collectOverlayEls(); } catch {}
        if (swept && swept.size) {
          const els = ownFirst(visibleOnly([...swept].filter(el => el.matches && el.matches(OPTION_SEL) && ownOption(el))));
          if (els.length) return { els, via: 'overlay' };
        }
        const els = [];
        for (const el of INDEX.options) if (el.isConnected && ownOption(el)) els.push(el);
        return { els: ownFirst(visibleOnly(els)), via: 'index' };
      };
      const optionEls = () => ariaOptionEls() || sweptOptionEls();
      // The element that opens the list: the field itself when it is the
      // combobox/popup button, else the first such descendant (a labelled
      // wrapper around a role=combobox host).
      const OPENER_SEL = '[role="combobox"],[aria-haspopup],[role="listbox"],button,[role="button"]';
      const trigger = (field.matches && field.matches(OPENER_SEL)) ? field : ((field.querySelector && field.querySelector(OPENER_SEL)) || field);
      const expanded = () => {
        try {
          if (trigger.getAttribute('aria-expanded') === 'true' || field.getAttribute('aria-expanded') === 'true') return true;
          return !!(field.querySelector && field.querySelector('[aria-expanded="true"]'));
        } catch { return false; }
      };
      // "Open" = visible options in a panel this field names, or swept options
      // while the control says aria-expanded="true" when it declares that state at
      // all (its own always-visible selected-value list is not its popup: Choices
      // draws it as role=listbox/option), else overlay options — never bare index
      // options (another widget's).
      const declaresExpanded = () => { try { return trigger.hasAttribute('aria-expanded') || field.hasAttribute('aria-expanded'); } catch { return false; } };
      const sweptOpen = () => {
        const f = sweptOptionEls();
        if (!f.els.length) return null;
        if (declaresExpanded()) return expanded() ? f : null;
        return f.via !== 'index' ? f : null;
      };
      const panelOpen = () => ariaOptionEls() || sweptOpen();
      // Mutations only SCHEDULE a probe (one pending macrotask, ≥30ms out): a
      // probe inside the MutationObserver callback reads layout in the middle of
      // the page's own render work, and under a render storm that back-to-back
      // forced layout starved the very panel we were waiting for (GCP open 2.8s).
      // Each probe is the cheap aria-named panel; the document-wide sweep runs at
      // most every 250ms. A 100ms tick covers shadow-root panels the observer misses.
      const waitForPanel = (capMs) => new Promise((resolve) => {
        const t0 = nowMs(); let done = false, mo = null, timer = null, due = 0, lastSweep = t0;
        const finish = (f) => { if (done) return; done = true; try { if (mo) mo.disconnect(); } catch {} clearTimeout(timer); resolve(f); };
        const schedule = (ms) => {
          if (done) return;
          const at = nowMs() + ms;
          if (timer && due <= at) return;
          clearTimeout(timer); due = at; timer = setTimeout(probe, ms);
        };
        const probe = () => {
          timer = null;
          if (done) return;
          let f = ariaOptionEls();
          if (!f && nowMs() - lastSweep >= 250) { lastSweep = nowMs(); f = sweptOpen(); }
          if (f) return finish(f);
          if (nowMs() - t0 >= capMs) return finish(null);
          schedule(100);
        };
        try { mo = new MutationObserver(() => schedule(30)); mo.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded', 'aria-controls', 'aria-owns', 'hidden', 'style', 'class'] }); } catch {}
        schedule(0);
      });
      const key = (el, k) => { const o = keyInit(k); el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keyup', o)); };
      const tOpen = nowMs();
      const tried = [];
      let opened = 'already';
      let panel = panelOpen();
      if (!panel) {
        tried.push('click'); opened = 'click';
        try { trigger.focus(); } catch {}
        pointerSeq(trigger);
        panel = await waitForPanel(1500);
      }
      if (!panel) {
        tried.push('ArrowDown'); opened = 'ArrowDown';
        key(trigger, 'ArrowDown');
        panel = await waitForPanel(600);
      }
      // Enter only on a non-text trigger that does not claim to be open already
      // (on an open-but-unseen list Enter would commit its highlighted entry).
      if (!panel && !/^(INPUT|TEXTAREA)$/.test(trigger.tagName) && !expanded()) {
        tried.push('Enter'); opened = 'Enter';
        key(trigger, 'Enter');
        panel = await waitForPanel(600);
      }
      if (!panel) opened = false;
      timing.openMs = Math.round(nowMs() - tOpen);
      const pickOption = (els) => {
        let exact = null, starts = null, sub = null;
        for (const el of els) {
          const t = (el.textContent || '').trim().toLowerCase();
          if (!t) continue;
          if (t === optTextLo) { exact = el; break; }
          if (!starts && t.startsWith(optTextLo)) starts = el;
          if (!sub && t.includes(optTextLo)) sub = el;
        }
        return exact || starts || sub;
      };
      // Options may still stream in after the panel opens (async / virtual
      // lists): re-probe until the wanted one shows, WALL CLOCK capped (a
      // starved timer on a storming page is reported, never run past budget).
      const budgetMs = args.timeoutMs || 3000;
      const tStart = nowMs();
      // A list that has stopped changing (same options for LIST_SETTLED_MS) will not
      // grow the wanted one: stop there instead of polling out the whole budget
      // (live Azure: 3.1s on a one-entry list that had settled at once).
      const LIST_SETTLED_MS = 600;
      let target = null, via = null, found = panel || optionEls(), starved = false;
      let sig = '', sigAt = nowMs();
      for (let tick = 0; ; tick++) {
        if (tick) { drainPendingSync(2000, 30); found = optionEls(); }
        target = pickOption(found.els);
        if (target) { via = found.via; break; }
        if (!opened || nowMs() - tStart >= budgetMs) break;   // nothing opened: report now, no 3s poll
        const nowSig = found && found.els.length ? `${found.els.length}|${(found.els[found.els.length - 1].textContent || '').trim()}` : '';
        if (nowSig !== sig) { sig = nowSig; sigAt = nowMs(); }
        else if (nowSig && nowMs() - sigAt >= LIST_SETTLED_MS) {
          // …unless the list says it is still loading (async search lists show a
          // "Loading…" row or aria-busy until the results arrive)
          let busy = false;
          try { busy = found.els.some((el) => /^\s*(loading|searching)\b/i.test(el.textContent || '')) || !!document.querySelector('[aria-busy="true"]'); } catch {}
          if (!busy) break;
        }
        const before = nowMs();
        await wait(50);
        if (nowMs() - before > 1000) starved = true;   // the timer slept far past its 50ms: main thread starved
      }
      if (target) {
        const tp = nowMs();
        pointerSeq(target);   // Select2 commits on mouseup, Choices on mousedown — a bare click() on neither
        timing.pickMs = Math.round(nowMs() - tp);
        return withReadback({ picked: cleanLabel(target.textContent), kind: 'aria-listbox', via, opened }, field, null, timing, pre);
      }
      const available = found ? found.els.slice(0, 10).map(el => (el.textContent || '').trim()).filter(Boolean) : [];
      const base = { tried: optionText, field: describeField(field), opened, elapsedMs: Math.round(nowMs() - t0), timing, panelIds: ariaPanelIds(field), available };
      if (!opened) return { error: `could not open the dropdown "${fieldRaw}" — no options appeared after ${tried.join(' / ')} on its trigger (${trigger.tagName.toLowerCase()}${trigger.getAttribute('role') ? ` role=${trigger.getAttribute('role')}` : ''}); nothing was changed`, triedOpen: tried, ...base, hint: 'fast_click the control and read the auto-snapshot for what opened; if the options are drawn on canvas / in a cross-origin frame, take fast_screenshot and use fast_click_xy' };
      if (available.length && !starved) {
        // the list opened, settled, and the value is not in it: close it again (an open
        // list would swallow the next action) and say what it does offer
        try { if (expanded()) key(trigger, 'Escape'); } catch {}
        const total = found.els.filter((el) => (el.textContent || '').trim()).length;
        return {
          error: `${JSON.stringify(optionText)} is not an option of ${JSON.stringify(fieldRaw)} — the open list offers ${total} option(s); nothing was selected`,
          ...base,
          hint: `pick one of \`available\`${total > available.length ? ` (the first ${available.length} of ${total})` : ''}; a value that does not exist yet has to be created first — use the page's own create control for this field (e.g. a "Create new" link next to it), then select it`,
        };
      }
      return { error: 'no matching option in the open list', ...base, ...(starved ? { starved: true, hint: 'the page was re-rendering so heavily that timers starved; retry once the view settles (fast_wait for text of the finished state), or fast_click the option text directly' } : {}) };
    };

    // BATCH mode: a { field: option } map sets many dropdowns in one call —
    // each resolved + set in document via setOne, looped. An explicit single
    // field+option passed alongside is merged in (the selections map wins on a
    // key collision). Returns a per-field results map (like fast_fill_form).
    const selections = (args.selections && typeof args.selections === 'object' && !Array.isArray(args.selections))
      ? args.selections : null;
    const topPick = { index: args.index, section: args.section ?? args.near };
    // dryRun (the background's frame reach): does THIS document hold each named
    // dropdown? found / ambiguous (several visible, no index) / missing. Nothing
    // is opened or picked, and there is no auto-wait.
    if (args.dryRun) {
      const keys = selections ? Object.keys(selections) : [];
      if (args.field != null && !keys.includes(String(args.field))) keys.push(String(args.field));
      const fields = {};
      for (const k of keys) {
        const spec = selections && selections[k] && typeof selections[k] === 'object' ? selections[k] : {};
        const idx = typeof (spec.index ?? args.index) === 'number';
        const vis = findFields(k, stripPermalink(String(k).toLowerCase())).filter((c) => c.visible);
        fields[k] = !vis.length ? 'missing' : (vis.length > 1 && !idx ? 'ambiguous' : 'found');
      }
      return { dryRun: true, fields };
    }
    if (selections) {
      const combined = { ...selections };
      if (args.field != null && args.option != null && !(args.field in combined)) {
        combined[args.field] = { option: args.option, ...topPick };
      }
      // `picked` counts only picks whose read-back VERIFIED; the wrapper's
      // verified is the AND of its fields (h_repeat: a field with verified:false
      // under a wrapper saying verified:true, picked:1 passed the report gate).
      const results = {};
      let picked = 0, failed = 0;
      for (const [fieldKey, raw] of Object.entries(combined)) {
        const spec = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { option: raw };
        const r = await setOne(fieldKey, spec.option ?? spec.value, { index: spec.index, section: spec.section ?? spec.near });
        results[fieldKey] = r;
        if (r && !r.error && r.verified === true) picked++; else failed++;
      }
      const total = Object.keys(combined).length;
      const head = { verified: failed === 0 && picked === total, picked, failed, total };
      if (failed) head.summary = `${picked}/${total} selected; not done: ${Object.keys(results).filter(k => !(results[k] && !results[k].error && results[k].verified === true)).join(', ')}`;
      const out = await withSnap({ ...head, results });
      return calmIfVerified(frontload(out, head));
    }

    // Single form: success wrapped with a fresh snapshot, misses returned plain.
    // A verified pick is settled by definition: the snapshot waits one short
    // quiet window, not the full SETTLE_MAX_MS (1s on a storming page).
    const r = await setOne(args.field, args.option, topPick);
    if (!r || r.error) return r;
    const ts = nowMs();
    const out = await withSnap(r, undefined, { settleMs: r.verified ? 150 : SETTLE_MAX_MS });
    if (r.timing) r.timing.snapshotMs = Math.round(nowMs() - ts);
    return calmIfVerified(out);
  }

  if (action === 'fast_click') {
    // Target lookup, retried until AUTO_WAIT_MS (a control still mounting after
    // a view change is not a miss yet). A miss after the wait is real.
    const t0 = nowMs();
    let snap, matches;
    // Tag names are accepted as role aliases (role:"a" = a link, role:"button"
    // = a <button> or [role=button]) — models mix the two; a mismatch used to
    // refuse the very links it listed under `available`.
    const TAG_AS_ROLE = { a: 'link' };
    const wantRole = args.role ? String(args.role).toLowerCase() : null;
    // A script-only target's implicit role is "generic" (an <a> without href is one,
    // per HTML-AAM); a label-proxied radio/checkbox also answers to "label".
    const roleOk = (m) => {
      if (!wantRole) return true;
      const explicit = (m.role || '').toLowerCase();
      const implicit = m.clickable ? 'generic' : implicitRoleOf(m.tag, m.type);
      if (wantRole === 'label' && m.via === 'label') return true;
      if (m.clickable && m.tag === 'a' && wantRole === 'link') return true;   // models call every <a> a link
      return explicit === wantRole || implicit === wantRole
        || m.tag === wantRole || (TAG_AS_ROLE[wantRole] && (explicit === TAG_AS_ROLE[wantRole] || implicit === TAG_AS_ROLE[wantRole]));
    };
    // The element's OWN role attribute: an explicit role:"combobox" means the
    // [role=combobox] widget, not a native <select> whose IMPLICIT role is also
    // combobox (select2.org: the call clicked the un-enhanced twin select).
    const attrRole = (m) => { const e = elById(m.i); return !!e && (e.getAttribute('role') || '').toLowerCase() === wantRole; };
    const pointerOk = (!wantRole || wantRole === 'generic') && !args.tag;
    let pointerHit = null, pointerTried = false;
    const NATIVE_CLICK = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|LABEL|SUMMARY|OPTION|AREA)$/;
    const OPTIONISH = '[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="treeitem"]';
    // id-first: `id` is a snapshot item's `i`. It is used only while that element
    // is still in the page and (when text is also given) still carries the text;
    // otherwise the call falls back to text (idStale:true) or refuses without text.
    // Ids as the caller sees them: "f<frameId>:" when this document is a frame the
    // background addressed (frames.js passes idPrefix), bare in the top document.
    const idP = typeof args.idPrefix === 'string' ? args.idPrefix : '';
    const hasText = args.text != null && String(args.text).trim() !== '';
    const hasId = args.id != null && args.id !== '';
    if (!hasText && !hasId) {
      // No text and no id names no element. An `index` counts matches of `text`; without
      // text it is NOT an item id — reading it as one clicked the wrong control (live Azure
      // 5a6edf40: {tag:"button", index:11} meant "the 12th button" and clicked item 11, the
      // Advanced wizard tab). Refused, whatever else is given.
      return { error: `fast_click needs a target — pass id:"${idP}<i>" (an item's i from fast_snapshot) or text:"<label>"${typeof args.index === 'number' ? '; index only picks among matches of text, it is not an item id' : ''}; nothing was clicked`, code: 'no_target' };
    }
    let preMatched = null;
    let missAt = AUTO_WAIT_MS, missExtended = false;
    if (hasId) {
      // An id acts only on the element a snapshot SHOWED under that id, still carrying the
      // label it showed: an id no snapshot of this document listed (a guess, or one from a
      // page since reloaded), an element since removed, or one the page re-labelled in place
      // (a reused "Next" that now reads "Create") is refused — never clicked.
      const want = Number(args.id);
      const shownRec = INDEX.served ? INDEX.served.get(want) : undefined;   // read BEFORE anything re-serializes
      const shown = shownRec ? shownRec.label : undefined;
      const el0 = Number.isFinite(want) ? elById(want) : null;
      snap = await serializeSnapshot(false, { matchAll: true });
      let it = el0 && el0.isConnected ? snap.items.find((x) => x.i === want) : null;
      // still in the page but not in this pass (a heavy page's serialize ran out of budget, or
      // the element is mid-animation): read that one element directly instead of calling it gone
      let hiddenNow = false;
      if (!it && el0 && el0.isConnected) {
        try {
          indexElement(el0);
          const e = INDEX.byEl.get(el0);
          let r = el0.getBoundingClientRect();
          if (e && e.kind === 'click' && !visible(el0, r)) { const pr = labelProxyRect(el0); if (pr) r = pr; else hiddenNow = true; }
          if (e && e.kind === 'click' && !hiddenNow) {
            const off = offsetFor(el0);
            it = { i: e.id, tag: e.tag, text: e.text, x: Math.round(r.x + off.ox), y: Math.round(r.y + off.oy), w: Math.round(r.width), h: Math.round(r.height),
              ...(e.role ? { role: e.role } : {}), ...(e.label ? { label: e.label } : {}), ...(e.ariaLabel ? { ariaLabel: e.ariaLabel } : {}), ...(e.type ? { type: e.type } : {}) };
            snap.items.push(it);
          }
        } catch {}
      }
      // read the element LIVE: the index entry can hold stale text (text-node edits are not
      // observed), and stale text would let a relabelled control pass as the one listed
      let now = null;
      if (it) { try { const fresh = makeClickEntry(el0); now = servedLabel({ label: fresh.label || (it.label && fresh.ariaLabel) || (it.label && fresh.placeholder) || (it.label && fresh.name) || null, ariaLabel: fresh.ariaLabel, text: fresh.text }); } catch { now = servedLabel(it); } }
      const why = !Number.isFinite(want) ? `id ${JSON.stringify(args.id)} is not an item id`
        : shown === undefined ? `id ${idP}${want} was not listed by any snapshot of this page`
        : (!it && hiddenNow) ? `id ${idP}${want} ("${shown}") is on the page but not visible (hidden, collapsed or zero-size)`
        : !it ? `id ${idP}${want} ("${shown}") is no longer on the page (the element was re-rendered or removed)`
        : now !== shown ? `id ${idP}${want} was "${shown}" when listed and now reads "${now}"`
        : (hasText && !matchItems([it], args.text).length) ? `id ${idP}${want} ("${now}") does not carry the text ${JSON.stringify(args.text)}`
        : (wantRole && !roleOk(it)) ? `id ${idP}${want} is a <${it.tag}>${it.role ? ` role=${it.role}` : ''}, not role "${args.role}"`
        : null;
      if (!why) preMatched = [it];
      else if (!it && shownRec && shown) {
        // RE-RESOLVE a re-rendered element (a picker panel rebuilds its option list between the
        // read and the click): act only on exactly ONE element now visible in this document
        // with the SAME label and the same kind (role, else tag). Zero or several: refused as
        // before. A relabelled node never matches, so this cannot act on "Create" for "Next".
        // Several same-label matches that are ONE control (a card and the radio inside it, a
        // <label> and the input it labels) count once; the member acted on must be the kind shown.
        const cands = snap.items.filter((x) => !x.offscreen && servedLabel(x) === shown).map((x) => ({ x, el: elById(x.i) })).filter((c) => c.el);
        const oneControl = (a, b) => { try { return a.el.contains(b.el) || b.el.contains(a.el) || (a.el.tagName === 'LABEL' && a.el.control === b.el) || (b.el.tagName === 'LABEL' && b.el.control === a.el); } catch { return false; } };
        const groups = [];
        for (const c of cands) { const g = groups.find((gr) => gr.some((m) => oneControl(m, c))); if (g) g.push(c); else groups.push([c]); }
        let kinded = groups.length === 1 ? groups[0].filter((c) => itemKind(c.x) === shownRec.kind) : [];
        if (kinded.length > 1) kinded = kinded.filter((c) => c.x.tag === shownRec.tag);   // a card div and its radio input share role radio
        if (kinded.length === 1) { preMatched = [kinded[0].x]; args.__reResolved = true; }
      }
      if (preMatched) { /* acted below */ }
      else if (!hasText) return { error: `${why} — nothing was clicked; take a fresh fast_snapshot and pass the id it lists, or text:"<label>"`, idStale: true, ...(now ? { labelNow: now } : {}) };
      else args.__idStale = true;
    }
    for (;;) {
      if (preMatched) { matches = preMatched; break; }
      snap = await serializeSnapshot(false, { matchAll: true });
      // Filter by role/tag BEFORE ranking. Previously the wrong-TYPE top text match
      // won the slot and the post-rank filter then emptied the list (e.g. a plain
      // <a> "External" beating the radio, then role="radio" dropping the <a> →
      // 0 results). When neither is given, matchScore's control-preference biases
      // toward real controls over generic links/text.
      let pool = snap.items;
      if (wantRole) pool = pool.filter(roleOk);
      if (args.tag) {
        const wantTag = String(args.tag).toLowerCase();
        pool = pool.filter(m => m.tag === wantTag || (wantTag === 'label' && m.via === 'label'));
      }
      matches = matchItems(pool, args.text);
      // Prefer an ancestor control over a matched descendant / label-wrapped link
      // competing for the same text (radio named by its <label>; checkbox beside
      // "I agree to the <a>Policy</a>").
      matches = dropRedundantDescendantLinks(matches);
      // An open dialog is what the user is looking at: when it holds a match, the page
      // behind it does not compete (its "OK" is not the dialog's OK).
      if (matches.length > 1 && matches.some((m) => m.inDialog)) matches = matches.filter((m) => m.inDialog);
      // An explicit role attribute beats an implicit match of the same role.
      if (wantRole && matches.length > 1) { const own = matches.filter(attrRole); if (own.length) matches = own; }
      // dryRun (the background's frame reach): is there anything to click here? one
      // look, no auto-wait, nothing clicked
      if (args.dryRun) {
        const other = !matches.length && (suggestionByText(args.text) || (pointerOk && textTargetByText(args.text)));
        return { dryRun: true, found: matches.length > 0 || !!other, count: matches.length || (other ? 1 : 0),
          ...(matches.length ? { best: { ...matchBrief(matches[0]), ...(typeof matches[0].x === 'number' ? { x: matches[0].x, y: matches[0].y, w: matches[0].w, h: matches[0].h } : {}) } } : {}) };
      }
      if (matches.length) break;
      // Not an index entry: an entry of the OPEN suggestion list (autocomplete
      // rows on Google Maps) — commit it with a real mousedown/click sequence.
      const sOpt = suggestionByText(args.text);
      if (sOpt) {
        const urlBefore0 = location.href;
        let sr; try { sr = sOpt.el.getBoundingClientRect(); } catch { sr = null; }
        const off0 = offsetFor(sOpt.el);
        const clicked = { tag: sOpt.el.tagName.toLowerCase(), role: sOpt.el.getAttribute('role') || undefined, text: cleanLabel(sOpt.el.textContent).slice(0, 120),
          ...(sr ? { x: Math.round(sr.x + off0.ox + sr.width / 2), y: Math.round(sr.y + off0.oy + sr.height / 2), w: Math.round(sr.width), h: Math.round(sr.height) } : {}) };
        const how = await commitSuggestion(sOpt);
        if (!how.committed) {
          // Synthetic events did not take: say so (never a false "clicked") and hand over the trusted path.
          return { error: `suggestion "${clicked.text}" is on screen but the control did not accept a synthetic pick (still open, value unchanged). Nothing changed.`, suggestion: clicked, hint: `fast_click_xy at x:${clicked.x}, y:${clicked.y} (trusted click) commits it; or press the control's own search/go button` };
        }
        const out0 = await withSnap({ clicked, fromSuggestions: true }, snap);
        const head0 = { clicked, fromSuggestions: true, via: how.via, url: location.href, urlChanged: location.href !== urlBefore0, value: maskIfPassword(sOpt.input, String(liveValueOf(sOpt.input) || '').slice(0, 200)) };
        const still = openSuggestions(document.activeElement); if (still) Object.assign(head0, still);
        return frontload(out0, head0);
      }
      // Not an index entry either: a visible pointer-cursor element that carries
      // exactly this text is a (weak) click target — never "nothing to click".
      if (pointerOk && (!pointerTried || nowMs() - t0 >= AUTO_WAIT_MS)) {
        pointerTried = true;
        pointerHit = textTargetByText(args.text);
        if (pointerHit) break;
      }
      if (nowMs() - t0 >= missAt) {
        // the document is visibly mid-render (a mutation in the last 300ms): one more short
        // look, ≤800ms, before answering "No element matching" (a picker panel rebuilding)
        if (!missExtended && INDEX.lastMutMs && nowMs() - INDEX.lastMutMs < 300) {
          missExtended = true;
          missAt = Math.round(nowMs() - t0) + 800;
          await wait(100);
          continue;
        }
        const act = pageActivity();
        const tail = { waitedMs: Math.round(nowMs() - t0), settling: act.settling, ...(act.settling ? { hint: 'the page was still changing when this gave up — the element may not be rendered yet: fast_wait for text that identifies its view, then click again' } : {}) };
        const preFilter = matchItems(snap.items, args.text);
        if (preFilter.length > 0 && (args.role || args.tag)) {
          const qual = [];
          if (args.role) qual.push(`role="${args.role}"`);
          if (args.tag) qual.push(`tag="${args.tag}"`);
          const available = preFilter.slice(0, 8).map(matchBrief);
          const kinds = [...new Set(available.map(m => `<${m.tag}>` + (m.role ? ` role=${m.role}` : '')))].join(', ');
          const sel = selectHintFor(elById(preFilter[0].i));
          return {
            error: `Found ${preFilter.length} match(es) for "${args.text}" but none satisfied ${qual.join(' and ')}. Nothing was clicked — retry with one of \`available\` (drop the role/tag or use its text).`,
            ...tail,
            hint: sel ? sel.hint : `the matches are ${kinds} — drop role/tag, or pass the role they actually have`,
            ...(sel ? { selectField: sel.selectField } : {}),
            available,
          };
        }
        // A heading that titles a dropdown ("Single" over an unlabelled
        // react-select) is not clickable — say which tool takes that name.
        let secHint = null;
        try { const sec = resolveSection(String(args.text || '').toLowerCase(), DROPDOWN_SEL); if (sec.matched && sec.items.length) secHint = { hint: `"${args.text}" is a heading over a dropdown, not a control; use fast_select_option {field:${JSON.stringify(args.text)}, option:"<choice>"}` }; } catch {}
        // VIRTUALIZED VIEW: a scroll container holding far more content than it
        // shows renders only the rows in view, so "no element" can also mean "not
        // scrolled there yet" — that row is not in the DOM at all, and no amount of
        // re-matching will find it. Name the containers (hit-test a few viewport
        // points and climb — the cheap path fast_scroll already uses) so the miss
        // says what to do next instead of reading as "absent".
        const scrollHosts = () => {
          const out = [], seen = new Set();
          const W = window.innerWidth, H = window.innerHeight;
          for (const [px, py] of [[W / 2, H / 2], [W / 2, H / 4], [W / 2, H * 3 / 4], [W / 4, H / 2], [W * 3 / 4, H / 2]]) {
            let e = null; try { e = document.elementFromPoint(px, py); } catch {}
            for (let d = 0; e && d < 20 && out.length < 3; d++, e = e.parentElement) {
              if (seen.has(e)) continue;
              seen.add(e);
              let cs = null; try { cs = getComputedStyle(e); } catch { continue; }
              if (!cs || !/(auto|scroll|overlay)/.test(cs.overflowY)) continue;
              if (e.clientHeight < 100 || e.scrollHeight < e.clientHeight * 2) continue;
              const cls = typeof e.className === 'string' ? e.className.trim() : '';
              out.push({
                selector: e.id ? `#${e.id}` : e.tagName.toLowerCase() + (cls ? '.' + cls.split(/\s+/).slice(0, 2).join('.') : ''),
                contentPx: e.scrollHeight, viewPx: e.clientHeight, scrollTop: Math.round(e.scrollTop),
              });
            }
          }
          return out;
        };
        let hosts = []; try { hosts = scrollHosts(); } catch {}
        const scrollHint = hosts.length
          ? `the view sits inside a scroll container (${hosts.map(h => `${h.selector}: ${h.contentPx}px of content in ${h.viewPx}px`).join('; ')}) that may render only the rows in view — a row further down is NOT in the DOM yet: fast_scroll {selector:"${hosts[0].selector}", pixels:400}, repeat, and click again`
          : null;
        const missTail = scrollHint ? { ...tail, hint: [tail.hint, scrollHint].filter(Boolean).join(' | ') } : tail;
        // the text was the label of the element the previous click hit, which renamed itself
        const lc = INDEX.lastClick;
        const q = cleanLabel(String(args.text || '')).toLowerCase();
        if (lc && lc.labelNow && lc.path === pagePath() && q && lc.labels.some((l) => l === q || l.includes(q))) {
          missTail.hint = [`that was the label of the element you just clicked; it now reads ${JSON.stringify(lc.labelNow)}`, missTail.hint].filter(Boolean).join(' | ');
          missTail.labelNow = lc.labelNow;
        }
        return { error: `No element matching "${args.text}". Nothing was clicked.`, ...missTail, ...(secHint || {}), ...(hosts.length ? { scrollers: hosts } : {}), diagnostics: diagnoseNoMatch(args.text) };
      }
      await wait(150);
    }
    if (args.dryRun) return { dryRun: true, found: true, count: matches.length, best: { ...matchBrief(matches[0]), ...(typeof matches[0].x === 'number' ? { x: matches[0].x, y: matches[0].y, w: matches[0].w, h: matches[0].h } : {}) } };
    // index disambiguation: when an explicit index is given, address matches in
    // STABLE DOM order (document position), not rank order — rank order reshuffles
    // when sibling sections re-render, so index:1 would otherwise point at a
    // different element across calls. Default (no index) still takes the best-
    // RANKED match. role/tag narrowing already applied to the pool above.
    const idxGiven = typeof args.index === 'number';
    let ordered, idx, item, el;
    if (pointerHit) {
      el = pointerHit.el;
      let pr = null; try { pr = el.getBoundingClientRect(); } catch {}
      const po = offsetFor(el);
      item = { tag: el.tagName.toLowerCase(), text: cleanLabel(args.text).slice(0, 120), clickable: 'script', via: pointerHit.via,
        ...(pr ? { x: Math.round(pr.x + po.ox), y: Math.round(pr.y + po.oy), w: Math.round(pr.width), h: Math.round(pr.height) } : {}) };
      ordered = [item]; idx = 0;
    } else {
      ordered = idxGiven ? matches.slice().sort(docOrderCmp) : matches;
      idx = idxGiven ? args.index : 0;
      if (idx >= ordered.length) {
        const off = ordered.filter(m => m.offscreen).length;
        return { error: `Only ${ordered.length} matches for "${args.text}" (${ordered.length - off} visible, ${off} offscreen), index ${idx} out of range`, matches: ordered.map(matchBrief) };
      }
      // AMBIGUOUS DROPDOWNS: the best match is a select-like control (its trigger,
      // not an option in an open list) and another distinct one also matches — a
      // native <select> and the widget that shadows it, or one per row. Refuse and
      // list them rather than open/pick in whichever ranked first.
      const trig = (m) => { const e = elById(m.i); if (!e || (e.closest && e.closest(OPTIONISH))) return null; return selectControlOf(e); };
      if (!idxGiven && !wantRole && trig(matches[0])) {
        const byDoc = matches.slice().sort(docOrderCmp);
        const ctrls = [];
        byDoc.forEach((m, k) => { const c = trig(m); if (c && !ctrls.some(x => x.c === c)) ctrls.push({ c, k }); });
        if (ctrls.length > 1) {
          return {
            error: `${ctrls.length} dropdowns match ${JSON.stringify(args.text)} — nothing was clicked`,
            candidates: ctrls.slice(0, 12).map(({ c, k }) => {
              const f = describeField(c);
              const o = { index: k, tag: f.tag };
              if (f.role) o.role = f.role;
              o.label = f.label || f.ariaLabel || f.placeholder || f.name || null;
              if (f.section) o.section = f.section;
              o.value = shownValueOf(c);
              const ri = rowInfoOf(c); if (ri) Object.assign(o, ri);
              return o;
            }),
            hint: 'pass index:N (see candidates) or role:"<its role>" to click one; to choose a value use fast_select_option {field, option, index}',
          };
        }
      }
      // REPEATED-ROW CHECKBOX/RADIO: the best match is a check-type control whose
      // label also names the same kind of control in another row of the same rows
      // (Form.io's per-row "Dependant") — clicking the first would toggle row 0's
      // (h_repeat unticked Joe's seeded row). Refuse and name each row.
      const topEl = elById(matches[0].i);
      if (!idxGiven && topEl && checkedOf(topEl) !== null) {
        const key = fieldKey(topEl);
        const byDoc = matches.slice().sort(docOrderCmp);
        const same = byDoc.filter(m => { const e = elById(m.i); return e && checkedOf(e) !== null && fieldKey(e) === key; });
        if (key && same.length > 1 && inOtherRow(topEl, same.map(m => elById(m.i)))) {
          return {
            error: `${same.length} ${JSON.stringify(key)} controls in repeated rows match ${JSON.stringify(args.text)} — nothing was clicked`,
            candidates: same.slice(0, 12).map(m => { const e = elById(m.i); const o = { index: byDoc.indexOf(m), tag: m.tag, label: m.label || m.text || null, checked: checkedOf(e) }; const ri = rowInfoOf(e); if (ri) Object.assign(o, ri); return o; }),
            hint: 'pass index:N (see each candidate\'s index and row) to click the one in the row you mean',
          };
        }
      }
      item = ordered[idx];
      el = elAt(item);
      if (!el) return { error: 'Element not at expected coords' };
      // CONTAINER MATCH → click the ROW, not the pane. A match whose OWN text does
      // not carry the query only CONTAINS it: a focusable tree/list host matches
      // "Stop not lading" because one of its rendered rows reads that, and clicking
      // the host (1270×635 on a Wunderbaum tree) is not what was asked for. Narrow
      // to the smallest visible descendant whose own text carries the query. A real
      // control is NEVER narrowed: <button><span>Save</span></button> must keep the
      // button's own activation (a synthetic click on the span submits no form).
      if (!item.clickable && !isControlItem(item) && !NATIVE_CLICK.test(el.tagName)) {
        const q = cleanLabel(args.text).toLowerCase();
        const ownTextOf = (e) => { let s = ''; try { for (const c of e.childNodes) if (c.nodeType === 3) s += c.data; } catch {} return cleanLabel(s).toLowerCase(); };
        if (q && !ownTextOf(el).includes(q)) {
          let best = null, bestArea = Infinity, n = 0;
          try {
            for (const d of el.querySelectorAll('*')) {
              if (++n > 4000) break;
              if (!ownTextOf(d).includes(q)) continue;
              let r; try { r = d.getBoundingClientRect(); } catch { continue; }
              if (!visible(d, r)) continue;
              const area = r.width * r.height;
              if (area < bestArea) { best = d; bestArea = area; }
            }
          } catch {}
          if (best && best !== el) {
            let br = null; try { br = best.getBoundingClientRect(); } catch {}
            const bo = offsetFor(best);
            el = best;
            // the snapshot id belonged to the CONTAINER — drop it rather than
            // point the caller at an element this click did not touch.
            item = { ...item, i: undefined, tag: best.tagName.toLowerCase(), text: cleanLabel(best.textContent).slice(0, 120), via: 'text-leaf',
              ...(br ? { x: Math.round(br.x + bo.ox), y: Math.round(br.y + bo.oy), w: Math.round(br.width), h: Math.round(br.height) } : {}) };
          }
        }
      }
    }
    const scrolledIntoView = revealIfOffscreen(item, el);
    // The "use fast_select_option instead" redirect is for a click on a dropdown's
    // TRIGGER (clicking it only opens the list). A click on an entry of the open
    // list IS the pick — it committed — so the redirect there contradicts what
    // just happened; every committed role:"option" click carried it.
    const sel = (el.closest && el.closest(OPTIONISH)) ? null : selectHintFor(el);
    // willNavigate is a best-effort HINT (the batch re-bind keys off ACTUAL
    // navigation, not this) — but predict the common navigating clicks so callers
    // get a useful signal: (a) a real same-window link, and (b) a form-submit
    // control. A <button>/<input> of type submit|image — or a typeless <button>,
    // which defaults to submit — associated with a <form> submits it, which
    // navigates unless the page calls preventDefault (which we can't see here).
    const linkNav = el.tagName === 'A' && el.href && el.target !== '_blank' &&
      !el.href.startsWith('javascript:') && el.href !== location.href + '#';
    const formSubmitNav = (() => {
      const tag = el.tagName;
      if (tag !== 'BUTTON' && tag !== 'INPUT') return false;
      const type = (el.getAttribute('type') || '').toLowerCase();
      const isSubmit = type === 'submit' || type === 'image' ||
        (tag === 'BUTTON' && (type === '' || type === 'submit'));
      if (!isSubmit) return false;
      const form = el.form || el.closest('form');
      return !!form && form.target !== '_blank';
    })();
    const willNavigate = linkNav || formSubmitNav;
    const urlBefore = location.href;
    const dialogBefore = activeDialogRoot();
    const checkedBefore = checkedOf(el);
    // The label the index reads for this element, before and after the click: a
    // control that renames itself when clicked (a sort header "Salary: Activate to
    // sort" → "…to invert sorting") must not leave the caller holding a label that
    // no longer exists.
    const labelRead = () => { try { return el.isConnected ? makeClickEntry(el).text : null; } catch { return null; } };
    const labelBefore = labelRead();
    // A disabled control ignores the click, so a click on one must not report success
    // (live Azure batch: "OK" pressed while the dialog was still validating the name —
    // "4/4 steps ok", resource group never created). Refused at once; retrying is the caller's call.
    const isDisabled = (e) => { try { return e.disabled === true || e.getAttribute('aria-disabled') === 'true' || !!(e.closest && e.closest('fieldset[disabled]')); } catch { return false; } };
    if (isDisabled(el)) {
      return { error: `${JSON.stringify(cleanLabel(item.text || item.label || args.text || '').slice(0, 60))} is disabled (not clicked) — a required field is empty or invalid, or a check is still running`, disabled: true };
    }
    const inDialogBefore = !!(dialogBefore && dialogBefore.contains(el));
    // Native controls keep el.click() (their activation behaviour: a label-proxied
    // radio's input is checked by it); a script-only target or a custom widget gets
    // the full pointer sequence a person's click produces.
    phase('resolveMs', nowMs() - t0);
    // Will this click open something? A popup opener (aria-haspopup / aria-expanded / aria-controls
    // / aria-owns on it or an ancestor) gets up to REACT_OPENER_MS for the page to START reacting;
    // any other button or link up to REACT_CLICK_MS. Without it a panel that mounts a tick later is
    // missed: the settle sees a quiet page and returns at once (live Oracle caff4e8f: the first
    // "Change image" click came back changed "none" in 18ms, the picker opened, the model clicked
    // again and closed it).
    let reactCap = 0;
    try {
      if (el.closest('[aria-haspopup]:not([aria-haspopup="false"]),[aria-expanded],[aria-controls],[aria-owns]')) reactCap = REACT_OPENER_MS;
      else if (checkedOf(el) === null && (el.tagName === 'BUTTON' || el.tagName === 'A' || /^(button|link|tab|menuitem)$/i.test(el.getAttribute('role') || '') || item.clickable)) reactCap = REACT_CLICK_MS;
    } catch {}
    const tDispatch = nowMs();
    if (item.clickable || !NATIVE_CLICK.test(el.tagName)) pointerSeq(el); else el.click();
    phase('dispatchMs', nowMs() - tDispatch);
    if (reactCap) {
      const tR = nowMs();
      if (observerLive()) { while (!(INDEX.lastMutMs && INDEX.lastMutMs >= tDispatch) && nowMs() - tR < reactCap) await wait(25); }
      else await wait(Math.min(150, reactCap));
      phase('reactWaitMs', nowMs() - tR);
    }
    const out = await withSnap({ clicked: item, willNavigate, totalMatches: ordered.length, index: idx }, snap);
    // What the click DID leads the result: where the page is now, whether the URL
    // moved, whether a dialog opened/closed, and what holds focus.
    const head = { clicked: item, url: location.href, urlChanged: location.href !== urlBefore };
    const labelNow = labelRead();
    if (labelNow && labelBefore != null && labelNow !== labelBefore) head.labelNow = labelNow;
    INDEX.lastClick = {
      labels: [...new Set([item.text, item.label, item.ariaLabel, labelBefore, args.text].filter(Boolean).map((t) => cleanLabel(String(t)).toLowerCase()))],
      labelNow: head.labelNow || null, path: pagePath(),
    };
    // A check-type control reports its state AFTER the click: a radio is verified
    // when it is now selected, a checkbox when the click toggled it.
    const checkedNow = checkedOf(el);
    if (checkedNow !== null) {
      const isRadio = (el.type || '').toLowerCase() === 'radio' || /radio/.test((el.getAttribute('role') || '').toLowerCase());
      head.checked = checkedNow;
      head.verified = isRadio ? checkedNow === true : checkedNow !== checkedBefore;
      if (!head.verified) head.reason = isRadio ? 'the radio is still not selected after the click — the page ignored it; do not report it as chosen' : `the checkbox is still ${checkedNow ? 'checked' : 'unchecked'} — the click did not toggle it; do not report it as changed`;
    }
    if (sel) { head.hint = sel.hint; head.selectField = sel.selectField; }
    if (scrolledIntoView) head.scrolledIntoView = true;
    let dialogNow = activeDialogRoot();
    // A confirm button of an open dialog (OK / Save / Create / Apply / Done / …) that leaves
    // the dialog open did not take: the page refused it (a validation message, a busy
    // check). Closing can be async, so the dialog gets AUTO_WAIT_MS to go away.
    // A confirm is a BUTTON whose label is the verb, at most one more word ("OK", "Save changes",
    // "Select image") — not a checkable option whose label starts with the verb (live Oracle
    // 44743f3c: the card "Select Canonical Ubuntu 26.04" was checked, came back verified:false /
    // dialogStillOpen and cost a 1.5s wait, twice).
    const CONFIRM = /^(ok|okay|save|apply|create|done|confirm|submit|add|yes|continue|update|select)(\s+\S+)?$/i;
    const confirmText = cleanLabel(item.text || item.label || '');
    if (inDialogBefore && checkedOf(el) === null && CONFIRM.test(confirmText)) {
      const tC = nowMs();
      while (dialogNow && dialogNow === dialogBefore && dialogNow.isConnected && nowMs() - tC < AUTO_WAIT_MS) { await wait(100); dialogNow = activeDialogRoot(); }
      phase('confirmWaitMs', nowMs() - tC);
      if (dialogNow && dialogNow === dialogBefore && dialogNow.isConnected) {
        head.verified = false;
        head.dialogStillOpen = dialogLabel(dialogNow) || true;
        head.reason = `the dialog${typeof head.dialogStillOpen === 'string' ? ` "${head.dialogStillOpen}"` : ''} is still open after clicking "${confirmText}" — the page did not accept it (a validation message, or a check still running); read the dialog before going on, do not report its change as made`;
      }
    }
    if (dialogNow && dialogNow !== dialogBefore) head.dialogOpened = dialogLabel(dialogNow) || true;
    else if (dialogBefore && !dialogNow) head.dialogClosed = true;
    const focused = describeEl(document.activeElement);
    if (focused && focused.tag !== 'body') head.focused = focused;
    return frontload(out, head);
  }

  if (action === 'fast_scroll') {
    const isScrollableBox = (el) => {
      if (!el?.getBoundingClientRect) return false;
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      return /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);
    };
    const docFallback = () => ({ el: document.scrollingElement || document.documentElement, kind: 'document' });
    const findScroller = () => {
      if (args.selector) {
        const el = document.querySelector(args.selector);
        if (!el) return { error: `selector "${args.selector}" not found` };
        return { el, kind: 'selector' };
      }
      // Container auto-detection forces synchronous layout (getComputedStyle +
      // getBoundingClientRect) per candidate. On ad/tracker-heavy pages with a
      // huge DOM (e.g. Micro Center's PC builder) this once ran 30s+ and hung
      // the action. We can't interrupt synchronous JS with a Promise timeout,
      // so instead we hard-bound the work with an in-loop time budget and bail
      // to a plain document/window scroll the moment we exceed it. fast_scroll
      // must ALWAYS return within a couple seconds; a slightly-less-precise
      // container is better than a hang (and callers can still pass `selector`).
      const deadline = Date.now() + 400;
      try {
        // 1) Cheapest + most reliable: walk UP from the viewport-center element.
        // Handles virtualized scrollers and the common "one big scroll pane" case
        // with a bounded ancestor chain (no full-DOM scan at all).
        let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        let depth = 0;
        while (el && el !== document.body && el !== document.documentElement && depth++ < 60) {
          if (isScrollableBox(el)) return { el, kind: 'ancestor' };
          el = el.parentElement;
        }
        // 2) Bounded scan of LIKELY scroller candidates only. The old selector
        // included `body > * *` (≈every node) and once ran 30s+ on heavy SPAs,
        // blowing the budget before the first time-check. Restrict to main regions
        // + elements that ADVERTISE scrolling (class/style hints), hard-cap the
        // count, and check the clock every 64. Always falls back to window scroll.
        let best = null, bestArea = 0, scanned = 0;
        let candidates;
        try {
          candidates = document.querySelectorAll(
            'main, [role="main"], [class*="scroll" i], [class*="overflow" i], [style*="overflow" i]'
          );
        } catch { candidates = []; }
        for (const e of candidates) {
          if ((++scanned & 63) === 0 && Date.now() > deadline) break;
          if (scanned > 4000) break;
          if (!isScrollableBox(e)) continue;
          const r = e.getBoundingClientRect();
          if (r.width < 100 || r.height < 100) continue;
          const area = r.width * r.height;
          if (area > bestArea) { best = e; bestArea = area; }
        }
        if (best) return { el: best, kind: 'largest' };
      } catch {}
      return docFallback();
    };
    const found = findScroller();
    if (found.error) return found;
    let target = found.el, kind = found.kind;
    const docEl = document.scrollingElement || document.documentElement;
    const isDocEl = (el) => el === document.scrollingElement || el === document.documentElement || el === document.body;
    // A named element that cannot scroll itself (a tree/list inside the pane that
    // does) moves nothing: scroll its nearest scrollable ancestor instead.
    if (kind === 'selector' && !isDocEl(target) && !isScrollableBox(target)) {
      let a = target.parentElement;
      while (a && !isDocEl(a) && !isScrollableBox(a)) a = a.parentElement;
      target = a && !isDocEl(a) ? a : docEl;
      kind = 'selector-ancestor';
    }
    const isDoc = isDocEl(target);
    const readTop = () => (isDoc ? window.scrollY : target.scrollTop);
    const box = isDoc ? docEl : target;
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    const before = readTop();
    const plan = scrollDest(args, { top: before, max, viewH: box.clientHeight });
    if (plan.error) return plan;
    const dest = Math.max(0, Math.min(max, plan.dest));
    if (isDoc) window.scrollTo({ top: dest, behavior: 'instant' });
    else target.scrollTop = dest;
    const after = readTop();
    const desc = isDoc ? 'document' : target.tagName.toLowerCase()
      + (target.id ? `#${target.id}` : '')
      + (target.className && typeof target.className === 'string' && target.className.trim() ? '.' + target.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    const head = { scrolled: true, ...scrollOutcome(before, after, max, plan.dest), scrollTop: Math.round(after), max: Math.round(max), kind, target: desc };
    if (plan.screenful) head.screenful = plan.screenful;
    return withSnap(head);
  }

  if (action === 'fast_fill') {
    // ONE tool for one field ({match, value, index, section, append}) or a whole
    // form ({fields:{label: value | {value, index, section, name, exact, append}}}).
    // Both paths share the resolver below; the single form keeps its
    // {verified, value, …} head, the multi form returns per-field verified state.
    const multi = args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields);
    if (!multi && !args.match) return { error: 'fast_fill: pass {match, value} for one field or {fields:{label: value}} for several' };
    const formSection = String(args.section ?? args.near ?? '').trim();
    const specs = multi
      ? Object.entries(args.fields).map(([match, raw]) => {
          const spec = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : { value: raw };
          return { match: String(match), value: spec.value ?? spec.text, index: spec.index ?? args.index, section: String(spec.section ?? spec.near ?? formSection).trim(),
                   append: spec.append ?? !!args.append, exactName: spec.name != null ? String(spec.name).toLowerCase() : (spec.exact ? String(match).toLowerCase() : null) };
        })
      : [{ match: String(args.match), value: args.value ?? args.text, index: args.index, section: formSection, append: !!args.append, exactName: null }];
    for (const sp of specs) sp.m = sp.match.toLowerCase();

    // Resolve every field against one match pool (offscreen controls included);
    // the lookup is retried until AUTO_WAIT_MS so a field still mounting after a
    // view change is not a false miss. Returns { found:Map, misses:Map, snap }.
    const resolveAll = () => {
      const found = new Map(), misses = new Map(), usedI = new Set();
      for (const sp of specs) {
        if (sp.value == null) { misses.set(sp, { error: "no value provided — use '' to clear the field", skipped: true }); continue; }
        let pool = snap.items.filter(it => isFillable(it) && !usedI.has(it.i));
        // A field in an open dialog wins over the page behind it: "Name" in a just-opened
        // Create dialog, not "Virtual machine name" under it.
        if (pool.some(it => it.inDialog)) {
          const inD = pool.filter(it => it.inDialog);
          if (inD.some(it => fieldMatchesExact(it, sp.m) || fieldMatchesText(it, sp.m))) pool = inD;
        }
        if (sp.section) {
          const scoped = applySectionScope(sp.section);
          if (scoped.error) { misses.set(sp, scoped); continue; }
          pool = scoped.pool.filter(it => !usedI.has(it.i));   // REPLACES the pool — never a page-wide fallback
        }
        let ranked, exactHit = true;
        if (sp.exactName != null) ranked = pool.filter(it => it.name && it.name.toLowerCase() === sp.exactName);
        else {
          // Exact label/name beats a substring ("URIs 1" must not grab "URIs 10").
          const exact = pool.filter(it => fieldMatchesExact(it, sp.m));
          exactHit = exact.length > 0;
          ranked = exactHit ? exact : pool.filter(it => fieldMatchesText(it, sp.m));
        }
        if (!ranked.length) {
          misses.set(sp, sp.section
            ? { error: `No fillable element matching "${sp.match}" inside section "${sp.section}" — the section resolved but none of its ${pool.length} fillable field(s) carry that label. Nothing was filled.`, fieldsInSection: pool.slice(0, 12).map(fieldBrief) }
            : { error: `No visible fillable element matching "${sp.match}". Nothing was filled.` });
          continue;
        }
        const ordered = ranked.slice().sort(docOrderCmp);
        const idxGiven = typeof sp.index === 'number' && sp.index >= 0;
        const visEls = ordered.map(it => elById(it.i));
        // Hidden copies of the same label (another row's field, shown only after a
        // step in THAT row). Without an index they can only make the call refuse.
        const visRows = visEls.map(e => (rowContextOf(e) || {}).row).filter(Boolean);
        const hidden = sp.exactName != null ? [] : hiddenCopiesOf(sp.m, exactHit, visEls).filter(h => !visRows.some(r => r.contains(h)));
        const hiddenRowsOf = (el) => hidden.filter(h => inOtherRow(el, [h]));
        // AMBIGUOUS: several fields carry this name and no index picks one (a
        // section that still holds several does not either) — refuse and list them.
        // Writing the first would be a silent wrong-field write (GCP: two "URIs 1"
        // rows under two headings; Form.io: every grid row's "Birthdate"). So is a
        // single visible match whose label ALSO exists, hidden, in another row of
        // the same repeated row group (h_repeat wrote Joe's seeded row).
        const hiddenInRows = !idxGiven && !sp.section && ordered.length === 1 && visEls[0] ? hiddenRowsOf(visEls[0]) : [];
        if (!idxGiven && (ordered.length > 1 || hiddenInRows.length)) {
          const paths = ordered.map(it => sectionPathOf(elById(it.i)));
          const secs = distinguishingSections(paths);
          const candidates = ordered.map((it, i) => {
            const el = elById(it.i); const v = el ? liveValueOf(el) : it.value;
            const c = { label: it.label || it.ariaLabel || it.placeholder || it.name || it.text || null, section: secs[i], value: v == null ? '' : String(v).slice(0, 120), empty: !String(v ?? '').trim(), index: i, visible: true };
            if (it.name && it.name !== c.label) c.name = it.name;
            if (it.offscreen) c.offscreen = true;
            const ri = rowInfoOf(el); if (ri) Object.assign(c, ri);
            return c;
          });
          for (const h of (ordered.length > 1 ? hidden : hiddenInRows).slice(0, 8)) {
            const c = { label: labelFor(h) || h.getAttribute('aria-label') || h.getAttribute('placeholder') || h.getAttribute('name') || null, section: headingAbove(h), value: String(liveValueOf(h) ?? '').slice(0, 120), visible: false };
            const ri = rowInfoOf(h); if (ri) Object.assign(c, ri);
            candidates.push(c);
          }
          const hiddenRowNums = candidates.filter(c => !c.visible && c.row != null).map(c => c.row);
          const distinct = [...new Set(secs.filter(Boolean))];
          const secList = distinct.length > 1 ? distinct.map(s => JSON.stringify(s)).join(' | ') : '';
          misses.set(sp, {
            error: `${ordered.length} visible field(s) match ${JSON.stringify(sp.match)}${sp.section ? ` in section "${sp.section}"` : ''}${hiddenRowNums.length ? ` and it also exists (hidden) in row(s) ${hiddenRowNums.join(', ')}` : ''} — nothing was filled`,
            candidates,
            hint: `pass ${sp.section || !secList ? '' : `section:${secList} or `}index:N (0..${ordered.length - 1}, the VISIBLE candidates in document order — each names its row/section) to pick one${hiddenRowNums.length ? '; a hidden row\'s field appears only after another step in that row (a toggle or choice there)' : ''}`,
          });
          continue;
        }
        const idx = idxGiven ? sp.index : 0;
        if (idx >= ordered.length) {
          const off = ordered.filter(it => it.offscreen).length;
          const withRow = (el, o) => { const ri = rowInfoOf(el); return ri ? { ...o, ...ri } : o; };
          const hid = hiddenCopiesOf(sp.m, exactHit, visEls);
          misses.set(sp, { error: `Only ${ordered.length} fillable match(es) for "${sp.match}" (${ordered.length - off} visible, ${off} offscreen), index ${idx} out of range`, matches: ordered.map(it => withRow(elById(it.i), matchBrief(it))),
            ...(hid.length ? { hiddenMatches: hid.slice(0, 8).map(h => withRow(h, { tag: h.tagName.toLowerCase(), label: labelFor(h) || null, visible: false })), hint: 'index counts the VISIBLE matches in document order (see each one\'s row); a hidden copy appears only after another step in its row' } : {}) });
          continue;
        }
        found.set(sp, ordered[idx]);
        usedI.add(ordered[idx].i);
      }
      return { found, misses };
    };
    const t0 = nowMs();
    let snap, res;
    // A label that names a section heading is a final miss (the section exists;
    // its field needs a click, or a field label + section:) — no auto-wait for it.
    const sectionMiss = new Map();   // spec → heading title
    for (;;) {
      snap = await serializeSnapshot(false, { matchAll: true });
      res = resolveAll();
      // dryRun (the background's frame reach): which fields THIS document holds —
      // found / ambiguous / missing — on one look, nothing written.
      if (args.dryRun) {
        return { dryRun: true, fields: Object.fromEntries(specs.map((sp) => [sp.match, res.found.has(sp) ? 'found' : ((res.misses.get(sp) || {}).candidates ? 'ambiguous' : 'missing')])) };
      }
      let realMiss = false;
      for (const [sp, m] of res.misses) {
        if (m.skipped || m.candidates) continue;   // an ambiguous match is final, not "still mounting"
        if (!sp.section && !sectionMiss.has(sp)) { const t = sectionTitleFor(sp.match); if (t) sectionMiss.set(sp, t); }
        if (!sectionMiss.has(sp)) realMiss = true;
      }
      if (!realMiss || nowMs() - t0 >= AUTO_WAIT_MS) break;
      await wait(150);
    }
    const waitedMs = Math.round(nowMs() - t0);
    // Why a miss missed: candidates (visible fields), hidden label matches, and a
    // redirect when the name belongs to a dropdown (react-select input, combobox).
    const enrichMiss = (sp, miss) => {
      if (miss.skipped || miss.sections || miss.fieldsInSection || miss.matches || miss.candidates) return miss;
      const rep = fillMissReport(sp.m, snap.items.filter(it => isFillable(it) && !it.offscreen));
      const offMatches = snap.items.filter(it => it.offscreen && isFillable(it) && fieldMatchesText(it, sp.m));
      const out = { ...miss, ...rep };
      if (offMatches.length) { out.offscreenMatches = offMatches.slice(0, 6).map(matchBrief); out.hint = `${offMatches.length} matching field(s) are offscreen (see offscreenMatches, with their section) — pass section:"<name>" or index:N to fill one of them` + (out.hint ? '; ' + out.hint : ''); }
      let sel = null;
      try {
        // The name may be an element id the model copied from `focused` (react-select-8-input).
        const hid = rep.hiddenMatches && rep.hiddenMatches.find(h => /^react-select-/.test(h.id || ''));
        const byId = document.getElementById(sp.match) || (hid ? document.getElementById(hid.id) : null);
        sel = selectHintFor(byId);
      } catch {}
      // The name belongs to a visible select / combobox control (not fillable):
      // listed as a kind:"select" candidate and redirected to fast_select_option.
      if (!sel) {
        const sc = selectControlByLabel(sp.m);
        if (sc) {
          const f = describeField(sc.el);
          out.candidates = [{ kind: 'select', ...f, label: sc.name }, ...(out.candidates || [])].slice(0, 12);
          sel = { selectField: f, hint: `${JSON.stringify(sc.name)} is a select control; use fast_select_option {field:${JSON.stringify(sc.name)}, option:"<choice>"}` };
        }
      }
      if (sel) { out.hint = sel.hint; out.selectField = sel.selectField; return out; }
      // The name is a SECTION heading. With fields in it: fill one of them with
      // section:. With none: the button that creates one (repeatable fields —
      // "Add URI", "Add email"), ranked so a help/close icon is never the one named.
      const title = sectionMiss.get(sp);
      if (title && !rep.hiddenMatches) {
        try {
          const q = JSON.stringify(sp.match), qs = JSON.stringify(title);
          const sec = resolveSection(title.toLowerCase());
          out.section = title;
          if (sec.items.length) {
            out.fieldsInSection = sec.items.slice(0, 12).map(fieldBrief);
            out.hint = `${q} is a section, not a field; fill one of its fields (fieldsInSection) with {match:"<field label>", section:${qs}}`;
          } else {
            const seen = new Set();
            const btns = resolveSection(title.toLowerCase(), 'button,[role="button"],input[type="button"],input[type="submit"]').items.map((it) => {
              const el = elById(it.i);
              const text = el ? cleanLabel(el.innerText || el.value || '') : '';
              let tooltip = false;
              try { tooltip = !!el && (el.hasAttribute('aria-describedby') || Array.from(el.attributes).some(a => /tooltip/i.test(a.name) || /^tooltip$/i.test(a.value))); } catch {}
              return { name: cleanLabel(it.text || it.ariaLabel || text), text, iconOnly: !text || /^[a-z]+(?:_[a-z]+)+$/.test(text), tooltip };
            }).filter(b => b.name && !seen.has(b.name) && seen.add(b.name));
            const ranked = rankCreateButtons(btns);
            out.buttons = ranked.slice(0, 5).map(b => b.name);
            out.hint = ranked.length && !ranked[0].demoted
              ? `${q} is a section with no input yet; click ${JSON.stringify(ranked[0].name)} in it to create the field, then fill it (pass section:${qs})`
              : `${q} is a section with no input${ranked.length ? ' and no button in it that adds one' : ''}; its field appears only after another step on the page (a choice or toggle above it) — do that, then fill with section:${qs}`;
          }
        } catch {}
      }
      return out;
    };
    const act = pageActivity();
    const SETTLE_MISS_HINT = 'the page was still changing when this gave up — the field may not be rendered yet: fast_wait for text that identifies the target view, then fill again';

    // Fill everything that resolved (scrolling offscreen targets into view).
    const written = new Map();   // spec → { el, r }
    for (const [sp, it] of res.found) {
      const el = elAt(it);
      revealIfOffscreen(it, el);
      const ri = rowInfoOf(el);   // read BEFORE the write: a re-render can detach the written node
      const r = fillItem(it, sp.value, sp.append);
      if (r.error) { res.misses.set(sp, r); continue; }
      if (it.ariaLabel && !r.filled.label) r.filled.ariaLabel = it.ariaLabel;
      if (ri) r.filled.row = ri;   // a write into a repeated row names the row it landed in
      const sel = (el && el.matches && el.matches(RS_INPUT_SEL)) ? selectHintFor(el) : null;
      if (sel) { r.hint = sel.hint; r.selectField = sel.selectField; }
      // Autocomplete: capture ITS list before the next field's write moves focus
      // (which closes it) — a later field must not hide an earlier uncommitted one.
      let ac = null;
      if (el && isAutocomplete(el)) { typedKeys(el, sp.value); acRecord(el, sp.value); ac = await awaitSuggestions(el); }
      written.set(sp, { el, r, ac });
    }
    // Verified state: each field's LIVE value after the page settled, compared
    // with what was written (native select: the selected option's text/value).
    const verifyOne = (sp, el, r) => {
      if (r.kind === 'checkbox' || r.kind === 'radio') {
        const on = !!el.checked;
        const head = { verified: on === r.valueSet, value: on ? 'checked' : 'unchecked', checked: on };
        if (!head.verified) head.reason = `the ${r.kind} is ${head.value} after the click — the page reverted or ignored it; do not report it as ${r.valueSet ? 'ticked' : 'cleared'}`;
        return head;
      }
      // A write whose field cannot be re-read is NOT a write that held: a node the
      // page replaced/removed during the write reads nothing, and "reads nothing"
      // is not the same failure as "reads something else". Say which.
      const live = (el && el.isConnected === false) ? null : liveValueOf(el);
      if (live == null) {
        return { verified: false, value: '', reason: 'unreadable: the field is no longer in the page after the write (replaced or removed by a re-render), so its value cannot be read back — nothing confirms the value landed; read the page (fast_snapshot/fast_text) before reporting it as set' };
      }
      const expected = r.kind === 'native-select' ? String(r.valueSet) : String(sp.value);
      const holds = r.kind === 'native-select' ? live.toLowerCase() === expected.toLowerCase()
        : sp.append ? live.endsWith(expected) : live === expected;
      const head = { verified: holds, value: maskIfPassword(el, String(live).slice(0, 300)) };
      if (!holds) head.reason = `the field now reads ${JSON.stringify(head.value)} instead of the value written — the page reformatted, rejected or reverted it; do not report the written value as set`;
      return head;
    };

    if (!multi) {
      const sp = specs[0];
      if (!written.has(sp)) {
        const miss = enrichMiss(sp, res.misses.get(sp) || { error: 'not filled' });
        return frontload(miss, { error: miss.error, waitedMs, ...missHead([miss], act.settling, SETTLE_MISS_HINT) });
      }
      const { el, r, ac } = written.get(sp);
      const out = await withSnap(r, snap);
      const head = commitGate({ ...verifyOne(sp, el, r), ...(ac || {}) }, ac);
      return calmIfVerified(frontload(out, head));
    }

    // Multi-field result: { verified, filled, missed, fields:{label:{…}}, snapshot }.
    // The snapshot's own settle (withSnap) is the verify delay; the live values
    // are read after it, into the same `fields` object the snapshot result holds.
    const fields = {};
    const out = { fields };
    const HANDLER_CAP_MS = 8000;
    const snapped = await Promise.race([
      withSnap(out, snap),
      new Promise((resolve) => setTimeout(() => resolve({ ...out, snapshotPartial: true, snapshotNote: 'snapshot skipped — bounded to keep fast_fill responsive' }), HANDLER_CAP_MS)),
    ]);
    for (const sp of specs) {
      if (written.has(sp)) {
        const { el, r, ac } = written.get(sp);
        fields[sp.match] = commitGate({ ...verifyOne(sp, el, r), ...(ac || {}), ...r }, ac);
      } else {
        fields[sp.match] = enrichMiss(sp, res.misses.get(sp) || { error: 'not filled' });
      }
    }
    const head = rollUpFill(fields, specs.length);
    if (head.missed) {
      const mh = missHead(Object.values(fields).filter(f => f.error), act.settling, SETTLE_MISS_HINT);
      if (mh.settling) head.settling = true;
      const hints = [mh.hint, head.hint].filter(Boolean);
      if (hints.length) head.hint = hints.join(' | ');
    }
    // the auto-snapshot's own settle flag must not re-add "still changing" over explained misses
    return calmIfVerified(frontload(snapped, head), head.verified || (!head.settling && !head.reverted && !head.uncommitted));
  }

  return { error: `Unknown action: ${action}` };
 } catch (e) {
  return { error: 'page action threw: ' + (e?.stack || e?.message || String(e)).slice(0, 600) };
 }
}

// ── Short, actionable misses ─────────────────────────────────────────────────
// Owner direction: let the model fail and recover fast. A miss from fast_click /
// fast_fill / fast_select_option leaves as ONE line saying what went wrong and what
// exists instead ("field \"Location\" not found; dropdowns here: \"Subscription\",
// \"Resource group\", \"Region\""), not a page of candidates, diagnostics and timings.
// Ambiguity refusals keep their candidates (index / row / section ARE the fix). A fill
// that landed in a field whose label is not the one asked for says `matched`.
const MISS_KEEP = new Set(['error', 'code', 'idStale', 'labelNow', 'disabled', 'dialogStillOpen', 'frameNotice', 'opaqueFrames', 'inFrame', 'framesAppeared']);
const quoteList = (names, n) => {
  const uniq = [...new Set(names.map((x) => cleanLabel(String(x || '')).slice(0, 50)).filter(Boolean))];
  return uniq.slice(0, n).map((x) => JSON.stringify(x)).join(', ') + (uniq.length > n ? ` (+${uniq.length - n} more)` : '');
};
// Names most like the query first: shared words, containment, then a shared prefix. Pure.
const closestNames = (query, names, n = 3) => {
  const q = cleanLabel(String(query || '')).toLowerCase();
  const qt = new Set(q.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const scored = [...new Set(names.map((x) => cleanLabel(String(x || ''))).filter(Boolean))].map((name) => {
    const l = name.toLowerCase();
    let score = 0;
    for (const t of l.split(/[^\p{L}\p{N}]+/u)) if (t && qt.has(t)) score += 2;
    if (q && (l.includes(q) || q.includes(l))) score += 3;
    let k = 0; while (k < q.length && k < l.length && q[k] === l[k]) k++;
    return { name, score: score + Math.min(k, 6) / 10 };
  }).filter((x) => x.score >= 1).sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map((x) => x.name);
};
const clickNames = () => {
  const out = [];
  let k = 0;
  for (const [, e] of INDEX.byEl) { if (++k > 4000) break; if (e.kind === 'click' && e.text && e.text.length <= 60) out.push(e.text); }
  return out;
};
const nameOfCand = (c) => (c && (c.label || c.ariaLabel || c.placeholder || c.name || c.text)) || '';
const shortMiss = (action, r, query) => {
  if (!r || typeof r !== 'object' || !r.error || r.dryRun) return r;
  if (r.code || r.idStale || r.disabled) return r;   // already one line that names the fix
  const ambiguous = Array.isArray(r.candidates) && r.candidates.some((c) => c && (typeof c.index === 'number' || c.row != null));
  if (ambiguous) { const { waitedMs, timing, settling, ...rest } = r; return rest; }
  let line = String(r.error)
    .replace(/\s*(?:—\s*)?nothing was (?:clicked|filled|changed|selected|done)\.?/gi, '')
    .replace(/\.?\s*Nothing was (?:clicked|filled|changed|selected)\.?/g, '')
    .replace(/\s*Retry with one of the names in `candidates`\.?/g, '')
    .replace(/ — no visible dropdown\/combobox\/select carries that label, aria-label, placeholder, name, id, or titled section\.?/, '')
    .replace(/\s+/g, ' ').trim().replace(/[.;,]$/, '');
  line += ' (nothing done)';
  const fixes = [];
  if (r.labelNow && r.hint) fixes.push(String(r.hint).split(' | ')[0]);   // "that was the label of the element you just clicked; it now reads …"
  else if (r.selectField || /fast_select_option/.test(String(r.hint || ''))) {
    fixes.push(`it is a dropdown: fast_select_option {field:${JSON.stringify(nameOfCand(r.selectField) || query)}}`);
  } else if (Array.isArray(r.hiddenMatches) && r.hiddenMatches.length) {
    fixes.push(`${r.hiddenMatches.length} matching field(s) are hidden — open what shows them first`);
  } else if (Array.isArray(r.offscreenMatches) && r.offscreenMatches.length) {
    const sec = r.offscreenMatches.map((m) => m.section).find(Boolean);
    fixes.push(`it is offscreen${sec ? ` under "${sec}"` : ''} — pass section or index`);
  }
  if (Array.isArray(r.available) && r.available.length) {
    fixes.push(`options: ${quoteList(r.available, 6)}`);
    if (/is not an option/.test(String(r.error))) fixes.push('a value that does not exist yet must be created first (the field\'s own "Create new" control)');
  } else if (!fixes.length) {
    const pool = action === 'fast_click' ? clickNames() : (Array.isArray(r.candidates) ? r.candidates.map(nameOfCand) : []);
    const near = closestNames(query, pool, 3);
    const shown = near.length ? near : (action === 'fast_click' ? [] : pool);
    if (shown.length) fixes.push(`${action === 'fast_click' ? 'closest' : action === 'fast_select_option' ? 'dropdowns here' : 'fields here'}: ${quoteList(shown, 4)}`);
  }
  if (Array.isArray(r.scrollers) && r.scrollers.length) fixes.push(`it may be below the fold of ${r.scrollers[0].selector} — fast_scroll it`);
  if (r.settling) fixes.push('the page was still changing — fast_wait for its text, then retry');
  const out = { error: [line, ...fixes].join('; ') };
  for (const k of Object.keys(r)) if (k !== 'error' && MISS_KEEP.has(k)) out[k] = r[k];
  return out;
};
const matchedNote = (asked, filled) => {
  const got = filled && (filled.label || filled.ariaLabel || filled.placeholder || filled.name);
  return got && cleanLabel(String(got)).toLowerCase() !== cleanLabel(String(asked || '')).toLowerCase() ? cleanLabel(String(got)).slice(0, 80) : null;
};
const shortResult = (action, r, args = {}) => {
  if (!r || typeof r !== 'object' || r.dryRun) return r;
  if (action === 'fast_click') return shortMiss(action, r, args.text ?? args.id);
  if (action === 'fast_fill') {
    if (r.fields && typeof r.fields === 'object' && !Array.isArray(r.fields)) {
      const fields = {};
      const lines = [];
      for (const [k, v] of Object.entries(r.fields)) {
        if (v && v.error) { fields[k] = shortMiss(action, v, k); lines.push(`${JSON.stringify(k)}: ${fields[k].error}`); continue; }
        const m = v && matchedNote(k, v.filled);
        fields[k] = m ? { ...v, matched: m } : v;
        if (v && v.verified === false && v.reason) lines.push(`${JSON.stringify(k)}: ${v.reason}`);
      }
      const { hint, ...rest } = r;
      const ok = Object.values(fields).filter((v) => v && v.verified === true).length;
      const out = { ...rest, fields };
      if (lines.length) { out.summary = `${ok}/${r.total ?? Object.keys(fields).length} verified — ${lines.join(' | ')}`; if (r.uncommitted && hint) out.hint = hint; }
      return out;
    }
    if (r.error) return shortMiss(action, r, args.match);
    const m = matchedNote(args.match, r.filled);
    return m ? frontload(r, { matched: m }) : r;
  }
  if (action === 'fast_select_option') {
    if (r.results && typeof r.results === 'object') {
      const results = {};
      const lines = [];
      for (const [k, v] of Object.entries(r.results)) { results[k] = v && v.error ? shortMiss(action, v, k) : v; if (v && v.error) lines.push(`${JSON.stringify(k)}: ${results[k].error}`); else if (v && v.verified === false && v.reason) lines.push(`${JSON.stringify(k)}: ${v.reason}`); }
      const out = { ...r, results };
      if (lines.length) out.summary = `${r.picked ?? 0}/${r.total ?? Object.keys(results).length} selected — ${lines.join(' | ')}`;
      return out;
    }
    return shortMiss(action, r, args.field);
  }
  return r;
};

// ── What a write changed ─────────────────────────────────────────────────────
// Every write (click, fill, select, key) reports what actually changed on the form, in
// one short list: the labelled form controls of THIS document (label → value, checked
// state) and the dialogs open, read before and after the action, diffed. Live misses on
// two sites were changes that silently did not happen — a picked image discarded when
// its panel closed, a resource group typed but never applied — while every result said
// ok. Only labelled controls and dialog open/close count (no prices, counters or text).
// Read from the index the page already keeps; no waits added.
const WRITE_ACTIONS = new Set(['fast_click', 'fast_fill', 'fast_select_option', 'fast_key_press']);
const FORM_STATE_MAX = 1500, CHANGED_SHOWN = 4;
const formState = () => {
  const fields = new Map();   // element → { label, value }
  let k = 0, partial = false;
  for (const [el, e] of INDEX.byEl) {
    if (++k > 20000 || fields.size >= FORM_STATE_MAX) { partial = true; break; }
    if (!e || e.kind !== 'click' || !el.isConnected) continue;
    const chk = checkedOf(el);
    if (!e.live && chk === null) continue;
    const label = cleanLabel(String(e.label || e.ariaLabel || e.placeholder || e.name || '')).slice(0, 60);
    if (!label) continue;
    let value;
    if (chk !== null) value = chk ? 'checked' : 'unchecked';
    else { const c = { live: e.live }; try { refreshLiveEntry(el, c); } catch {} value = c.value == null ? '' : String(c.value); }
    if (el.type === 'password') value = value ? '•••' : '';
    fields.set(el, { label, value: cleanLabel(value).slice(0, 80) });
  }
  // dialogs by ELEMENT, not name: a same-named panel opening inside another (Oracle's image
  // picker is a "Side Panel" inside the "Side Panel" create form) is its own open/close
  const dialogs = new Map();   // element → label
  let view = { current: '', headings: [] };
  try {
    const els = document.querySelectorAll(DIALOG_SEL);
    for (let i = 0; i < els.length && i < 50; i++) {
      let r; try { r = els[i].getBoundingClientRect(); } catch { continue; }
      if (visible(els[i], r)) dialogs.set(els[i], dialogLabel(els[i]) || 'dialog');
    }
    const act = activeDialogRoot();
    if (act && !dialogs.has(act)) dialogs.set(act, dialogLabel(act) || 'dialog');
    // the view: the current step / page / tab and the visible headings (a wizard's Next changes these
    // without touching a field — live Oracle caff4e8f: three Next clicks said "none" while the wizard
    // moved Security → Networking → Storage)
    const shown = (el) => { let r; try { r = el.getBoundingClientRect(); } catch { return false; } return visible(el, r); };
    const txt = (el) => cleanLabel(String(el.getAttribute('aria-label') || el.textContent || '')).slice(0, 60);
    const cur = [];
    for (const el of document.querySelectorAll('[aria-current="step"],[aria-current="page"],[aria-current="true"],[role="tab"][aria-selected="true"]')) { if (cur.length >= 4) break; if (shown(el)) cur.push(txt(el)); }
    const heads = [];
    for (const el of document.querySelectorAll('h1,h2,h3,h4,[role="heading"]')) { if (heads.length >= 12) break; if (shown(el)) { const t = txt(el); if (t) heads.push(t); } }
    view = { current: cur.filter(Boolean).join(' / '), headings: heads };
    // name + nesting, read NOW (a closed panel is detached by the time the states are compared)
    for (const [el, label] of dialogs) {
      let nested = false;
      for (const other of dialogs.keys()) if (other !== el && other.contains(el)) { nested = true; break; }
      dialogs.set(el, `dialog "${label}"${nested ? ' (nested)' : ''}`);
    }
  } catch {}
  return { fields, dialogs, view, partial };
};
// "Label: \"old\" → \"new\"", "dialog \"X\" opened/closed". A field the page re-rendered (a new
// element) is matched by its label when that label is unique on both sides. Pure given states.
const diffFormState = (a, b) => {
  const out = [];
  const byLabel = (st) => { const m = new Map(); for (const v of st.fields.values()) m.set(v.label, m.has(v.label) ? null : v); return m; };
  const bl = byLabel(b), al = byLabel(a);
  for (const [el, x] of a.fields) {
    const y = b.fields.get(el) || (al.get(x.label) ? bl.get(x.label) : null);
    if (y && y.value !== x.value) out.push(`${x.label}: ${JSON.stringify(x.value)} → ${JSON.stringify(y.value)}`);
  }
  // Dialogs are told apart by name AND nesting (a "Side Panel" opened inside the "Side Panel"
  // form is its own entry); a panel the page re-mounted as a new element with the same name and
  // place is not reported as closed + opened.
  const names = (st) => {
    const counts = new Map();
    for (const key of st.dialogs.values()) counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  };
  const na = names(a), nb = names(b);
  const dialogLines = [];
  // a same-named panel opened beside another (a portal, not nested in it) says how many are open
  const open = (key, n) => (n > 1 ? `${key} opened (${n} open)` : `${key} opened`);
  const shut = (key, n) => (n > 0 ? `${key} closed (${n} still open)` : `${key} closed`);
  for (const [key, n] of nb) if (n > (na.get(key) || 0)) dialogLines.push(open(key, n));
  for (const [key, n] of na) if (n > (nb.get(key) || 0)) dialogLines.push(shut(key, nb.get(key) || 0));
  // the view line, unless a dialog line already says what changed
  if (a.view && b.view && !dialogLines.length) {
    if (a.view.current !== b.view.current && (a.view.current || b.view.current)) out.push(`step: ${JSON.stringify(a.view.current)} → ${JSON.stringify(b.view.current)}`);
    else {
      const was = new Set(a.view.headings);
      const fresh = b.view.headings.filter((h) => !was.has(h)).slice(0, 2);
      if (fresh.length) out.push(`now showing ${fresh.map((h) => JSON.stringify(h)).join(', ')}`);
    }
  }
  out.push(...dialogLines);
  return out;
};
// Put `changed` right after the result's first key.
// `partial` (the form was larger than one read covers): an empty diff is not "none" — say unknown.
const withChanged = (r, list, partial = false) => {
  if (!r || typeof r !== 'object') return r;
  const changed = list.length ? (list.length > CHANGED_SHOWN ? [...list.slice(0, CHANGED_SHOWN), `+${list.length - CHANGED_SHOWN} more`] : list) : (partial ? 'unknown (form too large to compare)' : 'none');
  const keys = Object.keys(r);
  const out = {};
  keys.forEach((key, i) => { out[key] = r[key]; if (i === 0) out.changed = changed; });
  if (!keys.length) out.changed = changed;
  return out;
};

// Per-phase timings of one fast_click (debug only: the result carries them as `_debug`, which
// the runner logs and strips before the model reads the result). null when not timing.
let PHASES = null;
const phase = (name, ms) => { if (PHASES) PHASES[name] = (PHASES[name] || 0) + Math.round(ms); };

// A click whose id had gone stale and fell back to text says so; one re-resolved by its label says that.
const withIdStale = (r, args) => {
  if (!r || typeof r !== 'object' || !args) return r;
  if (args.__idStale && !r.idStale) return frontload(r, { idStale: true });
  if (args.__reResolved && !r.error) return frontload(r, { reResolved: true });
  return r;
};

// Set for the duration of a call made with noFrameNotice (a frame document the
// background reads itself).
const NO_FRAME_NOTICE = { on: false };

// The fast_wait polls still running in this document, each as its cancel function.
const ACTIVE_WAITS = new Set();

// Self-install. The background's bridge calls window.__fastlink.run(action, args).
// We DELIBERATELY do NOT build the index here. Eager indexing on every page load
// made this script a background parasite — on heavy SPAs (e.g. GCP) the initial
// DOM walk + a forever-on MutationObserver pegged the renderer with zero tool
// calls. The index now builds LAZILY on the first tool call (initIndex inside
// runPageAction), and the observer self-suspends on idle / disconnects on
// re-render storms. Cost on tabs you never automate: zero.
if (typeof window !== 'undefined') {
  window.__fastlink = window.__fastlink || {};
  window.__fastlink.run = async (action, args) => {
    NO_FRAME_NOTICE.on = !!(args && args.noFrameNotice);
    const write = WRITE_ACTIONS.has(action) && !(args && args.dryRun);
    const timing = action === 'fast_click' && !(args && args.dryRun);
    PHASES = timing ? {} : null;
    const tAll = nowMs();
    let before = null, stateMs = 0;
    if (write) { const t = nowMs(); try { initIndex(); drainPendingSync(2000, 20); before = formState(); } catch {} stateMs += nowMs() - t; phase('changedBeforeMs', nowMs() - t); }
    try {
      const tAct = nowMs();
      let r = withIdStale(await runPageAction(action, args), args);
      phase('actionMs', nowMs() - tAct);
      if (write && before && r && typeof r === 'object' && !r.error && !r.dryRun) {
        const t = nowMs();
        try { drainPendingSync(2000, 20); const after = formState(); r = withChanged(r, diffFormState(before, after), before.partial || after.partial); } catch {}
        stateMs += nowMs() - t;
        phase('changedAfterMs', nowMs() - t);
        window.__fastlink.lastChangedMs = Math.round(stateMs);   // cost probe for measurement, not in the result
      }
      const out = shortResult(action, r, args || {});
      try { noteServedDeep(out); } catch {}
      if (PHASES && out && typeof out === 'object') { phase('totalMs', nowMs() - tAll); out._debug = { phases: PHASES }; }
      return out;
    } finally { NO_FRAME_NOTICE.on = false; PHASES = null; }
  };
  window.__fastlink.cancelWaits = () => { const n = ACTIVE_WAITS.size; for (const c of [...ACTIVE_WAITS]) c(); return n; };
}
