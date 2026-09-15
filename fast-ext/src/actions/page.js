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

const SELECTOR = 'a[href],button,input:not([type="hidden"]),select,textarea,[contenteditable="true"],[contenteditable=""],[role="button"],[role="link"],[role="checkbox"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="switch"],[role="option"],[role="radio"],[onclick],[tabindex]:not([tabindex="-1"])';

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
const labelFor = (el) => {
  // 1) Explicit association: <label for="id">. Works across the element's own
  //    root (shadow DOM) and the main document.
  if (el.id) {
    const escId = CSS.escape(el.id);
    const root = el.getRootNode && el.getRootNode();
    const lbl = (root && root.querySelector && root.querySelector(`label[for="${escId}"]`))
              || document.querySelector(`label[for="${escId}"]`);
    if (lbl) return cleanLabel(lbl.textContent);
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
const containerLabel = (el) => {
  let p = el.parentElement;
  for (let hops = 0; p && hops < 5; hops++, p = p.parentElement) {
    let labels = [];
    try { labels = Array.from(p.querySelectorAll('label')).filter((l) => !l.contains(el)); } catch {}
    if (labels.length === 1) {
      const t = cleanLabel(labels[0].textContent);
      if (t) return t;
    }
    if (labels.length > 1) break; // ambiguous group — don't climb into a section
  }
  return '';
};

// Walks the composed tree (shadow roots + same-origin iframes). Generic
// version used by diagnose / select_option. Indexing has its own walker.
const walkDeep = (root, selector, visit) => {
  const walk = (r, ox, oy) => {
    if (!r || !r.querySelectorAll) return;
    let matches, all;
    try { matches = r.querySelectorAll(selector); all = r.querySelectorAll('*'); }
    catch { return; }
    for (const el of matches) {
      try { visit(el, { ox, oy, inFrame: ox !== 0 || oy !== 0 }); } catch {}
    }
    for (const el of all) {
      try {
        if (el.shadowRoot) walk(el.shadowRoot, ox, oy);
        if (el.tagName === 'IFRAME') {
          let doc = null;
          try { doc = el.contentDocument; } catch {}
          if (!doc) continue;
          let fr;
          try { fr = el.getBoundingClientRect(); } catch { continue; }
          walk(doc, ox + fr.x, oy + fr.y);
        }
      } catch {}
    }
  };
  walk(root, 0, 0);
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
  if (((el.getAttribute && el.getAttribute('role')) || '').toLowerCase() === 'textbox') return 'text';
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
    if (entry.live === 'value') {
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

// Walk a subtree and apply `onEl` to every element (including shadow + iframe).
// Iterative to handle deeply-nested DOMs without blowing the JS stack.
const walkSubtree = (root, onEl) => {
  const stack = [root];
  while (stack.length) {
    const el = stack.pop();
    if (!el || el.nodeType !== 1) continue;
    const tag = el.tagName.toLowerCase();
    if (SKIP_SUBTREE.has(tag)) continue;
    onEl(el);
    if (el.children) for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]);
    if (el.shadowRoot && el.shadowRoot.children) {
      for (let i = el.shadowRoot.children.length - 1; i >= 0; i--) stack.push(el.shadowRoot.children[i]);
    }
    if (tag === 'iframe') {
      let doc = null;
      try { doc = el.contentDocument; } catch {}
      if (doc) {
        const inner = doc.body || doc.documentElement;
        if (inner && inner.children) {
          for (let i = inner.children.length - 1; i >= 0; i--) stack.push(inner.children[i]);
        }
      }
    }
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
          let doc = null;
          try { doc = el.contentDocument; } catch {}
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
    let doc = null;
    try { doc = el.contentDocument; } catch {}
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
  if (reason === 'storm') INDEX.stormTripped = true;
};

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
  if (INDEX.stormTripped) return;        // stay out of the way on hot pages
  if (!INDEX.observer) setupObserver();
};

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
    let rect;
    try { rect = el.getBoundingClientRect(); } catch { continue; }
    if (!visible(el, rect)) continue;
    const isOverlayEl = overlayEls && overlayEls.has(el);
    const outOfView = !isOverlayEl && (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw);
    const offscreen = outOfView && entry.kind === 'click' && (matchAll || viewportOnly);
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
      const item = { i: entry.id, tag: entry.tag, text: entry.text, x, y, w, h };
      if (entry.role)        item.role = entry.role;
      if (entry.value)       item.value = entry.value;   // live DOM value, never cached
      if (entry.innerText)   item.innerText = entry.innerText;
      if (entry.label)       item.label = entry.label;
      if (entry.href)        item.href = entry.href;
      if (entry.name)        item.name = entry.name;
      if (entry.placeholder) item.placeholder = entry.placeholder;
      if (entry.ariaLabel)   item.ariaLabel = entry.ariaLabel;
      if (entry.describedBy) item.describedBy = entry.describedBy;
      if (entry.title)       item.title = entry.title;
      if (entry.type)        item.type = entry.type;
      if (off.inFrame)       item.inFrame = true;
      if (overlayEls && overlayEls.has(el)) item.inOverlay = true;
      if (offscreen)         item.offscreen = true;
      if (!offscreen && isEmptyFillable(el, entry)) fillable++;
      items.push(item);
    } else {
      content.push({ tag: entry.tag, text: entry.text, x, y, w, h, inFrame: off.inFrame || undefined });
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
  // Near-empty-page hint. Field feedback P2/P3/I1 (FEEDBACK_2026-06-24.md):
  // iframed login pages (idmsa.apple.com) return footer-only snapshots and the
  // agent wastes rounds screenshot-reading them. If the DOM yields almost nothing
  // (not merely capped) yet the page hosts a large cross-origin iframe, the real
  // UI is inside that iframe — steer the agent to the vision tier up front.
  let hint;
  if (items.length + content.length < 8 && !INDEX.capped) {
    try {
      for (const f of document.querySelectorAll('iframe')) {
        let blocked = false;
        try { blocked = !f.contentDocument; } catch { blocked = true; }
        if (!blocked) continue;
        const r = f.getBoundingClientRect();
        if (r.width > 200 && r.height > 150) {
          hint = 'page is nearly empty to DOM tools but holds a large cross-origin iframe — the real UI is likely inside it; use the vision tier (multi-target fast_point → fast_fill_vision / fast_click_xy) instead of screenshot-and-read';
          break;
        }
      }
    } catch { /* hint is best-effort */ }
  }
  // Batching nudge, as data: 2+ empty fields on one view → one fast_fill{fields}
  // (or one fast_batch), never field-by-field turns.
  if (fillable >= 2) hint = `${fillable} empty fillable fields visible; fill them in one fast_fill {fields:{label:value}} or one fast_batch` + (hint ? ' | ' + hint : '');
  return {
    url: location.href, title: document.title,
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
const AUTO_ITEM_CAP       = 30;   // action-result preview snapshot (tighter)
const AUTO_CONTENT_CAP    = 15;
const RANK_INTERACTIVE_TAGS  = new Set(['input', 'button', 'select', 'textarea']);
const RANK_INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'option', 'menuitem', 'tab',
  'combobox', 'switch', 'textbox',
]);
const rankItemScore = (it, vh, vw) => {
  let r = 0;
  if (it.inOverlay) r += 1000;                              // open menu/dropdown items: always first
  if (RANK_INTERACTIVE_TAGS.has(it.tag)) r += 100;
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
const capSnapshot = (snap, itemCap, contentCap) => {
  if (!snap || typeof snap !== 'object') return snap;
  const vh = window.innerHeight, vw = window.innerWidth;
  if (Array.isArray(snap.items) && itemCap >= 0 && snap.items.length > itemCap) {
    const ranked = snap.items
      .map((it, idx) => ({ it, idx, s: rankItemScore(it, vh, vw) }))
      .sort((a, b) => (b.s - a.s) || (a.idx - b.idx));
    noteDropped(snap, 'items', snap.items.length - itemCap);
    snap.items = ranked.slice(0, itemCap).map((x) => x.it);
    snap.count = snap.items.length;
  }
  if (Array.isArray(snap.content) && contentCap >= 0 && snap.content.length > contentCap) {
    const ranked = snap.content
      .map((c, idx) => ({ c, idx, s: (c.y >= 0 && c.y <= vh ? 100 : 0) - (c.y > vh * 3 ? 20 : 0) }))
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
const markTruncated = (snap, hintFor) => {
  if (!snap || typeof snap !== 'object') return snap;
  const d = snap.dropped || {};
  const off = snap.offscreenItems || 0;
  delete snap.dropped; delete snap.offscreenItems;
  if (!(d.items || d.content || d.textTrimmed || off)) return snap;
  const dropped = { ...d };
  if (off) dropped.offscreen = off;
  const parts = [hintFor(dropped)];
  if (snap.hint) parts.push(snap.hint);
  delete snap.hint;   // serializeSnapshot emits hint:undefined — spreading it would erase ours
  return { truncated: true, dropped, hint: parts.join(' | '), ...snap };
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
const AUTO_SNAP_MAX_CHARS = 8000;
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
const capAutoSnapshot = (snap, args) => {
  if (args && (args.full === true || args.full === 'true')) return markTruncated(snap, autoHint);
  const itemCap = (args && typeof args.limit === 'number' && args.limit >= 0) ? args.limit : AUTO_ITEM_CAP;
  capSnapshot(snap, itemCap, AUTO_CONTENT_CAP);
  return markTruncated(byteCapSnapshot(snap), autoHint);
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
    const settle = await settleDom(settleMs);
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
    const attachStale = (res) => {
      try {
        const vh = window.innerHeight, vw = window.innerWidth;
        const inView = (it) => !!it.inOverlay || !(it.y + it.h < 0 || it.y > vh || it.x + it.w < 0 || it.x > vw);
        const items = preSnap.items.filter(inView);
        const content = Array.isArray(preSnap.content) ? preSnap.content.filter(inView) : [];
        res.snapshot = capAutoSnapshot(
          { ...preSnap, count: items.length, items, contentCount: content.length, content },
          args,
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
      const snap = await serializeSnapshot(true, { budgetMs: 2000, drainMs: 30, indexMs: 1500 });
      // A navigating click can tear the page down so the fresh walk returns empty
      // — fall back to the match-time snapshot rather than returning nothing.
      if ((!snap || !Array.isArray(snap.items) || snap.items.length === 0) && hasPre) {
        attachStale(result);
      } else {
        result.snapshot = capAutoSnapshot(snap, args);
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
  // Visible open dialogs — for fast_click's dialogOpened/dialogClosed signal.
  const countDialogs = () => {
    let n = 0;
    try {
      const els = document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]');
      for (let i = 0; i < els.length && i < 50; i++) { let r; try { r = els[i].getBoundingClientRect(); } catch { continue; } if (visible(els[i], r)) n++; }
    } catch {}
    return n;
  };

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
  // Visibility of a FIELD, not its input: a non-searchable react-select renders a
  // 1px opacity-0 "dummy input", so measuring the input alone hides the whole
  // control. Measure the nearest ancestor whose class token ends in "control"
  // (react-select's own naming, prefixed or emotion-hashed) for those.
  const fieldVisible = (el, rect) => {
    if (visible(el, rect)) return true;
    if (!(el.matches && el.matches('input[id^="react-select-"]'))) return false;
    let p = el.parentElement;
    for (let hops = 0; p && hops < 6; hops++, p = p.parentElement) {
      if (/(?:^|\s)[\w-]*control(?:\s|$)/i.test(String(p.className || ''))) {
        let r; try { r = p.getBoundingClientRect(); } catch { return false; }
        return visible(p, r);
      }
    }
    return false;
  };
  // Resolve a section request. ALWAYS returns a report — callers must NOT fall
  // back to the unscoped pool on a miss (a silent wrong-field write is worse than
  // an error), which is exactly what the old `if (scoped.length)` guard did.
  //   { matched: n, sections: [every section title on the page], items: [scoped] }
  const resolveSection = (wantLo, sel = FILLABLE_SEL) => {
    let anchors;
    try { anchors = Array.from(document.querySelectorAll(SECTION_ANCHORS)).slice(0, MAX_ANCHORS); }
    catch { anchors = []; }
    const sections = [];
    for (const a of anchors) {
      const t = cleanLabel(a.textContent).slice(0, 80);
      if (t && !sections.includes(t)) sections.push(t);
    }
    const matched = anchors.filter(a => cleanLabel(a.textContent).toLowerCase().includes(wantLo));
    if (!matched.length) return { matched: 0, sections, items: [] };
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
    const items = [];
    for (const el of fillable) {
      if (!inAnySpan(el)) continue;
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
    return { matched: matched.length, sections, items };
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
      report.hint = 'no visible fillable field on this view at all — the form may sit in a cross-origin iframe (vision tier) or still be loading.';
    }
    return report;
  };
  // Nearest preceding heading/legend — the section name a model can pass back.
  const headingAbove = (el) => {
    try {
      const hs = document.querySelectorAll(SECTION_ANCHORS);
      for (let i = hs.length - 1; i >= 0; i--) { if (follows(hs[i], el)) { const h = cleanLabel(hs[i].textContent).slice(0, 80); if (h) return h; } }
    } catch {}
    return null;
  };
  // Every section title whose outline span holds `el`, outermost first.
  const sectionPathOf = (el) => {
    if (!el) return [];
    try {
      const anchors = Array.from(document.querySelectorAll(SECTION_ANCHORS)).slice(0, MAX_ANCHORS);
      return outlineTitles(anchors, el, anchorLevel, (a, b) => a.contains(b), follows, (a) => cleanLabel(a.textContent).slice(0, 80));
    } catch { return []; }
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
  // changing" settle hint on such a result only provokes needless waits.
  const calmIfVerified = (out) => {
    if (out && out.verified === true && out.settling) {
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
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ev = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, composed: true, button: 0 }));
    }
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
    let crossOrigin = 0;
    for (const f of document.querySelectorAll('iframe')) {
      try { if (!f.contentDocument) crossOrigin++; } catch { crossOrigin++; }
    }
    const totalHits = interactiveHits + nonInteractiveHits;
    const more = (examined >= DIAG_MAX_EXAMINE || layoutCandidates.length >= DIAG_LAYOUT_CAP) ? '+' : '';
    if (totalHits === 0) {
      if (stopped) out.push(`Text "${queryText}" not found in the first ${examined} elements (page too large to scan fully). Try more specific/visible text, fast_scroll, or narrow with role/tag.`);
      else out.push(`Text "${queryText}" not found in document, open shadow DOM, or same-origin iframes.`);
      if (crossOrigin > 0) out.push(`Page has ${crossOrigin} cross-origin iframe(s) — content there is not inspectable; the element may live inside.`);
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

  if (action === 'fast_snapshot') {
    const snap = await serializeSnapshot(!!args.viewport, { overlay: !!args.overlay });
    // full:true → the complete, uncapped set. Otherwise rank + cap (interactive /
    // on-screen first); `limit` overrides the default item cap. Any loss (cap or
    // viewport-only skips) leads the result as truncated:true + dropped + hint.
    if (args.full) return markTruncated(snap, explicitHint);
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
    const resolveEmpty = () => {
      const el = emptyHit.el;
      const found = { text: emptyHit.text, tag: el.tagName ? el.tagName.toLowerCase() : undefined, contentMatch: true };
      return resolve(withSnap({ found, emptyContainer: true, waitedMs: (args.timeoutMs || 5000), hint: `"${args.text || selector}" matched only an element with no visible box/content (stale or hidden container) — the view has not rendered; wait for text that only the finished view shows, or read again` }));
    };
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
    return new Promise((resolve) => {
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
        polls++;
        if (selector) {
          if (pollSelector() !== null) return;
          if (Date.now() > deadline) return emptyHit ? resolveEmpty() : resolve({ error: `Timed out waiting for selector ${JSON.stringify(selector)}`, ...pageActivity(), ...(acWaitHint() || {}) });
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
    const queryAllDeep = (root, selector) => {
      const out = [];
      walkDeep(root, selector, (el) => out.push(el));
      return out;
    };

    // Name/id lookups are explicit; label/aria/placeholder lookups only consider
    // VISIBLE control-like elements (controls first, then aria-labelled custom
    // widgets) and never a landmark/container — GCP's hidden "Skip links"
    // [aria-label] div once won "Application type" over the real combobox.
    const CONTROLISH = 'select,input,textarea,[role="combobox"],[role="listbox"],[role="textbox"],[role="searchbox"],[aria-haspopup],[contenteditable="true"],[contenteditable=""]';
    const LANDMARK_ROLES = /^(banner|complementary|contentinfo|main|navigation|region|form|group|dialog|alertdialog|search|toolbar|tabpanel|presentation|none|heading|list|table|grid)$/;
    const usableField = (el) => {
      let r; try { r = el.getBoundingClientRect(); } catch { return false; }
      if (!fieldVisible(el, r)) return false;
      const role = el.getAttribute('role');
      return !(role && LANDMARK_ROLES.test(role));
    };
    const findField = (fieldRaw, fieldLo) => {
      const nameSel = `[name="${CSS.escape(fieldRaw)}" i]`;
      // ONE composed-tree walk (a heavy page pays seconds per walk under a storm).
      const all = queryAllDeep(document, `${nameSel},${CONTROLISH},[aria-labelledby],[aria-label],[placeholder]`);
      const byName = all.find(el => el.matches && el.matches(nameSel));
      if (byName) return byName;
      const byId = lookupId(document.documentElement, fieldRaw);
      if (byId) return byId;
      const usable = all.filter(usableField);
      const isCtl = (el) => el.matches && el.matches(CONTROLISH);
      const candidatesAll = usable.filter(isCtl).concat(usable.filter(el => !isCtl(el)));
      // Wired label (for=/wrapping/aria-labelledby) OR a sibling <label> in the
      // same field group — the latter rescues react-select inputs whose only
      // aria-label is an opaque internal id (Greenhouse dropdowns).
      for (const el of candidatesAll) {
        const lbl = labelFor(el) || containerLabel(el);
        if (lbl && lbl.toLowerCase().includes(fieldLo)) return el;
      }
      for (const el of candidatesAll) {
        const al = el.getAttribute && el.getAttribute('aria-label');
        if (al && al.toLowerCase().includes(fieldLo)) return el;
      }
      for (const el of candidatesAll) {
        const ph = el.getAttribute && el.getAttribute('placeholder');
        if (ph && ph.toLowerCase().includes(fieldLo)) return el;
      }
      // HEADING-TITLED dropdown: no label/aria/placeholder carries the name, but a
      // heading does (react-select.com's demo: <h4>Single</h4> above an unlabelled
      // combobox; docs/demo pages and card-per-field forms do the same). Resolve
      // the name as a document-outline section and take its first dropdown-ish
      // control — same resolver + same "never a page-wide guess" rule as
      // fast_fill's `section`.
      const sec = resolveSection(fieldLo, DROPDOWN_SEL);
      if (sec.matched && sec.items.length) {
        const el = elById(sec.items[0].i);
        if (el) return el;
      }
      return null;
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
          let h = null;
          try {
            const hs = document.querySelectorAll(SECTION_ANCHORS);
            for (let i = hs.length - 1; i >= 0; i--) { if (follows(hs[i], el)) { h = cleanLabel(hs[i].textContent).slice(0, 80); break; } }
          } catch {}
          if (h) c.section = h;
          out.push(c);
        }
      } catch {}
      return out;
    };

    const optText = (o) => (o.textContent || '').trim().toLowerCase();

    // What the control DISPLAYS after the pick — the read-back that `verified`
    // compares against `picked`.
    const readShown = (el, kind, ctrl) => {
      try {
        if (kind === 'native-select') { const o = el.selectedOptions ? el.selectedOptions[0] : el.options[el.selectedIndex]; return o ? cleanLabel(o.text || o.value || '') : ''; }
        if (kind === 'react-select' && ctrl) {
          const vals = Array.from(ctrl.querySelectorAll('[class*="singleValue"],[class*="single-value"],[class*="multiValue__label"],[class*="multi-value__label"]'))
            .map(v => cleanLabel(v.textContent)).filter(Boolean);
          if (vals.length) return vals.join(', ');
          return cleanLabel(ctrl.textContent).slice(0, 200);
        }
        if (el.value != null && String(el.value)) return String(el.value).slice(0, 200);
        const ad = el.getAttribute && el.getAttribute('aria-activedescendant');
        const adEl = ad ? lookupId(el, ad) : null;
        if (adEl) return cleanLabel(adEl.textContent).slice(0, 200);
        return cleanLabel(el.textContent).slice(0, 200);
      } catch { return ''; }
    };
    // Returns as soon as the control's read-back shows the pick (polled every
    // 30ms), else at the cap — never a fixed DOM-quiet wait, which on a storming
    // page (GCP) always ran to SETTLE_MAX_MS.
    const withReadback = async (res, el, ctrl, timing = {}) => {
      const t0 = nowMs();
      const want = String(res.picked).toLowerCase();
      let value = '';
      for (;;) {
        value = readShown(el, res.kind, ctrl);
        if (value && value.toLowerCase().includes(want)) break;
        if (nowMs() - t0 >= SETTLE_MAX_MS) break;
        await wait(30);
      }
      timing.readbackMs = Math.round(nowMs() - t0);
      const verified = !!value && value.toLowerCase().includes(want);
      const head = { verified, picked: res.picked, value, field: describeField(el) };
      if (!verified) head.reason = `the dropdown now shows ${JSON.stringify(value)}, not "${res.picked}" — the pick did not take (or landed on another control: see field); do not report it as selected`;
      return frontload({ ...res, timing }, head);
    };

    // Set ONE dropdown. Returns a plain result object (no snapshot) so it can be
    // looped for batch mode. Success { verified, picked, value, field, kind },
    // miss { error, ... }. Shared by both forms. The field lookup is retried
    // until AUTO_WAIT_MS so a control still mounting is not a false miss.
    const setOne = async (fieldRaw, optionRaw) => {
      const fieldLo = String(fieldRaw == null ? '' : fieldRaw).toLowerCase();
      const optionText = String(optionRaw == null ? '' : optionRaw);
      if (!fieldLo || !optionText) return { error: 'field and option required' };

      const t0 = nowMs();
      const timing = {};   // performance.now() marks per phase, reported on every result
      let field = findField(fieldRaw, fieldLo);
      while (!field && nowMs() - t0 < AUTO_WAIT_MS) { await wait(150); field = findField(fieldRaw, fieldLo); }
      timing.resolveMs = Math.round(nowMs() - t0);
      if (field) { try { const r = field.getBoundingClientRect(); if (r.bottom < 0 || r.top > window.innerHeight) field.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {} }
      if (!field) {
        const act = pageActivity();
        return { error: `field "${fieldRaw}" not found — no dropdown/combobox/select carries that label, aria-label, placeholder, name, id, or titled section. Nothing was changed. Retry with one of the names in \`candidates\`.`, waitedMs: Math.round(nowMs() - t0), settling: act.settling, ...(act.settling ? { hint: 'the page was still changing — the control may not be rendered yet: fast_wait for text that identifies its view, then retry' } : {}), candidates: dropdownCandidates() };
      }

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
        return withReadback({ picked: target.text, kind: 'native-select' }, field, null, timing);
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
        if (!menuOpen) {
          ctrl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, button: 0 }));
          ctrl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, button: 0 }));
          ctrl.click();
        }
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
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
        target.click();
        timing.pickMs = Math.round(nowMs() - tp);
        return withReadback({ picked: (target.textContent || '').trim(), kind: 'react-select', opened: menuOpen ? 'already' : 'mousedown' }, field, ctrl, timing);
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
      const OPTION_SEL = '[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],li[data-value],[data-option-value]';
      const visibleOnly = (els) => {
        const out = [];
        for (let i = 0; i < els.length && i < 400; i++) { let r; try { r = els[i].getBoundingClientRect(); } catch { continue; } if (visible(els[i], r)) out.push(els[i]); }
        return out;
      };
      const optionEls = () => {
        for (const id of ariaPanelIds(field)) {
          const panel = lookupId(field, id) || document.getElementById(id);
          if (!panel) continue;
          const els = visibleOnly(panel.querySelectorAll(OPTION_SEL));
          if (els.length) return { els, via: 'aria-controls' };
        }
        let swept = null; try { swept = collectOverlayEls(); } catch {}
        if (swept && swept.size) {
          const els = visibleOnly([...swept].filter(el => el.matches && el.matches(OPTION_SEL)));
          if (els.length) return { els, via: 'overlay' };
        }
        const els = [];
        for (const el of INDEX.options) if (el.isConnected) els.push(el);
        return { els: visibleOnly(els), via: 'index' };
      };
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
      // "Open" = visible options in a panel this field names / an overlay, or
      // index options while the trigger claims aria-expanded — never bare index
      // options (another widget's).
      const panelOpen = () => { const f = optionEls(); return f.els.length && (f.via !== 'index' || expanded()) ? f : null; };
      const waitForPanel = (capMs) => new Promise((resolve) => {
        const t0 = nowMs(); let done = false, mo = null, timer = null, lastCheck = 0;
        const finish = (f) => { if (done) return; done = true; try { if (mo) mo.disconnect(); } catch {} clearTimeout(timer); resolve(f); };
        const check = () => {
          if (done || nowMs() - lastCheck < 30) return;   // a mutation storm must not turn the probe into the load
          lastCheck = nowMs();
          const f = panelOpen();
          if (f) finish(f); else if (nowMs() - t0 >= capMs) finish(null);
        };
        try { mo = new MutationObserver(check); mo.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded', 'aria-controls', 'aria-owns', 'hidden', 'style', 'class'] }); } catch {}
        // Shadow-root panels are invisible to a document observer: coarse fallback tick, wall-clock capped.
        const tick = () => { if (done) return; check(); if (!done) timer = setTimeout(tick, 100); };
        check(); if (!done) timer = setTimeout(tick, 100);
      });
      const fire = (el, types) => {
        for (const type of types) {
          const Ev = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
          el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, composed: true, button: 0, ...(type.startsWith('pointer') ? { pointerId: 1, isPrimary: true, pointerType: 'mouse' } : {}) }));
        }
      };
      const key = (el, k) => { const o = keyInit(k); el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keyup', o)); };
      const tOpen = nowMs();
      const tried = [];
      let opened = 'already';
      let panel = panelOpen();
      if (!panel) {
        tried.push('click'); opened = 'click';
        try { trigger.focus(); } catch {}
        fire(trigger, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
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
      let target = null, via = null, found = panel || optionEls(), starved = false;
      for (let tick = 0; ; tick++) {
        if (tick) { drainPendingSync(2000, 30); found = optionEls(); }
        target = pickOption(found.els);
        if (target) { via = found.via; break; }
        if (!opened || nowMs() - tStart >= budgetMs) break;   // nothing opened: report now, no 3s poll
        const before = nowMs();
        await wait(50);
        if (nowMs() - before > 1000) starved = true;   // the timer slept far past its 50ms: main thread starved
      }
      if (target) {
        const tp = nowMs();
        target.click();
        timing.pickMs = Math.round(nowMs() - tp);
        return withReadback({ picked: (target.textContent || '').trim(), kind: 'aria-listbox', via, opened }, field, null, timing);
      }
      const available = found ? found.els.slice(0, 10).map(el => (el.textContent || '').trim()).filter(Boolean) : [];
      const base = { tried: optionText, field: describeField(field), opened, elapsedMs: Math.round(nowMs() - t0), timing, panelIds: ariaPanelIds(field), available };
      if (!opened) return { error: `could not open the dropdown "${fieldRaw}" — no options appeared after ${tried.join(' / ')} on its trigger (${trigger.tagName.toLowerCase()}${trigger.getAttribute('role') ? ` role=${trigger.getAttribute('role')}` : ''}); nothing was changed`, triedOpen: tried, ...base, hint: 'fast_click the control and read the auto-snapshot for what opened; if the options are drawn on canvas / in a cross-origin frame use the vision tier (fast_point)' };
      return { error: 'no matching option in the open list', ...base, ...(starved ? { starved: true, hint: 'the page was re-rendering so heavily that timers starved; retry once the view settles (fast_wait for text of the finished state), or fast_click the option text directly' } : {}) };
    };

    // BATCH mode: a { field: option } map sets many dropdowns in one call —
    // each resolved + set in document via setOne, looped. An explicit single
    // field+option passed alongside is merged in (the selections map wins on a
    // key collision). Returns a per-field results map (like fast_fill_form).
    const selections = (args.selections && typeof args.selections === 'object' && !Array.isArray(args.selections))
      ? args.selections : null;
    if (selections) {
      const combined = { ...selections };
      if (args.field != null && args.option != null && !(args.field in combined)) {
        combined[args.field] = args.option;
      }
      const results = {};
      let picked = 0, failed = 0;
      for (const [fieldKey, opt] of Object.entries(combined)) {
        const r = await setOne(fieldKey, opt);
        results[fieldKey] = r;
        if (r && !r.error) picked++; else failed++;
      }
      const out = await withSnap({ verified: picked === Object.keys(combined).length && failed === 0, picked, failed, total: Object.keys(combined).length, results });
      return calmIfVerified(out);
    }

    // Single form: success wrapped with a fresh snapshot, misses returned plain.
    // A verified pick is settled by definition: the snapshot waits one short
    // quiet window, not the full SETTLE_MAX_MS (1s on a storming page).
    const r = await setOne(args.field, args.option);
    if (!r || r.error) return r;
    const ts = nowMs();
    const out = await withSnap(r, undefined, { settleMs: r.verified ? 150 : SETTLE_MAX_MS });
    if (r.timing) r.timing.snapshotMs = Math.round(nowMs() - ts);
    return calmIfVerified(out);
  }

  if (action === 'fast_hover') {
    const snap = await serializeSnapshot(false);
    const matches = matchItems(snap.items, args.text);
    if (matches.length === 0) return { error: `No element matching "${args.text}"`, diagnostics: diagnoseNoMatch(args.text) };
    const idx = typeof args.index === 'number' ? args.index : 0;
    if (idx >= matches.length) {
      return { error: `Only ${matches.length} matches for "${args.text}", index ${idx} out of range`, matches: matches.map(m => ({ tag: m.tag, role: m.role, text: m.text, label: m.label })) };
    }
    const item = matches[idx];
    const el = elAt(item);
    if (!el) return { error: 'Element not at expected coords' };
    let r = el.getBoundingClientRect();
    const vh = window.innerHeight, vw = window.innerWidth;
    const offViewport = r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw;
    if (offViewport) {
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      await wait(60);
      r = el.getBoundingClientRect();
    }
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    flashEl(el, 'hover');
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    return withSnap({ hovered: { tag: item.tag, text: item.text, x: Math.round(x), y: Math.round(y), scrolledIntoView: offViewport, totalMatches: matches.length, index: idx } }, snap);
  }

  if (action === 'fast_drag') {
    const snap = await serializeSnapshot(false);
    const fromMatches = matchItems(snap.items, args.from);
    if (fromMatches.length === 0) return { error: `No "from" element matching "${args.from}"` };
    const fromIdx = typeof args.fromIndex === 'number' ? args.fromIndex : 0;
    const fromItem = fromMatches[fromIdx];
    if (!fromItem) return { error: `Only ${fromMatches.length} from-matches for "${args.from}", index ${fromIdx} out of range` };
    const fromEl = elAt(fromItem);
    if (!fromEl) return { error: 'From element not at expected coords' };
    const fr = fromEl.getBoundingClientRect();
    const fx = fr.x + fr.width / 2, fy = fr.y + fr.height / 2;
    let tx, ty, toLabel = null;
    if (typeof args.toX === 'number' && typeof args.toY === 'number') {
      tx = args.toX; ty = args.toY; toLabel = `(${tx},${ty})`;
    } else if (args.to) {
      const toMatches = matchItems(snap.items, args.to);
      if (toMatches.length === 0) return { error: `No "to" element matching "${args.to}"` };
      const toIdx = typeof args.toIndex === 'number' ? args.toIndex : 0;
      const toItem = toMatches[toIdx];
      if (!toItem) return { error: `Only ${toMatches.length} to-matches for "${args.to}", index ${toIdx} out of range` };
      const toEl = elAt(toItem);
      if (!toEl) return { error: 'To element not at expected coords' };
      const tr = toEl.getBoundingClientRect();
      tx = tr.x + tr.width / 2; ty = tr.y + tr.height / 2;
      toLabel = toItem.text;
    } else {
      return { error: 'Pass either to (text match) or toX+toY (coordinates)' };
    }
    const fire = (target, type, x, y) => target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1,
    }));
    fire(fromEl, 'mousedown', fx, fy);
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const x = fx + (tx - fx) * (i / steps);
      const y = fy + (ty - fy) * (i / steps);
      fire(document.elementFromPoint(x, y) || document.body, 'mousemove', x, y);
    }
    fire(document.elementFromPoint(tx, ty) || document.body, 'mouseup', tx, ty);
    return withSnap({ dragged: { from: fromItem.text, to: toLabel, fromXY: [Math.round(fx), Math.round(fy)], toXY: [Math.round(tx), Math.round(ty)] } }, snap);
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
    const roleOk = (m) => {
      if (!wantRole) return true;
      const explicit = (m.role || '').toLowerCase();
      return explicit === wantRole || implicitRoleOf(m.tag, m.type) === wantRole
        || m.tag === wantRole || (TAG_AS_ROLE[wantRole] && (explicit === TAG_AS_ROLE[wantRole] || implicitRoleOf(m.tag, m.type) === TAG_AS_ROLE[wantRole]));
    };
    for (;;) {
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
        pool = pool.filter(m => m.tag === wantTag);
      }
      matches = matchItems(pool, args.text);
      // Prefer an ancestor control over a matched descendant / label-wrapped link
      // competing for the same text (radio named by its <label>; checkbox beside
      // "I agree to the <a>Policy</a>").
      matches = dropRedundantDescendantLinks(matches);
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
      if (nowMs() - t0 >= AUTO_WAIT_MS) {
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
        return { error: `No element matching "${args.text}". Nothing was clicked.`, ...tail, ...(secHint || {}), diagnostics: diagnoseNoMatch(args.text) };
      }
      await wait(150);
    }
    // index disambiguation: when an explicit index is given, address matches in
    // STABLE DOM order (document position), not rank order — rank order reshuffles
    // when sibling sections re-render, so index:1 would otherwise point at a
    // different element across calls. Default (no index) still takes the best-
    // RANKED match. role/tag narrowing already applied to the pool above.
    const idxGiven = typeof args.index === 'number';
    const ordered = idxGiven ? matches.slice().sort(docOrderCmp) : matches;
    const idx = idxGiven ? args.index : 0;
    if (idx >= ordered.length) {
      const off = ordered.filter(m => m.offscreen).length;
      return { error: `Only ${ordered.length} matches for "${args.text}" (${ordered.length - off} visible, ${off} offscreen), index ${idx} out of range`, matches: ordered.map(matchBrief) };
    }
    const item = ordered[idx];
    const el = elAt(item);
    if (!el) return { error: 'Element not at expected coords' };
    const scrolledIntoView = revealIfOffscreen(item, el);
    const sel = selectHintFor(el);
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
    const dialogsBefore = countDialogs();
    flashEl(el, 'click');
    el.click();
    const out = await withSnap({ clicked: item, willNavigate, totalMatches: ordered.length, index: idx }, snap);
    // What the click DID leads the result: where the page is now, whether the URL
    // moved, whether a dialog opened/closed, and what holds focus.
    const head = { clicked: item, url: location.href, urlChanged: location.href !== urlBefore };
    if (sel) { head.hint = sel.hint; head.selectField = sel.selectField; }
    if (scrolledIntoView) head.scrolledIntoView = true;
    const dNow = countDialogs();
    if (dNow > dialogsBefore) head.dialogOpened = true;
    else if (dNow < dialogsBefore) head.dialogClosed = true;
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
      // container is better than a hang (and callers can still pass `selector`
      // or use fast_wheel for canvas/virtualized cases).
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
    const target = found.el;
    const isDoc = target === document.scrollingElement || target === document.documentElement || target === document.body;
    const max = target.scrollHeight - target.clientHeight;
    let dest;
    if (args.to === 'top') dest = 0;
    else if (args.to === 'bottom') dest = max;
    else if (typeof args.to === 'string' && args.to.endsWith('%')) dest = max * (parseFloat(args.to) / 100);
    else if (typeof args.pixels === 'number') dest = (isDoc ? window.scrollY : target.scrollTop) + args.pixels;
    else return { error: 'Pass either to (top|bottom|"50%") or pixels (number), optional selector to target a specific scroller' };
    if (isDoc) window.scrollTo({ top: dest, behavior: 'instant' });
    else target.scrollTop = dest;
    const desc = target.tagName.toLowerCase()
      + (target.id ? `#${target.id}` : '')
      + (target.className && typeof target.className === 'string' ? '.' + target.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    return withSnap({ scrolled: true, scrollTop: isDoc ? window.scrollY : target.scrollTop, max, kind: found.kind, target: desc });
  }

  if (action === 'fast_network_replay') {
    const url = args.url;
    if (!url) return { error: 'url required' };
    const method = (args.method || 'GET').toUpperCase();
    const maxBytes = typeof args.maxBodyBytes === 'number' && args.maxBodyBytes > 0 ? args.maxBodyBytes : 16384;
    const startedAt = Date.now();
    try {
      const init = { method, credentials: 'include' };
      if (args.headers && typeof args.headers === 'object') init.headers = args.headers;
      if (args.body != null && method !== 'GET' && method !== 'HEAD') init.body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
      const resp = await fetch(url, init);
      const respHeaders = {};
      try { for (const [k, v] of resp.headers.entries()) respHeaders[k] = v; } catch {}
      let body = null;
      try { body = await resp.text(); } catch {}
      const truncated = body != null && body.length > maxBytes;
      return {
        url, method, status: resp.status, ok: resp.ok,
        durationMs: Date.now() - startedAt,
        headers: respHeaders,
        body: body == null ? null : (truncated ? body.slice(0, maxBytes) : body),
        bodyTruncated: truncated,
        bodyFullLength: body?.length || 0,
      };
    } catch (e) {
      return { error: String(e?.message || e), url, method, durationMs: Date.now() - startedAt };
    }
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
        if (sp.section) {
          const scoped = applySectionScope(sp.section);
          if (scoped.error) { misses.set(sp, scoped); continue; }
          pool = scoped.pool.filter(it => !usedI.has(it.i));   // REPLACES the pool — never a page-wide fallback
        }
        let ranked;
        if (sp.exactName != null) ranked = pool.filter(it => it.name && it.name.toLowerCase() === sp.exactName);
        else {
          // Exact label/name beats a substring ("URIs 1" must not grab "URIs 10").
          const exact = pool.filter(it => fieldMatchesExact(it, sp.m));
          ranked = exact.length ? exact : pool.filter(it => fieldMatchesText(it, sp.m));
        }
        if (!ranked.length) {
          misses.set(sp, sp.section
            ? { error: `No fillable element matching "${sp.match}" inside section "${sp.section}" — the section resolved but none of its ${pool.length} fillable field(s) carry that label. Nothing was filled.`, fieldsInSection: pool.slice(0, 12).map(fieldBrief) }
            : { error: `No visible fillable element matching "${sp.match}". Nothing was filled.` });
          continue;
        }
        const ordered = ranked.slice().sort(docOrderCmp);
        const idxGiven = typeof sp.index === 'number' && sp.index >= 0;
        // AMBIGUOUS: several fields carry this name and nothing (section/index)
        // picks one — refuse and list them. Writing the first would be a silent
        // wrong-field write (GCP: two "URIs 1" rows under two headings).
        if (ordered.length > 1 && !idxGiven && !sp.section) {
          const paths = ordered.map(it => sectionPathOf(elById(it.i)));
          const secs = distinguishingSections(paths);
          const candidates = ordered.map((it, i) => {
            const el = elById(it.i); const v = el ? liveValueOf(el) : it.value;
            const c = { label: it.label || it.ariaLabel || it.placeholder || it.name || it.text || null, section: secs[i], value: v == null ? '' : String(v).slice(0, 120), empty: !String(v ?? '').trim(), index: i };
            if (it.offscreen) c.offscreen = true;
            return c;
          });
          const secList = [...new Set(secs.filter(Boolean))].map(s => JSON.stringify(s)).join(' | ');
          misses.set(sp, { error: `${ordered.length} visible fields match ${JSON.stringify(sp.match)} — nothing was filled`, candidates, hint: `pass section:${secList || '"<heading above the field>"'} or index:N (0..${ordered.length - 1}, document order) to pick one` });
          continue;
        }
        const idx = idxGiven ? sp.index : 0;
        if (idx >= ordered.length) {
          const off = ordered.filter(it => it.offscreen).length;
          misses.set(sp, { error: `Only ${ordered.length} fillable match(es) for "${sp.match}" (${ordered.length - off} visible, ${off} offscreen), index ${idx} out of range`, matches: ordered.map(matchBrief) });
          continue;
        }
        found.set(sp, ordered[idx]);
        usedI.add(ordered[idx].i);
      }
      return { found, misses };
    };
    const t0 = nowMs();
    let snap, res;
    for (;;) {
      snap = await serializeSnapshot(false, { matchAll: true });
      res = resolveAll();
      const realMiss = [...res.misses.values()].some(m => !m.skipped && !m.candidates);   // an ambiguous match is final, not "still mounting"
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
        sel = selectHintFor(byId) || (() => { const c = document.querySelector(`[role="combobox"][aria-label*="${CSS.escape(sp.match)}" i]`); return c ? selectHintFor(c) : null; })();
      } catch {}
      if (sel) { out.hint = sel.hint; out.selectField = sel.selectField; }
      return out;
    };
    const act = pageActivity();
    const settleTail = act.settling ? { settling: true, hint: 'the page was still changing when this gave up — the field may not be rendered yet: fast_wait for text that identifies the target view, then fill again' } : {};

    // Fill everything that resolved (scrolling offscreen targets into view).
    const written = new Map();   // spec → { el, r }
    for (const [sp, it] of res.found) {
      const el = elAt(it);
      revealIfOffscreen(it, el);
      const r = fillItem(it, sp.value, sp.append);
      if (r.error) { res.misses.set(sp, r); continue; }
      if (it.ariaLabel && !r.filled.label) r.filled.ariaLabel = it.ariaLabel;
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
      const live = liveValueOf(el);
      const expected = r.kind === 'native-select' ? String(r.valueSet) : String(sp.value);
      const holds = live == null ? false
        : r.kind === 'native-select' ? live.toLowerCase() === expected.toLowerCase()
        : sp.append ? live.endsWith(expected) : live === expected;
      const head = { verified: holds, value: maskIfPassword(el, live == null ? '' : String(live).slice(0, 300)) };
      if (!holds) head.reason = `the field now reads ${JSON.stringify(head.value)} instead of the value written — the page reformatted, rejected or reverted it; do not report the written value as set`;
      return head;
    };

    if (!multi) {
      const sp = specs[0];
      if (!written.has(sp)) {
        const miss = enrichMiss(sp, res.misses.get(sp) || { error: 'not filled' });
        return frontload(miss, { error: miss.error, waitedMs, ...settleTail, ...(settleTail.hint && miss.hint ? { hint: settleTail.hint + '; ' + miss.hint } : {}) });
      }
      const { el, r, ac } = written.get(sp);
      const out = await withSnap(r, snap);
      const head = verifyOne(sp, el, r);
      if (ac) Object.assign(head, ac);
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
    let filled = 0, missed = 0;
    for (const sp of specs) {
      if (written.has(sp)) {
        const { el, r, ac } = written.get(sp);
        fields[sp.match] = { ...verifyOne(sp, el, r), ...(ac || {}), ...r };
        filled++;
      } else {
        fields[sp.match] = enrichMiss(sp, res.misses.get(sp) || { error: 'not filled' });
        missed++;
      }
    }
    const reverted = Object.keys(fields).filter(k => fields[k].verified === false && !fields[k].error);
    const head = { verified: missed === 0 && reverted.length === 0, filled, missed, total: specs.length };
    if (missed) head.summary = `${filled}/${specs.length} filled; missed: ${Object.keys(fields).filter(k => fields[k].error).join(', ')}`;
    if (reverted.length) head.reverted = reverted;
    const uncommitted = Object.keys(fields).filter(k => fields[k].committed === false);
    if (uncommitted.length) { head.uncommitted = uncommitted; head.hint = `${uncommitted.map(k => JSON.stringify(k)).join(', ')}: ${AC_OPEN_HINT} (one field at a time)`; }
    if (missed && act.settling) { head.settling = true; head.hint = settleTail.hint + (head.hint ? ' | ' + head.hint : ''); }
    return calmIfVerified(frontload(snapped, head));
  }

  return { error: `Unknown action: ${action}` };
 } catch (e) {
  return { error: 'page action threw: ' + (e?.stack || e?.message || String(e)).slice(0, 600) };
 }
}

// Self-install. The background's bridge calls window.__fastlink.run(action, args).
// We DELIBERATELY do NOT build the index here. Eager indexing on every page load
// made this script a background parasite — on heavy SPAs (e.g. GCP) the initial
// DOM walk + a forever-on MutationObserver pegged the renderer with zero tool
// calls. The index now builds LAZILY on the first tool call (initIndex inside
// runPageAction), and the observer self-suspends on idle / disconnects on
// re-render storms. Cost on tabs you never automate: zero.
if (typeof window !== 'undefined') {
  window.__fastlink = window.__fastlink || {};
  window.__fastlink.run = runPageAction;
}
