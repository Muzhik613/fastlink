// MCP tool definitions. Edit descriptions/schemas here only.

export const TOOLS = [
  {
    name: 'fast_status',
    description: 'Report whether FastLink can reach a browser from this connection, plus connection diagnostics — and, when SEVERAL browsers are paired, which ones are connected and which one this connection is currently driving. Call this first if other tools fail with "extension not connected", and before fast_profile to see the available browser names.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fast_profile',
    description: 'Pin WHICH browser this connection drives when more than one is connected. FastLink can be paired with several browsers at once (several Chrome profiles on the local broker; several paired browsers on the cloud relay), and each one has a NAME its owner sets on that browser\'s FastLink options page — the broker slot label ("primary", "secondary", or a custom label) locally, "This browser\'s name" on the cloud relay. Call once: install:"<name>" pins EVERY later call from this connection to that browser; the pin is held server-side and survives reconnects and clients that open a fresh session per tool call. install:"auto" releases it (calls then go to the most recently connected browser; on the local broker, the active slot). On the local broker, while MORE THAN ONE profile is connected, every tool except fast_status and fast_profile errors until this connection pins one (a label or "auto") — the error names the connected profiles. If the pinned browser is not connected, calls fail with a clear error naming which browsers ARE connected — they are NEVER silently redirected to a different browser. fast_status lists the paired browsers, which are connected, and the current selection.',
    inputSchema: {
      type: 'object',
      properties: {
        install: { type: 'string', description: 'Browser name to pin to (e.g. "primary", "secondary", "work"), or "auto" to release the pin. Lowercased, [a-z0-9_-].' },
      },
      required: ['install'],
    },
  },
  {
    name: 'fast_snapshot',
    description: 'PRIMARY, fast way to READ and understand the active Chrome tab — structured DOM, no image parsing. PREFER THIS OVER A SCREENSHOT to read page content; do not screenshot and read it yourself. Returns TWO arrays: `items` (clickable elements with text, coords, href, tag, role, label, name, plus — for form controls — the LIVE `value` read straight from the DOM at snapshot time, never a cached one, so a field you just filled reports what it actually holds) AND `content` (block-level readable text — headings, paragraphs, list items, table cells, dashboard stats — with coords). Walks open shadow roots AND same-origin iframes (Google OAuth/billing flows), with coords reported in outer-page space. Resolves aria-labelledby / aria-describedby (multi-id refs supported), so Angular Material / cfc-select and other web-component design systems show up with their visible label rather than a blank "name". Items inside iframes have `inFrame: true`. Content excludes text already represented in items (exact-match dedup) and only emits deepest-level text containers to avoid parent/child duplication. Pass screenshot:true to also get a visual. **Pass overlay:true when a dropdown/menu/popover is open but its items are missing from a normal snapshot** — it additionally sweeps portaled overlay containers (Radix menus, react-select/Downshift/MUI menus, Angular cdk-overlay, any [role=menu]/[role=listbox]) and tags those items `inOverlay:true`. This is the escalation rung below a screenshot for transient popover UI. **The returned view is PRIORITIZED and CAPPED for token efficiency**: items are ranked so interactive controls (input/button/select/textarea/link/[role=button|link|checkbox|radio|option|menuitem|tab|combobox|switch|textbox]) and on-screen / above-the-fold elements come first, and the long tail (e.g. dozens of footer/nav links far down the page) comes last; the list is capped (~70 items, ~30 content); when anything is cut (the cap, or viewport:true skipping off-screen controls) the result STARTS with `truncated:true`, `dropped:{items,content,offscreen}` and a `hint` naming the exact call that returns the rest — never answer or report from a truncated read. Pass `full:true` for the complete uncapped set, or `limit:<N>` to set your own item cap. An open dialog (a declared one, or a popup layer holding focus) is named in `dialog:{label, items}` with the ids of its fields and buttons, and its controls rank first so a capped read never drops its OK / Cancel. A control outside the viewport (below the fold of the page or of a frame) is listed with `offscreen:true` and its position; fast_click / fast_fill / fast_select_option scroll it into view before acting. Per-item null/empty fields are omitted (a key appears only when it has a value). `fillable:N` (near the top) counts the EMPTY fillable fields on the view; when N ≥ 2 the `hint` says so — fill them all in ONE fast_fill {fields} or one fast_batch, never field-by-field. NOTE: the auto-`snapshot` attached to fast_click/fast_fill/fast_wait/etc. results is an even more compact PREVIEW (tighter cap) — call fast_snapshot for the full view. A radio/checkbox item carries `checked`; one whose input is visually hidden behind a visible <label> is listed AS the control (`via:"label"`, the label\'s box). Script-only click targets (an <a> with no href, cursor:pointer text) are listed with `clickable:"script"`, ranked after real controls. **Visible frames are read too** (any iframe with its own page — cross-origin or same-origin — nested up to 2 deep): their content comes under `frames:[{frame, url, frameId, box, items, content}]`, with every item\'s x,y in top-page coordinates (fast_click_xy lands on them) and ids "f<frameId>:<i>" (fast_click {id} goes straight there); `framesNote` leads the result when any were read. A frame that could not be read is still named in `frameNotice` (screenshot + fast_click_xy there). Pass `frame` to read just one frame.',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'Act inside the visible frame whose URL contains this (see `frames` / `framesNote` in fast_snapshot, or an ambiguity refusal\'s candidates). Omit to let the tool find the document that holds the target.' },
        viewport: { type: 'boolean', description: 'If true, only return elements currently visible in the viewport (excludes off-screen). Faster on long pages.' },
        overlay: { type: 'boolean', description: 'If true, also scan known portal/popover containers (Radix, react-select, Downshift, MUI, cdk-overlay, [role=menu]/[role=listbox]) and include their interactive items tagged `inOverlay:true`. Use when a menu/dropdown is open but its options are missing from a normal snapshot (they portal to <body> and/or race the snapshot). Opt-in so the default snapshot stays fast.' },
        full: { type: 'boolean', description: 'If true, return the COMPLETE uncapped item/content set (no ranking/cap; `truncated` can then only come from viewport:true). Use when the default capped view trimmed something you need (e.g. a deep footer link).' },
        limit: { type: 'number', description: 'Override the default item cap (~70). The top-ranked N items are returned (interactive / on-screen first); ignored when full:true.' },
        screenshot: { type: 'boolean', description: 'If true, also capture a screenshot of the visible tab and return its /tmp path alongside the snapshot.' },
        screenshotFormat: { type: 'string', enum: ['png', 'jpeg'], description: 'Format for the inline screenshot (default png).' },
      },
    },
  },
  {
    name: 'fast_click',
    description: 'Click an element matching text/label/aria-label/placeholder. Matches are auto-ranked so visible-content matches beat aria-label matches, which beat tooltip-only (title) matches; and when text scores are close, real interactive CONTROLS (button/input/radio/checkbox/[role=button|radio|checkbox|option|menuitem|tab|switch|link]) are preferred over generic links or plain text — so a radio labelled "External" beats a link reading "External", and an "I agree" checkbox beats the policy link inside its label. The right control usually wins on its own. When that\'s not enough, narrow with role (e.g. "menuitem", "option", "button") or tag (e.g. "mat-option", "a"), or use index to pick the N-th match in document order. On a miss, the response includes diagnostics explaining why (hidden, behind aria-hidden, non-interactive, off-screen, cross-origin iframe, etc.) — read them before retrying (on very large pages these diagnostics may be partial/count-only, since heavy pages are now bounded rather than allowed to freeze). **Returns include a FRESH POST-click `snapshot` (items + content): a re-walk taken AFTER the click settles, so a dropdown it opened or a re-render it triggered IS reflected — chain decisions off it without a separate fast_snapshot. Opt out with noSnapshot:true. On a navigating click (or a page too heavy to re-serialize in time) it falls back to the pre-click capture, flagged `snapshotStale:true`; a navigating click is additionally flagged so you re-snapshot after the new page loads.** Pass screenshot:true to also get a post-click visual. **The result LEADS with what the click did**: `url` + `urlChanged`, `dialogOpened` (the dialog\'s name) / `dialogClosed`, and `focused` (the element holding focus afterwards) come before the snapshot; `settling:true` means the page was still mutating when the snapshot was taken — fast_wait for the finished state before reading it. A miss keeps looking for the target for up to 1.5s (the page may still be rendering) before returning it with `waitedMs`/`settling`; nothing is clicked on a miss. Offscreen elements are matched too (scrolled into view first, `scrolledIntoView:true`); an index-out-of-range miss lists every match with `offscreen`/`section`. `role` also accepts a tag name (role:"a" = link, "button", "input"); a role mismatch returns the matches\' real role/tag + a hint. When the target is a dropdown (native select, react-select value/chip/input, combobox) the result carries `hint` + `selectField` naming the field for fast_select_option — use that instead of clicking values. A radio/checkbox whose input is visually hidden behind its visible <label> (GOV.UK, Bootstrap btn-check) is matched by the label text and clicked as the control; a check-type control\'s result carries `checked` + `verified` (radio: now selected; checkbox: toggled) and a `reason` when not. Script-only targets — an <a> with no href, cursor:pointer text, a pointer-cursor element whose aria-label/title/alt is the text — are click candidates ranked BELOW every real control (`clickable:"script"`, implicit role "generic"); they and custom widgets get the full pointer sequence (pointerdown→mousedown→pointerup→mouseup→click), native controls el.click(). An explicit `role` matches an element\'s OWN role attribute before an implicit one (role:"combobox" = the [role=combobox] widget, not a native <select>). When the best match is a dropdown and another dropdown also matches (a native <select> and the widget shadowing it, one per row), NOTHING is clicked: the error lists `candidates` {index, tag, role, label, section, value, row} — pass index or role. **A plain row/cell is reachable by its text too:** when nothing else matches, the SMALLEST visible element whose own text (or aria-label/title/alt) IS the text gets the full pointer sequence, flagged `clickable:"script"` with `via:"pointer-cursor"` or `via:"text"` — so a grid row or tree row with no role, no ARIA and no pointer cursor no longer needs coordinates. A match that is a CONTAINER (its own text does not carry the query — a whole tree/list host) is narrowed to the row inside it that does (`via:"text-leaf"`); real controls are never narrowed. A miss inside a scroll container that renders only what is in view names it in `scrollers` + `hint`: rows below that container\'s fold are not in the DOM until you fast_scroll {selector} there and click again. **Frames are reached too:** when the target is not in the top document but is in a visible frame — cross-origin or same-origin (an embedded checkout / card form, a portal blade, a console form in an iframe), the same action runs inside that frame and the result carries `inFrame:{frame, url, frameId}` with coordinates in top-page space; a target that exists in more than one document (top + a frame, or two frames) is refused with `candidates` from each — pass `frame:"<part of the frame URL>"` or the item `id`. Pass `id` (an item\'s `i` from a snapshot, e.g. 42 or "f7:42") to click that exact element; it is used only while that element is still in the page (and still carries `text`, if you pass both) — otherwise the call falls back to `text` with idStale:true, or refuses without text.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text content / label / aria-label / placeholder substring (case-insensitive). Required unless `id` is given.' },
        id: { type: 'string', description: 'A snapshot item\'s `i` ("42", or "f7:42" for an item inside a frame). Clicks exactly that element while it is still on the page.' },
        frame: { type: 'string', description: 'Act inside the visible frame whose URL contains this (see `frames` / `framesNote` in fast_snapshot, or an ambiguity refusal\'s candidates). Omit to let the tool find the document that holds the target.' },
        role: { type: 'string', description: 'Restrict to elements whose [role] attribute equals this (e.g. "menuitem", "option", "button", "tab"). Use when text alone matches the wrong element.' },
        tag: { type: 'string', description: 'Restrict to elements whose HTML tag equals this (lowercase, e.g. "a", "button", "mat-option"). Use for design-system custom elements.' },
        index: { type: 'number', description: 'With `text` only: pick the N-th match (0-based) in document order. Not an item id — use `id` for that.' },
        screenshot: { type: 'boolean', description: 'If true, capture a screenshot after clicking and return its /tmp path in the result.' },
        screenshotFormat: { type: 'string', enum: ['png', 'jpeg'], description: 'Format for the inline screenshot (default png).' },
        noSnapshot: { type: 'boolean', description: 'If true, skip the fresh post-click snapshot and return just the action outcome.' },
      },
    },
  },
  {
    name: 'fast_fill',
    description: 'Fill fields by label/placeholder/name — ONE field with `match` + `value`, or a WHOLE FORM in one call with `fields`: { "<label>": "<value>" | { value, index, section, name, exact, append } } (native <select>s included: the value is matched against option text/value and selected). A form with 2+ inputs is ALWAYS one fast_fill {fields} (or one fast_batch), never field-by-field turns. An EXACT label/aria-label/placeholder/name match is preferred over a substring match, so "Email" won\'t lose to "Email confirmation"; replaces the existing value (append:true keeps it). Repeated labels: `index` (N-th match in document order) or `section` (a titled group by document outline; `near` is an alias) — `section` NEVER falls back to a same-labelled field elsewhere: an unresolvable section ERRORS and lists the page\'s `sections`. Offscreen fields are matched too (scrolled into view before the write). **The result LEADS with `verified` and the field\'s LIVE `value`** after the page settled (single form), or with `verified`/`filled`/`missed` + per-field `fields:{label:{verified,value,…}}` (fields form) — report `value`, never what you sent; verified:false carries a `reason`. A miss keeps looking for up to 1.5s, then returns `candidates` (visible fields), `hiddenMatches`, `offscreenMatches` (with their section) and a `hint`; when the name belongs to a dropdown/react-select the hint names the field for fast_select_option. Every result carries a fresh post-fill `snapshot` (noSnapshot:true to skip). Input/change events are dispatched composed:true (web-component / Angular-Material forms validate correctly). A checkbox/radio takes value:true (tick) / false (clear), is set by a click and read back as `checked`. Repeated rows (a data grid): a write names the row it landed in (`filled.row` {row, rows, rowFirst}); a label matching 2+ visible fields — even inside the given `section` — or ONE visible field whose label also exists hidden in another row of the same rows, is REFUSED with `candidates` naming each row (row, rowFirst = that row\'s first filled value, visible) until `index` picks one — never a silent write to the first row. **Frames are reached too:** when the target is not in the top document but is in a visible frame — cross-origin or same-origin (an embedded checkout / card form, a portal blade, a console form in an iframe), the same action runs inside that frame and the result carries `inFrame:{frame, url, frameId}` with coordinates in top-page space; a target that exists in more than one document (top + a frame, or two frames) is refused with `candidates` from each — pass `frame:"<part of the frame URL>"` or the item `id`. With `fields`, each field is placed in the document that holds it, each frame field reports `frame`, and the head rolls every document up. Card numbers are read back masked to their last 4 digits.',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'Act inside the visible frame whose URL contains this (see `frames` / `framesNote` in fast_snapshot, or an ambiguity refusal\'s candidates). Omit to let the tool find the document that holds the target.' },
        match: { type: 'string', description: 'Placeholder/label/name/aria-label/text substring of ONE field (exact match preferred). Omit when passing `fields`.' },
        value: { type: 'string', description: 'Value for the `match` field (use "" to clear).' },
        fields: { type: 'object', description: 'Fill several fields at once: { "<label>": "<value>" }. A value may be an object { value, index, section, name, exact, append } — `index` (0-based, document order) or `section` (titled group) disambiguate repeated labels, `name`/`exact:true` match the exact name attribute. Selects are set by option text/value.' },
        append: { type: 'boolean', description: 'If true, append to the existing value instead of replacing' },
        index: { type: 'number', description: 'When multiple fields match `match`, pick the N-th (0-based) in stable DOCUMENT order. Omit to take the best/exact match.' },
        section: { type: 'string', description: 'Scope the match to one titled group (heading/legend), e.g. "Authorized redirect URIs" — for `match`, or as the default for every `fields` entry. Resolved by DOCUMENT OUTLINE (works when the heading is not an ancestor, as on Angular Material / GCP). Unresolvable → the call ERRORS and lists the page\'s section titles; it never silently fills a field elsewhere.' },
        near: { type: 'string', description: 'Alias for `section`. Prefer `section`.' },
        noSnapshot: { type: 'boolean', description: 'If true, skip the fresh post-fill snapshot and return just the verified state.' },
      },
    },
  },
  {
    name: 'fast_tab',
    description: 'Open a new Chrome tab at the given URL and wait for it to load (up to waitMs, default 10000). Returns the tab id, its URL, and `snapshot`: the same bounded preview an action returns (visible frames\' items included), so you can act on the page without a separate fast_snapshot. The preview lists what it left out under `omitted`; call fast_snapshot before reporting values or concluding something is absent. noSnapshot:true skips it.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open' },
        background: { type: 'boolean', description: 'If true, do not switch to the new tab. Defaults to false (focus the new tab).' },
        waitMs: { type: 'number', description: 'Max ms to wait for the page to load and settle (default 10000).' },
        noSnapshot: { type: 'boolean', description: 'If true, skip the page preview and return just the tab id and URL.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'fast_nav',
    description: 'Navigate the active Chrome tab to a URL. Waits for the load to complete (up to waitMs, default 10000) before returning, and returns `snapshot`: the same bounded preview fast_tab returns (noSnapshot:true skips it) — override with waitMs to wait longer for slow pages or shorter to return early. Then HEALTH-CHECKS the page.js content script (with a short settle-retry, because it re-attaches asynchronously and can race the return — which is what made post-nav snapshots come back empty) and returns `contentScript`: "fresh" (it was already live), "reinjected" (it was stale/missing — common after the extension was reloaded — so FastLink re-injected it), or "stale" (still not live, e.g. a restricted chrome:// URL). A "stale" result ALSO includes a `hint`: subsequent snapshot/click/wait may return empty or falsely idle, so fast_nav to the same URL to recover.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        waitMs: { type: 'number', description: 'Max ms to wait for the load to complete (default 10000).' },
        noSnapshot: { type: 'boolean', description: 'If true, skip the page preview.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'fast_list',
    description: 'List the open tabs in EVERY Chrome window (the current window\'s tabs first), each with id, windowId, url, title, and active state (`active` is per window: windowId says which window a tab is active in). A tab whose URL changed while the extension was running also carries `trail:[{t,url}]` — its last 50 URL changes with ms-epoch timestamps, recorded passively — so a watcher polling every few seconds still sees every stop.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fast_switch',
    description: 'Switch focus to a specific Chrome tab. Pass either a tabId (from fast_list) or a match (case-insensitive substring of URL or title). After switching, fast_snapshot/fast_click/fast_fill operate on this tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab id from fast_list' },
        match: { type: 'string', description: 'URL or title substring to match' },
      },
    },
  },
  {
    name: 'fast_wait',
    description: 'Wait for the page to reach a state. Modes: (1) `text` — a case-insensitive substring appears in the rendered DOM (use two or more words: a single common word matches elsewhere); (2) `selector` — a CSS selector matches a visible element; (3) `networkIdle: true` — in-flight requests settle for `idleMs` (default 500ms). With text/selector AND networkIdle the text is the signal: it resolves as soon as the text is visible and reports `networkIdle:false, pending:N` when the network is still busy (SPAs long-poll forever) — only a bare networkIdle wait times out. On a match it returns `{ found: { i, tag, text, x, y, w, h, … }, snapshot }` — the matched element PLUS a fresh snapshot of the settled view (noSnapshot:true to skip). A match on an element with NO visible box or whose text is gone (a stale/emptied container) does not count: it keeps waiting, and at the deadline returns `emptyContainer:true` with a hint instead of a false "found". On text timeout the result includes `headings: [...]` (the visible h1/h2/h3 texts) so you can tell whether you landed on the wrong page. A `text` wait also searches every rendered sub-frame, cross-origin iframes included: a hit there resolves with `inFrame:true` and `found.frame` (the frame URL), and that frame\'s elements are targetable like any others: fast_snapshot lists them under `frames`, and fast_click / fast_fill / fast_select_option act on them by text, by id "f<frameId>:<i>", or with frame:"<part of the frame URL>". Pass `frame` here to wait for text or a selector inside one frame only. A text timeout on a page with frames adds `frames:{searched, unsearched}` (origins), and a hint when some frame could not be searched.',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'Wait inside the visible frame whose URL contains this (see `frames` / `framesNote` in fast_snapshot, or an ambiguity refusal\'s candidates). Omit to let the tool find the document that holds the target.' },
        text: { type: 'string', description: 'Text to wait for (case-insensitive substring match).' },
        selector: { type: 'string', description: 'CSS selector to wait for (first VISIBLE match). Alternative to text.' },
        networkIdle: { type: 'boolean', description: 'If true, wait for the network to go quiet for idleMs (alone), or report the network state alongside a text/selector match.' },
        idleMs: { type: 'number', description: 'Required quiet duration in ms for networkIdle mode (default 500).' },
        timeoutMs: { type: 'number', description: 'Max total wait in ms (default 5000 for text/selector, 10000 for networkIdle).' },
        noSnapshot: { type: 'boolean', description: 'If true, skip the post-match snapshot (return just `found`).' },
      },
    },
  },
  {
    name: 'fast_evaluate',
    description: 'Escape hatch: run arbitrary JavaScript in the active Chrome tab (MAIN world, full DOM access). Pass a function declaration as a string. Function may be async. Optionally pass args array to be spread into the function. Return value is JSON-serialized. Runs via Chrome DevTools Protocol so strict CSP / Trusted Types pages (Google Cloud Console, claude.ai, GitHub Enterprise) work; a yellow "FastLink started debugging this browser" banner will appear while it runs. Falls back to in-page eval if the debugger can\'t attach.',
    inputSchema: {
      type: 'object',
      properties: {
        fn: { type: 'string', description: 'JS function declaration, e.g. (id) => document.getElementById(id)?.value' },
        args: { type: 'array', description: 'Arguments to pass to the function (avoid string interpolation pitfalls)', items: {} },
      },
      required: ['fn'],
    },
  },
  {
    name: 'fast_frame_read',
    description: 'SCORER ONLY — not offered to a driving model. Reads labelled form fields inside the frames of the active tab whose URL contains `frame`. Returns {frames:[matching frame URLs], fields:{<label>:{found, count, value, tag, role}}}. value: input/textarea .value exactly, untrimmed; <select> the selected option text; combobox the text it shows; "" when that is its placeholder; null for a password field or when count > 1. Labels are matched via <label>, then aria-labelledby, then aria-label, then the text of the field\'s form row. No frame matches → {error, frames:[every frame URL]}.',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'Substring of the frame URL.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Visible label texts of the fields to read.' },
      },
      required: ['frame', 'fields'],
    },
  },
  {
    name: 'fast_text',
    description: 'Read text (or HTML) from the active Chrome tab. CSP-safe: works on pages where fast_evaluate is blocked (claude.ai, strict CSP). Defaults to body innerText. Pass selector for a specific element. A selector that matches a form control (input / textarea / select / contenteditable / role=combobox|textbox|searchbox) returns its LIVE value as text plus field:{tag,label,value} (fields:[…] when it matches several) — read a field back this way, not with a parent\'s text. An empty read returns empty:true: it is not confirmation of anything. When maxLen cuts the text the result STARTS with `truncated:true`, `dropped.chars` and a `hint` naming the call that returns the rest — never extract from a truncated read.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector to extract from (default: document.body)' },
        html: { type: 'boolean', description: 'If true, return outerHTML instead of innerText (default false)' },
        maxLen: { type: 'number', description: 'Optional max characters to return; truncates with truncated:true flag' },
      },
    },
  },
  {
    name: 'fast_select_option',
    description: 'Pick an option from a dropdown/combobox/select. Handles native <select>, react-select, Angular Material / cfc-select / mat-option, ARIA comboboxes, and generic dropdowns. Field lookup walks shadow DOM and resolves aria-labelledby across shadow boundaries — so "Industry" finds a cfc-select labelled by a separate <div id="industry-label">. Match priority for options: exact text > startsWith > substring. BATCH: to set MANY dropdowns, pass a `selections` map { "<field>": "<option>", ... } (keys = label/aria/name/placeholder substrings, values = option text or value) and they are ALL set in ONE call — much faster than one call per dropdown. Batch returns { picked, failed, total, results: { "<field>": <per-field result or error> } } (like fast_fill_form). Single mode (field + option) is unchanged; if you pass both `selections` and field+option they are merged (selections wins on a key collision). Tip: for a form of native <select>s + text inputs, fast_fill_form can do dropdowns AND inputs together — use this batch for custom (react-select/ARIA) dropdowns. Returns include a fresh `snapshot` of the post-selection viewport (opt out with noSnapshot:true). The change/input events are dispatched composed:true, so they cross shadow boundaries and validate correctly on web-component / Angular-Material / custom-element design systems (e.g. a composite Angular control whose validator listens outside the select\'s shadow root). **The result LEADS with `verified`, `picked`, `value` (what the control shows after the pick) and `field` (label / aria / name / id / the heading above the dropdown it acted on)** — check `field` whenever several dropdowns exist: a field name that is really a VALUE shown by another select resolves to THAT select, and this is where you see it. A miss keeps looking for the field for up to 1.5s, then returns `candidates` (every visible dropdown with the names it would match on) and `settling:true` when the page was still changing. **Ambiguity is refused, never guessed:** when the field resolves to 2+ VISIBLE dropdowns (a label repeated per row; a native <select> and a widget in one titled section) nothing is selected and the error lists `candidates` {index, tag, role, label, section, visible, value, row/rows/rowFirst} — pass `index` (N-th VISIBLE candidate, document order) or `section` (a titled group, as in fast_fill). A hidden native <select> behind a visible widget (Select2 / Choices / Tom Select) is that widget\'s backing store: the WIDGET is set and its shown value verified (`backingValue` reports the hidden select). One visible match whose label also exists hidden in another row of the same repeated rows is refused too; a pick in a repeated row names it (`row`). `selections` values may be {option, index, section}; the batch `verified` is true only when EVERY field verified (`picked` counts verified picks, `summary` names the rest). **Frames are reached too:** when the target is not in the top document but is in a visible frame — cross-origin or same-origin (an embedded checkout / card form, a portal blade, a console form in an iframe), the same action runs inside that frame and the result carries `inFrame:{frame, url, frameId}` with coordinates in top-page space; a target that exists in more than one document (top + a frame, or two frames) is refused with `candidates` from each — pass `frame:"<part of the frame URL>"` or the item `id`. With `selections`, each field is placed in the document that holds it and reports `frame`.',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'Act inside the visible frame whose URL contains this (see `frames` / `framesNote` in fast_snapshot, or an ambiguity refusal\'s candidates). Omit to let the tool find the document that holds the target.' },
        field: { type: 'string', description: 'Single-dropdown field identifier — label text, aria-label, name, or id (case-insensitive). Omit when using `selections`.' },
        option: { type: 'string', description: 'Option text to select (case-insensitive). Exact match preferred. Used with `field`.' },
        selections: { type: 'object', description: 'BATCH map of field → option to set many dropdowns in one call, e.g. { "Country": "United States", "State": "California", "Timezone": "PST" }. Keys match label/aria-label/name/placeholder (case-insensitive); values match option text or value, or are { option, index, section }. Much faster than one call per dropdown.' },
        index: { type: 'number', description: 'When the field name matches several dropdowns (a label repeated per row), pick the N-th VISIBLE one (0-based) in document order. Used with `field`.' },
        section: { type: 'string', description: 'Restrict `field` to the dropdowns inside this titled section (heading/legend, by document outline) — never falls back to a page-wide match; unresolvable → an error listing the page\'s sections.' },
        noSnapshot: { type: 'boolean', description: 'If true, skip the fresh post-selection snapshot and return just the action outcome.' },
      },
    },
  },
  {
    name: 'fast_screenshot',
    description: 'Capture the active Chrome tab and return the IMAGE itself (you see it directly). Use it to confirm something looks right, and to SEE what DOM tools truly cannot read: a canvas, an image, a custom-drawn control, or a frame that a snapshot\'s frameNotice names as unreadable (visible cross-origin frames are normally READ by fast_snapshot under `frames` and acted in by fast_click/fast_fill — use those first). For page text and controls prefer fast_snapshot: it is instant and exact, while coordinates estimated from an image are often off. The image is at CSS-pixel scale: a point read off it IS the x,y fast_click_xy takes, one to one, on every screen (HiDPI included); a text item alongside carries {cssWidth, cssHeight, dpr, scale:1}. Pass fresh:true if a recent screenshot looked stale/identical after a focus/navigation change — it reads the live window surface via CDP instead of the compositor frame chrome.tabs.captureVisibleTab may re-serve.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default png)' },
        quality: { type: 'number', description: 'JPEG quality 0-100 (default 90, ignored for PNG)' },
        fresh: { type: 'boolean', description: 'Force a fresh frame via CDP (live window surface) instead of captureVisibleTab, which can re-serve a stale composited frame across focus/nav changes. Use when a recent screenshot looked unchanged though the page changed.' },
      },
    },
  },
  {
    name: 'fast_key_press',
    description: 'Press a single key on the focused element of the active tab (DOM key events). Common keys: Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Backspace, Delete. Useful for submitting forms, dismissing modals, or navigating dropdowns. Returns `target` (the focused element), `url`/`urlChanged` and a fresh, settled post-key `snapshot` (like fast_click) so what the key did is in the same result; a key that navigates returns navigated:true. For shortcuts WITH modifiers (Ctrl+A, Cmd+C, Shift+Tab), use fast_key instead.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key name (e.g. "Enter", "Escape", "ArrowDown")' } },
      required: ['key'],
    },
  },
  {
    name: 'fast_scroll',
    description: 'Scroll the active tab. Auto-detects the right scroll container (handles nested scrollers like claude.ai chat, not just window); container detection is time-bounded and falls back to a plain window scroll on huge ad/tracker-heavy DOMs, so this always returns within ~1s and never hangs. Pass "to" (top|bottom|"50%") or "pixels" (delta, positive=down); with neither, it scrolls ONE visible screenful down (the scroller\'s view height minus a small overlap). Optional selector to target a specific scroller (an element that cannot scroll itself scrolls its nearest scrollable ancestor, kind:"selector-ancestor"). Returns `moved` (pixels it actually moved, negative=up) and `atEnd` (true = it reached the end in that direction, another scroll moves nothing), plus scrollTop/max. Returns include a fresh `snapshot` of the post-scroll viewport (opt out with noSnapshot:true).',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'Scroll inside the visible frame whose URL contains this (a frame\'s controls below its fold are listed offscreen:true in fast_snapshot {full:true}; fast_click / fast_fill / fast_select_option scroll them into view themselves).' },
        to: { type: 'string', description: 'top, bottom, or a percentage like "50%"' },
        pixels: { type: 'number', description: 'Pixels to scroll (positive=down, negative=up). Omit (with no "to") for one screenful down.' },
        selector: { type: 'string', description: 'Optional CSS selector for the scroll container. If omitted, auto-detects by walking up from viewport center, then falling back to the largest scrollable element.' },
        noSnapshot: { type: 'boolean', description: 'If true, skip the fresh post-scroll snapshot and return just the action outcome.' },
      },
    },
  },
  {
    name: 'fast_close',
    description: 'Close a Chrome tab by id (from fast_list) or by URL/title substring match.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        match: { type: 'string', description: 'URL or title substring' },
      },
    },
  },
  {
    name: 'fast_batch',
    description: 'Run several FastLink actions in ONE tool call — the default way to work a known sequence (a whole form: fills, selects, key presses, clicks, waits). EVERY step runs even when one misses; the result LEADS with a summary line ("5/6 steps ok; step 3 (fast_fill "Ocean") missed: …"). A step counts as ok ONLY when its own result is clean — no error, not verified:false, nothing missed/failed inside it (a fields fill that filled 0/2, a selections pick that did not take): such a step is ok:false and the summary says "step N (…) not verified: <reason>" and then per-step results: ok steps carry their verified state (fill `value`/`verified`, select `picked`, click `url`), a missed step carries its error + candidates/hint. Only the LAST step returns a page `snapshot` (one page state per round-trip). Conditional steps run inside the batch with no model turn: { ifFound: "<text>" | "<css selector>", then: [steps], else: [steps], waitMs? } — ifFound probes the page for up to waitMs (default 1000ms) and runs one branch. After a step that navigates, the batch waits for the new document before the next step.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Steps in order. Each is {name, args} (any fast_* tool except fast_batch/diagnostics) or a conditional {ifFound, then:[…], else:[…], waitMs?} where ifFound is page text or a CSS selector (starts with # . [ :).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' }, args: { type: 'object' },
              ifFound: { type: 'string', description: 'Text (substring) or CSS selector to probe; when present this step is a conditional and `then`/`else` run instead of name/args.' },
              then: { type: 'array', items: { type: 'object' } },
              else: { type: 'array', items: { type: 'object' } },
              waitMs: { type: 'number', description: 'How long ifFound may wait for the text/selector (default 1000).' },
            },
          },
        },
      },
      required: ['actions'],
    },
  },
  {
    name: 'fast_click_xy',
    description: 'Trusted click at a pixel via the CDP Input domain (a REAL mouse event, isTrusted:true) — unlike fast_click\'s injected JS, LWC/React widgets honor it and it can focus an iframe input with no DOM reach-in. Coordinates are TOP-LEVEL VIEWPORT CSS pixels — take them straight from fast_screenshot (its image pixels are these coordinates, one to one) or from snapshot/frameNotice boxes. x and y are validated as numbers — a missing/non-numeric coordinate returns an error instead of silently clicking (0,0). Playbook for stubborn React/iframe fields: read the field\'s rect via fast_evaluate (getBoundingClientRect, use its center x/y), fast_click_xy there to focus it (trusted), then fast_type to enter text. **Every click reports WHERE FOCUS LANDED**: `focused` {tag, type, label, editable} (+ the field\'s live `value` when it is editable), and a `hint` when nothing editable holds focus — which is exactly when the fast_type after it would be refused (the first click after an overlay/consent banner closes often lands before the page is listening). Read `focused` before typing instead of discovering it from the refusal.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Top-level viewport X in CSS pixels (left edge = 0).' },
        y: { type: 'number', description: 'Top-level viewport Y in CSS pixels (top edge = 0).' },
        button: { type: 'string', description: 'Mouse button: "left" (default), "right" (context menu), or "middle".' },
        clickCount: { type: 'number', description: 'Number of clicks: 1 (default), 2 for double-click (select word / open), 3 for triple.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'fast_type',
    description: 'Trusted typing into whatever element currently has focus, via CDP Input.insertText — React/LWC accept it because it\'s a real input event (unlike setting .value). Does NOT target a selector; it goes to the focused element, so focus first (e.g. fast_click_xy on the field\'s coordinates). Focus is followed from the top document into the frame that holds it, cross-origin iframes included, so a field inside a cross-origin frame is found, typed into and READ BACK like any other. ERRORS with {error:"fast_type: no editable element focused — …", code:"no_editable_focus"} if nothing editable has focus (so a mis-aimed focus click never silently types into the void). EVERY return says whether the value was READ BACK — never silence: verified:true with typedInto:{tag,type,label,value,frames?} when the focused field now holds the text, or verified:false with a machine-readable reason ("unreadable: …", or what the field reads instead). Pass clear:true to REPLACE a pre-filled value instead of appending to it (select-all + delete the focused field first — use this when a field has a default like "API key 4"); it works inside cross-origin iframes and is REFUSED (code clear_without_editable_focus, nothing typed) unless an editable field is verifiably focused, because a select-all with the document focused selects the WHOLE PAGE. Pass force:true (alias allowIframe) to say "a coordinate click just focused this field": nothing is typed unless the focused field is the element under the pointer (code focus_not_on_clicked_target — the click landed on something that takes no focus, e.g. a dropdown, and focus stayed on an earlier field); where focus is in a frame the extension cannot inject into, it types anyway, unverified (verified:false) — confirm that value some other way before reporting it as set.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to insert into the currently-focused element.' },
        clear: { type: 'boolean', description: 'If true, select-all + delete the focused field first so the value is REPLACED, not appended (default false). Works inside cross-origin iframes. Refused (nothing typed) unless an editable field is verifiably focused.' },
        force: { type: 'boolean', description: 'A coordinate click (fast_click_xy) just focused this field. Nothing is typed unless the focused field is the element under the pointer (code focus_not_on_clicked_target); where focus is in a frame the extension cannot inject into, types anyway, unverified. Alias: allowIframe.' },
      },
      required: ['text'],
    },
  },
];
