# FastLink CHANGELOG

Running log of every deliberate change to FastLink, newest first. The point is to
**stop the fix→break→refix churn**: before touching something, skim this file to see
what a prior change already fixed, so we don't reintroduce a bug we already solved.

**Format for each entry**

```
## 2026-09-15 — runner local transport pins its profile; bench passes the observed install to it
- **What:** `fast-runner/fastlink-client.mjs` local branch calls `fast_profile {install: browser}` right after connect and throws if the pin errors; `bench/run.js` passes `install` as the runner's `browser` for local cells.
- **Why:** since 8498cbe the broker refuses unpinned calls when >1 profile is connected. The runner's local session never pinned, so on the owner's machine (primary + secondary connected) the multipage cell died in 3.6s on 3 consecutive "has not pinned one" errors. hvm has one slot, so its local runs never showed it.
- **Files:** `fast-runner/fastlink-client.mjs`, `bench/run.js`.
- **Watch out:** `--local` without `--browser` still works only when exactly one profile is connected; that is the broker's rule, not the runner's.
- **Status:** in code; verified by the multipage cell below.

## 2026-09-15 — status hint: delete the pre-pin-required fallback branch
- **What:** `statusReport` (fast-dxt/server/handlers.js) keeps only the `pinRequired` hint; the "calls default to <routedInstall>" branch and its `connectedSlots` recomputation are deleted.
- **Why:** that branch only fired against a broker older than 8498cbe. Both live brokers (WSL, hvm) now run pin-required code, so it was a dormant second source of truth that told the model calls would silently route.
- **Files:** `fast-dxt/server/handlers.js`.
- **Watch out:** an MCP server paired with a pre-8498cbe broker now shows no multi-profile hint at all; restart that broker.
- **Status:** in code / tests pass; takes effect when each MCP server restarts.

## YYYY-MM-DD — <short title>
- **What:** the change, in one or two lines.
- **Why:** the symptom / feedback that prompted it.
- **Files:** the files touched.
- **Watch out:** what this could regress / interacts with (so a future change doesn't undo it).
- **Status:** in code / synced to Windows copy / committed / verified live.
```

Extension changes only take effect after **commit + `bash scripts/ship-ext.sh`** (syncs HEAD's `fast-ext/` → `C:\Users\yjtur\FastLink\extension\`, stamps `build.json`, reloads the pinned profile via the broker, verifies the build in `fast_status`). Server changes need a Claude Code restart (WSL MCP) or `.mcpb` rebuild (Desktop). Relay changes need `wrangler deploy`.

---

## 2026-09-15 — fast-runner gate: a result claiming an action no call performed is refused once (`claimMismatch`)
- **What:** `claimMismatch(toolLog, result)` (runner.mjs) parses only the model's OWN `result`:
  verbs opened|navigated|drilled|went to → needs a fast_click/click_xy/do or a fast_tab/fast_nav
  beyond the first page load; clicked|added|checked → a click; selected|picked →
  fast_select_option / a click / fast_fill (custom dropdowns are picked by clicking, a native
  select can be filled); filled|entered|typed → fast_fill (incl. a `fast_fill_form` batch step)
  / fast_type / fast_fill_vision / fast_do; submitted → a click or `fast_key_press Enter`.
  fast_batch steps (incl. ifFound then/else) count. Not claims: a verb with not/no/never/
  nothing/none/neither/without/n't in the 3 words before it ("Search NOT clicked", "form not
  submitted"), and "opened a (new) tab" when a page load happened. Refused ONCE: `your result
  says "<verb>" but no <family> call succeeded in this run; do it now, or rewrite result to say
  what you actually observed`; the refusal records `claimMismatch`, the next report_done passes
  and the row / `grok_status` carry `claimMismatch:[{verb,family}]`. System prompt: one sentence.
- **Why:** cfworkers over relay 19:28:48Z (fbc16cf2, grok-4.3): fast_tab → fast_wait →
  fast_snapshot, never clicked, result `Worker "fastlink-relay" opened; …` → bench 2/5 with
  claimedComplete; the gate passed it (no failed call, evidence quoted the current URL).
- **Files:** `fast-runner/runner.mjs`, `fast-runner/test/gate.test.mjs`.
- **Watch out:** replayed over every `done` row (hvm 106 + WSL 55 → 154): 1 refusal, fbc16cf2
  only. Word-level: a result that narrates a state ("checkbox: checked") needs a click in the
  run — every such run had one.
- **Status:** committed; `node --test test/*.test.mjs`.

## 2026-09-15 — fast_fill autocomplete follow-up: typing key events after the write; path-only "URL moved"
- **What:** after writing an autocomplete (`isAutocomplete`), fast_fill dispatches the last
  character's keydown/keyup (Backspace for a cleared field) before polling for the popup;
  `INDEX.acPending` compares origin+pathname, not the full URL.
- **Why:** hvm probe on 7f20f26: the W3C APG combobox filters on `keyup`, so `fast_fill "Ala"`
  verified but opened nothing (no suggestions, fast_click "Alabama" missed); Google's search page
  `replaceState`s `?zx=…` after a write, which "settled" the pending record and hid the
  fast_wait hint.
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** synthetic key events insert no text; a handler that acts on a bare printable
  keydown would see one extra key.
- **Status:** committed; live proof on hvm below.

## 2026-09-15 — fast_fill reports an uncommitted autocomplete (`committed:false` + suggestions), per field; fast_wait timeout names it
- **What:** one autocomplete path in page.js: `isAutocomplete(el)` (typeable control with
  `role=combobox` on itself or its ARIA-1.1 wrapper, `aria-autocomplete` ≠ none,
  `aria-controls`/`aria-owns`, or `aria-haspopup`; a native `<input list=datalist>` is NOT one),
  `panelOptions(el)` (visible outermost option rows of the popup named by aria-controls/-owns on
  the control, its descendants or its combobox wrapper — shared by `openSuggestions` and
  `suggestionByText`), `openSuggestions(el)` → `{committed:false, suggestions:[≤5, icon-font
  glyphs stripped], hint:"autocomplete is open; pick a suggestion (fast_click its text) or
  fast_key_press Enter, then read back"}` on fast_fill / fast_key_press / fast_click alike.
  (1) **fast_fill** (single + `{fields}`): after writing an autocomplete it polls ≤1.2s for the
  popup (apps open it on a debounce/network round-trip) and captures it BEFORE the next field's
  write moves focus and closes it; each field result carries it, the multi head adds
  `uncommitted:[labels]` + the hint. `verified` stays about the value. (2) Per-page record
  `INDEX.acPending` (last ≤4 autocomplete writes: value + URL at write time); settled by a
  suggestion pick, an Enter/Tab that leaves no list open, a changed live value or a URL change.
  (3) **fast_wait** timeout (text + selector): when the focused / last-filled autocomplete still
  has its list open or its typed value was never accepted, the error carries
  `hint:"\"<field>\" has an open suggestion list|an uncommitted value; submit it (Enter or pick a
  suggestion) before waiting"` + `field` (+ `suggestions`). The bf55fda `suggestions`/hint shape
  (≤6, "a suggestion list is open…") is replaced by this one.
- **Why:** hvm mapsdir 9555f5ff / 3ceec99d (grok-4.3/phase2 on 53fdb0b): `fast_fill {fields:
  {origin, destination}}` returned verified:true for both in 29-228ms — before Maps' debounced
  grid appeared — so no suggestions were reported, the URL stayed /maps/dir///, and both waits
  timed out with `headings:["Delays"]` and no clue (10-25s lost).
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** a fill into an autocomplete whose list never opens now costs up to 1.2s (other
  fields: nothing). The pending record is heuristic (typed value unchanged + same URL): an exact
  typed value accepted by a click on the app's own Go button is still flagged — only on a
  fast_wait TIMEOUT. `commitSuggestion`'s "still open" check uses the same `openSuggestions`.
- **Status:** committed; live proof on hvm below.

## 2026-09-15 — bench scorer: literal `\n` in a report compares as a newline (SCORER CHANGE)
- **What:** `bench/score.js` `reportContains` (every `live` checkpoint) and `runLiveList` read a
  literal `\n` / `\r\n` / `\r` as a newline on both sides before `norm()` folds whitespace.
  `reportContains` is exported; `fast-runner/test/score-report.test.mjs` (new).
- **Why:** staticform run fdc1ed25 (grok-4.3/phase2, 11/12): the model reported the textarea as
  `Multi-line\ntext here` (copied JSON-escaped from the tool result) and "reported the live
  textarea value" failed against the real newline.
- **Files:** `bench/score.js`, `fast-runner/test/score-report.test.mjs`.
- **Watch out:** comparability: only runs that failed a text checkpoint through an escaped
  newline score differently from earlier runs; everything else is unchanged.
- **Status:** committed; unit test.

## 2026-09-15 — fast-runner gate: a failed read/wait is resolved by a later action + read
- **What:** `unresolvedFailures` (runner.mjs): a failed READ/WAIT call (`fast_wait` or any
  `READ_TOOLS` tool — fast_snapshot, fast_text, …) is resolved by a later successful
  state-changing call followed by a successful read. A failed ACTION (click/fill/select/key/
  batch) still needs a retry on the same target (or another tool on it). New case in
  `test/gate.test.mjs`.
- **Why:** mapsdir run 9555f5ff was refused for `fast_wait "min" failed and was never retried`
  although the model had since pressed Enter and read the routes page (3ceec99d the same for
  `"route options"`).
- **Files:** `fast-runner/runner.mjs`, `fast-runner/test/gate.test.mjs`.
- **Watch out:** a failed read that was followed by ANY action + read counts as resolved even if
  the action was unrelated — the evidence/URL checks still guard the report itself.
- **Status:** committed; `node --test test/*.test.mjs`.

## 2026-09-15 — toolset test: 45 server tools (fast_ext_reload), asserted absent from phase2 / no-cdp
- **What:** `fast-runner/test/toolset.test.mjs` `TOOLS.length` 44 → 45 plus: `fast_ext_reload`
  is on the server (default `"*"` toolset exposes it) and is NOT in the phase2 or no-cdp tool
  lists (phase2-eval inherits phase2's allow list, already asserted equal + `fast_evaluate`).
- **Why:** the new INTERNAL ops tool broke the hard-coded count; the Grok toolsets must never
  offer it.
- **Files:** `fast-runner/test/toolset.test.mjs`.
- **Status:** committed; `node --test test/toolset.test.mjs` 7/7.

## 2026-09-15 — Passive URL trail: extension records tab URL changes, `fast_list` returns `trail`, bench polls 3s instead of 500ms
- **What:** new `fast-ext/src/actions/trail.js`: `chrome.tabs.onUpdated` URL changes are
  stamped `{t,url}` into a per-tab ring (≤50, deduped when unchanged, dropped on `onRemoved`,
  persisted in `chrome.storage.session` so a service-worker restart keeps it); `installTrail()`
  runs at `background.js` top level. `listTabs` (tab.js) adds `trail:[{t,url}]` to every tab
  that has one. `bench/monitor.js`: `mergeTrail(list, events, seen)` (pure) reconstructs the
  stops from the timestamps; `TrailWatcher` keeps a `(tabId,t,url)` seen-set, the first poll is
  the baseline, `.trail` is the ordered URL list `score.js` already consumes; a tab without a
  recorded change contributes its current URL. `DEFAULTS.trailPollMs` 500 → 3000. Tool
  description updated in `fast-dxt/server/tools.js` + `fastlink-relay/tools.js`.
- **Why:** the 500ms poll (entry "bench trail poll 3s → 0.5s") put a `fast_list` through the
  same service worker every half second while GCP was storming — the "Listing tabs" flood in
  the panel during the gcpform recording — and a sampled trail still could not prove a stop
  shorter than the poll. Timestamps make the 3s poll lossless.
- **Files:** `fast-ext/src/actions/trail.js` (new), `fast-ext/src/actions/tab.js`,
  `fast-ext/background.js`, `bench/monitor.js`, `fast-dxt/server/tools.js`,
  `fastlink-relay/tools.js`, `fast-runner/test/trail.test.mjs` (new).
- **Watch out:** STUCK / NO_ACTIVITY / FINISHED still come from the tool trace, not the trail.
  Entries are stamped with the browser's clock. Trails start when the service worker installs
  the listener — tabs opened before that show only later changes.
- **Status:** committed; unit tests (ring + reconstruction of a 2s stop between 3s polls).
  Live multipage bench cell pending the extension reload (the lead ships the Windows copy).

## 2026-09-15 — fast_select_option: generic ARIA open chain (click → ArrowDown → Enter, observer-waited), control-only field lookup, readback-confirmed pick, `timing`
- **What:** page.js `fast_select_option` generic branch, ARIA contract only (no framework
  selectors): (1) `findField` label/aria/placeholder passes consider only VISIBLE control-like
  elements (`select/input/textarea/[role=combobox|listbox|textbox|searchbox]/[aria-haspopup]/
  contenteditable`) first, then aria-labelled custom widgets, never a landmark/container role —
  one composed-tree walk instead of three. (2) Trigger = the field when it is the
  combobox/popup button, else its first such descendant. When no panel is open (visible options
  in the `aria-controls`/`aria-owns` panel or an overlay, or index options while the trigger
  says `aria-expanded=true`) the chain is: pointer/mouse/click sequence on the trigger →
  `ArrowDown` → `Enter` (skipped on text inputs and on a trigger already claiming expanded),
  each followed by `waitForPanel` — a MutationObserver on the document (attribute filter
  aria-expanded/-controls/-owns/hidden/style/class, ≥30ms between probes) plus a 100ms
  fallback tick for shadow-root panels, wall-clock capped (1500 / 600 / 600ms). Result carries
  `opened:"already"|"click"|"ArrowDown"|"Enter"`; when nothing opened the call returns at once
  with `opened:false`, `triedOpen:[…]` and a hint — no 3s option poll. (3) Options are
  visible-only (a closed APG listbox keeps `display:none` options in the DOM). (4) `withReadback`
  polls the control's read-back every 30ms and returns the moment it shows the pick (cap 1s)
  instead of a fixed DOM-quiet wait; a verified pick's auto-snapshot settles 150ms, not 1s
  (`withSnap(result, pre, {settleMs})`). (5) Every result carries
  `timing:{resolveMs, openMs, pickMs, readbackMs, snapshotMs}` (performance.now marks).
- **Why:** gcpform cell on grok-4.3 (18:51Z): `fast_select_option "Application type"` took 8.8s
  and failed "no listbox detected" — `findField` had matched GCP's hidden "Skip links"
  `[aria-label]` div (its containerLabel held the text), so the click opened nothing and the
  panel search ran the full budget under the render storm; after a plain `fast_click` opened
  the real `cfc-select`, the retry took 6.7s (settle 1s + snapshot settle 1s + storm) and read
  back the wrong element. Owner rule: works on every site, nothing keyed to GCP/Material.
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** the react-select branch keeps its own mousedown open path (+250/400ms fixed
  waits); `Enter` is deliberately not sent to a trigger that already reports expanded (it would
  commit the highlighted entry of a list we cannot see). `mat-option`/`cfc-option` tags left the
  option selector — both carry `role=option`. Timings below are in-page; the bridge/broker add
  their own.
- **Status:** committed; `fast-runner` tests pass; verified live (hot-loaded page.js) on
  w3.org APG select-only combobox (opened:click, resolve 2 / open 1 / pick 0 / readback 0 /
  snapshot 154 ms, verified), ng-matero.github.io Angular Material `mat-select` (Pokemon,
  Colors: open 3–17 / readback 30 / snapshot 141 ms, verified), react-select.com "Single"
  (open 683 / readback 0, verified), native selects on selenium.dev web-form and the Bootstrap
  checkout example (≈0 ms), and the `opened:false` path on a text input (2.2s, nothing changed).
  material.angular.dev itself could not be hot-loaded (CSP `default-src 'self'` blocks fetch +
  eval) — the lead's post-reload GCP re-run covers `cfc-select`.

## 2026-09-15 — fast_fill REFUSES a label that matches several fields (candidates + section/index hint) instead of writing the first
- **What:** `fast_fill` (single and `{fields}`; page.js `resolveAll`): when a match resolves to
  >1 fillable element and neither `section`/`near` nor `index` picks one, the field is NOT
  written: `{error:"2 visible fields match \"URIs 1\" — nothing was filled", candidates:[{label,
  section, value, empty, index, offscreen?}], hint:"pass section:\"…\" | \"…\" or index:N"}`.
  In `{fields}` mode the other fields still fill and the refused one lands in `missed`/`fields`
  with the same shape. `section` per candidate = the deepest outline title the other candidates
  do not all share (module-scope `outlineTitles` + `distinguishingSections`, pure, unit-tested):
  GCP's two "URIs 1" rows both sit under an `<h3>Item 1</h3>`, so the `<h2>` above each is
  named — and that name is exactly what `section:` resolves. A top-level `index` is now the
  default for every `{fields}` entry (the bench run passed `{fields:{"URIs 1":…}, index:1}` and
  it was ignored). An ambiguous match is final (no 1.5s "still mounting" retry).
- **Why:** gcpform cell on grok-4.3 (runs.jsonl 18:51:03Z, frames 11/12): after two "Add URI"
  clicks `fast_fill {fields:{"URIs 1": ".../callback"}}` silently matched the first "URIs 1"
  (Authorized JavaScript origins), overwrote the origin with the callback URL ("Invalid Origin")
  and reported `verified:true`. Same class as the 2026-08-06 `section:` bug: a silent wrong-field
  write is worse than an error.
- **Files:** `fast-ext/src/actions/page.js`, `fast-runner/test/fill-ambiguity.test.mjs` (new).
- **Watch out:** a loose substring that hits several fields ("name" → First name / Last name /
  Name on card) now refuses too — the candidates list carries the exact labels to retry with.
  Structural only: N matches + the outline resolver; no site-specific selectors.
- **Status:** committed; unit test (synthetic GCP-shaped outline); verified live via a hot-loaded
  page.js on a local two-heading page (refusal → `section:` and `index:` each wrote the right
  input) and on getbootstrap.com/docs/5.3/examples/checkout ("name" → 4 candidates with
  sections Billing address / Payment; "Email" still fills).

## 2026-09-15 — No-click extension ship: `scripts/ship-ext.sh` (sync → build stamp → `fast_ext_reload` → build check)
- **What:** `scripts/ship-ext.sh` ships git HEAD, not the working tree (other sessions keep WIP
  in `fast-ext/`; commit to ship): `git archive HEAD fast-ext` → temp stage, stamps
  `build.json` `{sha, syncedAt}` (HEAD short sha) into the stage and the repo tree (gitignored),
  rsyncs the stage to the Windows copy (`--delete`), then through a stdio MCP server (`fast-runner/fastlink-client.mjs`, local
  transport) pins `fast_profile {install:$SLOT}` (default `primary`), calls `fast_ext_reload`,
  and polls `fast_status` until `installs.$SLOT.build == sha` (≤30s) → `PASS`/`FAIL` (exit 1).
- **Why:** shipping a build into the owner's real Chrome required them to open
  `chrome://extensions` and click Reload; nothing broker-reachable existed (entry below).
- **Files:** `scripts/ship-ext.sh` (new), `.gitignore`, `CLAUDE.md` (untracked), `CHANGELOG.md`
  header, `docs/GROK_RUNNER_PLAN.md` (pick-up line replaced).
- **Watch out:** the running broker must be on the ext-reload build — an older broker forwards
  `fast_ext_reload` to the extension as a page action and the script prints a restart hint.
  Never point `SLOT` at the relay-connected `secondary` profile (another session's).
- **Status:** committed. Live run against the owner's Chrome: FAIL as expected — the running
  primary worker is the pre-change build (hello has no `build`, no `{type:'reload'}` handler),
  so `fast_ext_reload` → `reloaded:false` after 20s. **Needs ONE manual Reload at
  chrome://extensions (bootstrap)**; every ship after that is no-click. The extension refuses
  its own `chrome-extension://` pages (`Restricted URL`), so the popup's Reload button is not
  broker-clickable either.

## 2026-09-15 — Broker `ext-reload` + `fast_ext_reload` (INTERNAL): reload the pinned profile's extension and wait for its hello
- **What:** MCP call `{type:'call', action:'fast_ext_reload', install}` is handled by the broker
  itself (`mcpBridge.js` → `router.js dispatchReload`): refused unless the envelope pins ONE
  label (unpinned / `"auto"` → `error`), else sends `{type:'reload'}` on that slot's socket,
  marks it `__closeReason='reload requested (fast_ext_reload)'`, and `state.awaitHello(label,
  20s)` answers `{result:{reloaded:true, install, build, previousBuild, ms}}` on the next hello
  from the same label or `{result:{reloaded:false, reason, previousBuild, ms}}` on timeout.
  Tool `fast_ext_reload` in `fast-dxt/server/tools.js` (no handler change — the generic
  `callExtension` path carries it). Log lines: `ext-reload install= sent`, `… back in <ms>
  build=`, `… no hello within`.
- **Why:** the only reload paths were the toolbar click, the options-page relay-reconnect
  message and updateCheck's 6h GitHub-release check (housekeeping entry below).
- **Files:** `fast-dxt/broker/router.js`, `mcpBridge.js`, `state.js`, `fast-dxt/server/tools.js`,
  `fast-dxt/test/broker.test.mjs`.
- **Watch out:** local broker only — NOT added to `fastlink-relay/tools.js` (the mirror already
  differs at `fast_upload`, deliberately relay-worded, so the byte-identical condition did not
  hold; the relay never lists a tool it would refuse). Hidden from the Grok toolsets
  (`toolset.phase2`/`no-cdp` allow lists); `toolset.json`'s `"*"` still exposes it. Takes
  effect after a broker restart + MCP restart.
- **Status:** committed; unit + throwaway-broker tests (`npm test` in `fast-dxt/`). Live broker
  restarted onto it 19:05Z (log: `hello install="primary" … build=n/a`, `ext-reload
  install="primary" sent (build n/a)`, `… no hello within 20000ms` against the old worker).

## 2026-09-15 — Extension: build id in the hello (`installs.<label>.build`) + ONE `reloadSelf(reason)` in the service worker
- **What:** (1) `src/reloadSelf.js` — the single `chrome.runtime.reload()` path; appends
  `{at, reason}` (last 20) to `fastlinkSelfReloadLog` first. Callers: updateCheck
  (`'update'`), broker `{type:'reload'}` (`'broker'`, connection.js), toolbar-click fallback
  and relay-reconnect (background.js). updateCheck's circuit breaker now counts only
  `reason:'update'` entries (a dev shipping 3 builds in 10 min is not a loop); the 6h GitHub
  check itself is unchanged. (2) `connection.js` reads `build.json` `{sha}` once per worker
  (`fetch(chrome.runtime.getURL('build.json'))`; absent → `"dev"`) and sends
  `{type:'hello', installId, build}`. Broker `extBridge.js` sanitizes it (`[A-Za-z0-9._-]{1,40}`),
  logs `hello … build=<sha>` / `connect … build=<sha>`, `state.js` keeps it per slot →
  `snapshot().installs.<label>.build` → `fast_status`.
- **Why:** verifying which build a profile runs needed the chrome://extensions page; the
  reload calls were scattered and the breaker log held bare timestamps.
- **Files:** `fast-ext/src/reloadSelf.js` (new), `src/updateCheck.js`, `src/connection.js`,
  `background.js`, `fast-dxt/broker/extBridge.js`, `state.js`, `fast-dxt/test/broker.test.mjs`.
- **Watch out:** `background.js handleSelfReloadResult` still wipes the whole
  `fastlinkSelfReloadLog` after a successful GitHub update (broker entries go with it —
  diagnostic only). popup.js / onboarding.js reload from page context and keep their direct
  `chrome.runtime.reload()`. The packaged zip (`fast-ext/scripts/package.sh` allowlist) carries
  no `build.json` → reports `"dev"`.
- **Status:** committed; broker side unit-tested; Windows copy synced to HEAD. Extension side
  unverified live until the one-time bootstrap Reload (entry above).

## 2026-09-15 — fast-runner: evidence gate checks the current URL + unretried failures
- **What:** `runner.mjs` tracks `urlTrail` (distinct `url`s carried by tool results —
  fast_tab/nav/click/snapshot/wait or their auto-snapshot) and tags every corpus entry
  with the URL it was read on. `report_done` now also refuses when (2) the evidence
  quote comes from a result read on an earlier URL than the last-seen one, and (3) a
  failed call was never followed by a successful one of the same intent (same tool +
  `text`/`field`/`match` target, or another tool on that target) — refused once
  ("your last attempt to fast_click "x" failed and was never retried; retry it or
  explain in `result` why it is not needed"); the next `report_done` passes but the
  row records `unresolvedFailures:[{name,target,t}]`. Rows and `grok_status` carry
  `urlTrail`. System prompt: one added sentence about unretried failures. Tests moved
  to `test/gate.test.mjs` (5 tests, synthetic tool logs).
- **Why:** cfworkers runs ae2428fc / d5c9ab8e (grok-4.3, phase2): the click into the
  "fastlink-relay" Worker failed (`role:"a"`) and was never retried, yet `report_done`
  passed because the evidence quoted a fresh `fast_text` of the list page — bench
  scored 2/5 with `claimedComplete=true`.
- **Files:** `fast-runner/runner.mjs`, `fast-runner/README.md`, `fast-runner/test/gate.test.mjs`,
  `fast-runner/test/toolset.test.mjs`.
- **Watch out:** the failure check is intent-based, not task-based — a disabled
  `fast_evaluate` that the model correctly abandoned also costs one refusal (then is
  flagged, not blocked). Corpus entries are now `{text,url}` objects. A URL only enters
  the trail from a result's top-level `url` or `snapshot.url`; `fast_text` carries none
  and inherits the last-seen URL.
- **Status:** in code / tests pass / committed.

## 2026-09-15 — Broker: ext listeners bind 0.0.0.0 only under WSL (loopback elsewhere), `FASTLINK_BROKER_BIND` override
- **What:** `broker/config.js` `resolveExtBind(env, procVersion)` → `FASTLINK_BROKER_BIND`
  if set, else `0.0.0.0` when `/proc/version` mentions microsoft/WSL, else `127.0.0.1`;
  `extBridge.js` binds `EXT_BIND.host` and logs `ext listeners bind <host> — <reason>`
  at startup (mcp port 9870 was already loopback).
- **Why:** 0.0.0.0 is needed only on WSL (Windows Chrome dials the VM IP when
  localhost-forwarding breaks); on the hvm rig / a container it exposed an
  unauthenticated browser bridge to the LAN — frontdesk found hvm's broker on
  0.0.0.0:9876/9877.
- **Files:** `fast-dxt/broker/config.js`, `extBridge.js`, `fast-dxt/test/broker.test.mjs`.
- **Watch out:** a non-WSL host that genuinely needs remote extension access must set
  `FASTLINK_BROKER_BIND=0.0.0.0` explicitly. Needs a broker restart on hvm after its
  bench run (WSL broker pid 38706 is on the prior commits and stays 0.0.0.0 anyway).
- **Status:** committed; unit test for the resolver + throwaway broker checked with `ss`.

## 2026-09-15 — `fast_profile` description: pin required on the local broker when >1 profile is connected
- **What:** one sentence added to `fast_profile` in `fast-dxt/server/tools.js` and the
  `fastlink-relay/tools.js` mirror (kept byte-identical): with more than one local
  profile connected, every tool except fast_status/fast_profile errors until the
  connection pins a label or "auto"; "auto" = most recent browser (relay) / active
  slot (local).
- **Why:** the broker now refuses unpinned calls in that state (entry below); the
  description said calls "go to the most recently connected browser".
- **Files:** `fast-dxt/server/tools.js`, `fastlink-relay/tools.js`.
- **Watch out:** relay routing unchanged; wording only. Needs `wrangler deploy` for
  the relay and an MCP restart / `.mcpb` rebuild locally.
- **Status:** committed (7219ab7).

## 2026-09-15 — Broker: an unpinned MCP session is REFUSED while >1 profile is connected (no more silent landing on the owner's main profile)
- **What:** `broker/router.js` `resolveSocket`: envelope `install` = label → that slot
  only (unchanged, BUG-5); `"auto"` → ACTIVE-then-any-connected (only when a session
  EXPLICITLY pinned "auto"); absent → one slot connected: use it; >1 connected:
  `{error:"2 Chrome profiles are connected (primary, work) and this session has not
  pinned one — call fast_profile {install:"<label>"} first (or install:"auto" …)",
  connectedInstalls, installs}` — mirrors the pinned-but-offline error.
  `server/brokerClient.js` now sends `install:"auto"` only after an explicit
  `fast_profile "auto"` (`explicitAuto`); a fresh session sends no `install`.
  `state.snapshot()` adds `connectedInstalls:[…]` + `pinRequired:boolean`
  (`routedInstall` still names the "auto" target). `fast_status` / `fast_profile`
  never go through the router, so they stay callable unpinned.
- **Why:** today a second session's first calls landed on the owner's main profile
  before it called fast_profile — `getExtensionSocket()` picked ACTIVE for any
  unpinned call.
- **Files:** `fast-dxt/broker/router.js`, `state.js`, `fast-dxt/server/brokerClient.js`,
  `fast-dxt/test/broker.test.mjs` (new), `docs/BUG-5-multi-install-routing.md`.
- **Watch out:** takes effect only after the running broker AND the MCP server restart
  (an OLD broker answers `install:"auto"` with "Unknown install"; a NEW broker with an
  old server still refuses unpinned sessions correctly). `handlers.js` `statusReport`
  hint still says "calls default to <routedInstall>" when >1 slot is connected — it
  should say calls are refused until `fast_profile`. Single-profile setups see no change.
- **Status:** committed (8498cbe); `npm test` in `fast-dxt/` (router unit test +
  throwaway broker on 19870/19876/19877).

## 2026-09-15 — Broker: durable log file + per-slot connection history (`recent[]`) in `fast_status`
- **What:** (1) `broker/lifecycle.js` `log()` appends every line to
  `os.tmpdir()/fastlink-broker.log` (`/tmp/fastlink-broker.log` under WSL; ISO
  timestamp per line; truncated when it passes 5 MB) and echoes to stderr only on a
  TTY; `server/brokerClient.js` spawns the broker with stdout/stderr on that same
  file (was `stdio:'ignore'`) so crash stacks land there too. `extBridge.js` logs
  `hello install= raw=`, `connect install= reason=` (hello / no-hello-default /
  replaced stale socket), `slotBusy install=`, `disconnect install= reason=`
  (close code+text, `heartbeat timeout`, `replaced by respawn`, `slotBusy`).
  (2) `broker/state.js` keeps per slot the last 20
  `{t:ISO, event:'connect'|'disconnect'|'slotBusy', reason}` (newest first) and
  `snapshot()` exposes it as `installs.<label>.recent` — what `fast_status` returns.
  (3) New `broker/config.js` owns the ports + pid/log paths: `FASTLINK_BROKER_PORT`
  (mcp, same var the server reads) and `FASTLINK_EXT_PORTS="9876,9877"` give a
  throwaway broker for tests — a non-default mcp port suffixes the pid/log files
  (`fastlink-broker-<port>.*`) and skips the cloudflared tunnel. `EXT_PORTS` moved
  out of state.js.
- **Why:** today's investigation could not date 7 reconnects — the broker had no
  record (stderr of a detached `stdio:'ignore'` child), and lifetime
  `totalConnections=7` was misread as "7 in ten minutes".
- **Files:** `fast-dxt/broker/config.js` (new), `lifecycle.js`, `state.js`,
  `extBridge.js`, `heartbeat.js`, `mcpBridge.js`, `tunnel.js`,
  `fast-dxt/server/brokerClient.js`, `fast-dxt/package.json` (`npm test`).
- **Watch out:** the RUNNING broker (pid from `pgrep -af broker/index.js`) keeps the
  old code until restarted — restart only when no bench cell is running and both
  profiles' sessions are idle. The log is shared by every broker instance on the
  machine (one file, append); a foreground run still prints to the terminal.
- **Status:** committed (e0ee7eb); `fast-dxt/test/broker.test.mjs` proves log lines
  + `recent[]`.

## 2026-09-15 — Suggestion picks are verified (keyboard first, coords for fast_click_xy on refusal); synthetic keys carry keyCode; fast_wait keeps its own deadline
- **What:** (1) `commitSuggestion` (page.js): ArrowDown×(index+1) + Enter on the input,
  then pointer/mouse events on the entry; `committed` = value/URL changed or the list
  closed. A pick the control ignores is now an ERROR carrying `suggestion:{text,x,y,w,h}`
  + hint "fast_click_xy at x,y (trusted click) commits it" — never a false `clicked`.
  (2) `keyInit` adds legacy `keyCode`/`which` to every synthetic KeyboardEvent
  (`fast_key_press` + the suggestion commit): Google's widgets switch on keyCode, so an
  ArrowDown without it was a no-op. (3) `runBridge` (index.js): the 20s page-action
  deadline is `max(20s, timeoutMs+3s)` capped at 28s for `fast_wait` — a 30s wait was
  cut at 20s with "page busy".
- **Why:** batch-build iteration 4 (57/59, mapsdir 5/6 in 19 calls / 94s): the mouse-
  event suggestion pick returned `clicked` while Maps ignored it, and two waits hit the
  new deadline.
- **Files:** `fast-ext/src/actions/page.js`, `fast-ext/src/actions/index.js`.
- **Status:** committed; verified on the hvm rig after the 4.6 control pass (below).

## 2026-09-15 — fast_click reaches open suggestion-list entries; fast_status says when a pin is required
- **What:** `fast_click` whose text matches no index entry looks in the OPEN suggestion
  list of the focused control (`aria-controls`/`aria-owns` panel: `[role=option|row|
  menuitem|treeitem]`, visible, exact > startsWith > substring) and commits it with a
  mousedown/mouseup/click sequence — result `clicked:{tag,role,text}, fromSuggestions:true,
  url, urlChanged, focused` + snapshot. `statusReport` (handlers.js): with the broker's
  `pinRequired:true` the hint reads "Multiple Chrome profiles connected (a, b); calls are
  refused until this session pins one with fast_profile {install:\"<label>\"|\"auto\"}"
  (uses `connectedInstalls`).
- **Why:** batch-build iteration 3 (56/59): mapsdir 4/6 — the new `suggestions` hint
  named "Times Square New York, Manhattan, NY", but Maps' rows are `role=row` divs in a
  `role=grid`, not index entries, so six clicks on that text missed (3 consecutive
  errors). Broker fixer's pin-required routing (8498cbe) needs the matching status line.
- **Files:** `fast-ext/src/actions/page.js`, `fast-dxt/server/handlers.js`.
- **Status:** committed; hvm iteration 4 below.

## 2026-09-15 — Open suggestion lists are reported (`suggestions` + hint) on fast_key_press / fast_fill; bench trail poll 3s → 0.5s
- **What:** `openSuggestions(el)` (page.js): when the active/written control names an
  open panel via `aria-controls`/`aria-owns` (Google Maps' `role=grid` of rows, ARIA
  listboxes, menus) the result carries `suggestions:[…≤6]` + `hint: "a suggestion list
  is open — the value is not committed until one entry is chosen: fast_click its text
  (or ArrowDown then Enter)"`. `fast_key_press` adds it for the focused element,
  `fast_fill` for the written field (per field in the `fields` form).
  `bench/monitor.js` `trailPollMs` 3000 → 500.
- **Why:** batch-build iteration 2 (57/59): mapsdir 5/6 — 4.3 pressed Enter in the
  destination box, Maps opened its suggestion grid instead of routing, and the model
  reported "route options" from the suggestions; multipage 5/6 was the 3s trail poller
  missing a ~2s stop on the Travel page (tools were right; the run is just faster now).
- **Files:** `fast-ext/src/actions/page.js`, `bench/monitor.js`.
- **Status:** committed; hvm iteration 3 below.

## 2026-09-15 — Select hints skip autocompletes; ARIA select resolves options via aria-controls under a wall clock; page-action deadline
- **What:** (1) `selectControlOf` (page.js) no longer treats a typeable input inside a
  `[role=combobox]` wrapper as a select control — Google Maps' search boxes carried
  `hint: use fast_select_option {field:"sb_ifc50"}` on a VERIFIED fill and 4.3 followed
  it into a dead end (batch-build iteration 1, mapsdir 4/6 → 3 consecutive errors);
  a successful `fast_fill` only hints when the written element is a react-select input.
  (2) `fast_select_option`'s generic ARIA branch resolves options synchronously on every
  look from the panel named by `aria-controls`/`aria-owns` (on the field, its inner
  combobox/input or a `[aria-haspopup]` child — mat-select / cfc-select set it), then the
  overlay sweep, then `INDEX.options`; the budget is WALL CLOCK checked after every wake
  (a starved 50ms timer on GCP's Angular storm used to run 10–30s past the 3s budget),
  and a miss reports `elapsedMs`, `panelIds`, `starved:true` + hint. `ariaPanelIds` is a
  pure module-scope helper unit-tested against a fake DOM (`fast-runner/test/aria-options.test.mjs`
  slices it out of page.js). (3) `runBridge` (index.js) races `executeScript` against a
  20s deadline and returns `{error:"page busy", phase, elapsedMs, hint}` — a stuck
  in-page script no longer outlives the 30s call timeout and queues the next call.
- **Files:** `fast-ext/src/actions/page.js`, `fast-ext/src/actions/index.js`,
  `fast-runner/test/aria-options.test.mjs` (new).
- **Watch out:** the deadline does not stop the in-page script; it only frees the caller.
  GCP `cfc-select` cannot be verified on hvm (no login) — owner's Chrome cell pending.
- **Status:** committed; unit tests pass; hvm iteration 2 below.

## 2026-09-15 — Batching is the default form path: `fast_batch` never aborts + `ifFound`, `fast_fill {fields}` absorbs `fast_fill_form`, `fillable:N` nudge, select-control hints, offscreen matching, `fast_wait` selector / emptyContainer / text+idle
- **What:**
  1. **`fast_batch`** (new shared `fast-dxt/server/batch.js`, mirrored byte-for-byte at
     `fastlink-relay/src/batch.js`; handlers.js + relay mcp.js only wire `call`/`gate`):
     every step runs (no abort, `continueOnError` gone); the result LEADS with
     `summary` ("5/6 steps ok; step 3 (fast_fill "Ocean") missed: …"), then per-step
     `{step,name,ok,result}` (verified state) or `{ok:false,error,candidates,hint…}`;
     only the LAST step keeps its `snapshot` (intermediate steps run `noSnapshot:true`
     unless they set it); conditional steps `{ifFound:"<text>|<css selector>",
     then:[…], else:[…], waitMs}` are decided in the batch with one `fast_wait` probe
     (a selector = string starting with `# . [ :` or containing `>`/`[`); steps naming
     `fast_fill_form` are rewritten to `fast_fill`. BUG-2 nav settle unchanged.
  2. **`fast_fill {fields:{label: value|{value,index,section,name,exact,append}}}`**
     replaces `fast_fill_form` (deleted from page.js, tools.js, relay mirror, manifest,
     toolsets, runner sets, ext UI maps; fill_vision's DOM fallback now calls
     `fast_fill {fields}` and reads `.fields`). Single and multi share one resolver
     (exact-first match, section scoping, index, 1.5s auto-wait for the whole set).
     Multi result: `{verified, filled, missed, summary?, fields:{label:{verified,value,…}},
     snapshot}`; misses carry `candidates` / `hiddenMatches` / `offscreenMatches` / hint.
  3. **Batching nudge in data:** `serializeSnapshot` counts EMPTY visible fillable
     fields (`fillable:N`, near the top of every snapshot / auto-snapshot) and when
     N ≥ 2 adds `hint: "N empty fillable fields visible; fill them in one fast_fill
     {fields:{label:value}} or one fast_batch"`. Descriptions (tools.js, phase2,
     phase2-eval, no-cdp, runner system prompt) say the same in one sentence.
  4. **Select-control hints:** `fast_click` / `fast_fill` whose target (or hidden
     match) is a native select, a react-select input/control/value chip/"Remove X"
     button, or an ARIA combobox return `hint` + `selectField` naming the field for
     `fast_select_option`; a click miss on a heading that titles a dropdown ("Single")
     says so too.
  5. **Offscreen matching:** click/fill match pools are built with `matchAll` (offscreen
     interactive entries kept, tagged `offscreen:true`, even when a heavy page forces
     viewport-only); the chosen target is `scrollIntoView`ed first
     (`scrolledIntoView:true`); index-out-of-range / miss reports list every match with
     `offscreen` + `section`. `fast_select_option` scrolls its field into view.
  6. **`fast_click` role aliases:** `role:"a"` = link, `"button"`/`"input"`/… match the
     tag; a role mismatch returns `available` with real role/tag + a hint.
  7. **`fast_wait`:** `selector` mode (first VISIBLE match); a content hit whose text is
     gone from the live DOM (stale index entry) or whose element has no visible box
     keeps polling and, at the deadline, returns `found` + `emptyContainer:true` + hint
     instead of a false "found"; `text`/`selector` + `networkIdle:true` resolves on the
     text and reports `networkIdle`/`pending` (index.js) — only a bare networkIdle wait
     times out (Cloudflare long-polls forever).
  8. **Calm verified results:** a `verified:true` fill / select drops the generic
     "page was still changing" `settling`/hint (GCP fills carried it on every call).
- **Why:** this morning's 4.3/phase2 hvm pass (57/59 · 98s · 60 calls): staticform =
  11 field-by-field calls, flightsearch 11 (the phase2-eval run did the same form in
  ONE 7-step batch → 4 calls), overlay 1/3 after 14 misses circling a react-select
  ("Ocean" → Remove chip, fill on react-select-8-input, click on heading "Single");
  afternoon gcpform 5/6 (second "Add URI" offscreen → "index 1 out of range" → redirect
  URI written into a JS-origins row), cfworkers overclaim after `role:"a"` refused the
  links it listed and a 10s networkIdle timeout.
- **Files:** `fast-dxt/server/batch.js` (new), `fastlink-relay/src/batch.js` (mirror),
  `fast-dxt/server/handlers.js`, `fastlink-relay/src/mcp.js`, `fast-dxt/server/tools.js`,
  `fastlink-relay/tools.js`, `fast-dxt/server/transports.js`, `fast-dxt/manifest.json`,
  `fast-ext/src/actions/page.js`, `fast-ext/src/actions/index.js`,
  `fast-ext/src/actions/waitIdle.js`, `fast-ext/background.js`, `fast-ext/sidepanel.js`,
  `fast-ext/src/overlay.js`, `fast-runner/runner.mjs`, `fast-runner/toolset.phase2.json`,
  `fast-runner/toolset.phase2-eval.json`, `fast-runner/toolset.no-cdp.json`,
  `fast-runner/test/toolset.test.mjs`, `fast-runner/test/batch.test.mjs` (new),
  `bench/suite.js`.
- **Watch out:** `fast_fill_form` no longer exists anywhere — a batch step naming it is
  rewritten, a direct call is an unknown action. Multi-fill results key on `fields`, not
  `results`. `fillable` counts EMPTY fields only (checkbox/radio/button/file excluded), so
  a filled form stops nudging. `matchAll` only affects the internal match pools; model-
  facing snapshots keep their viewport/cap rules. `selectControlOf` climbs ≤8 ancestors
  for a class token ending in `control` — never `container` (bootstrap page wrappers).
  Relay NOT deployed; Windows extension copy NOT synced.
- **Status:** committed; unit tests (`fast-runner`: 14 files incl. batch + aria-options);
  hvm bench `docs/GROK_RUNNER_BENCH_hvm_batch_2026-09-15.md` (rows since 18:16:53Z):
  4.3/phase2 iterations 1–4 = 57/59 (29c·57s), 57/59 (30c·45s), 56/59 (33c·67s),
  57/59 (42c·128s) vs this morning 57/59 · 98s · 60c; the remaining miss was always
  mapsdir (Maps ignored synthetic Enter/ArrowDown without keyCode) — pass 7 mapsdir-only
  on the keyCode build = 6/6 · 7c · 19s. Best full pass composed = 59/59 · ~36 calls ·
  ~65s. 4.6/phase2 control (pass 6) = 59/59 · 38c · 95s. Batch/fields usage per cell
  (4.3, iteration 2): staticform 1 batch (fill{fields}+select+2 clicks), flightsearch 1
  batch (fill{fields} of 5 + select), mapsdir fill{fields} of 2; multipage/overlay/extract
  need none.

## 2026-09-15 — `toolset.phase2-eval.json`: phase2 + read-only `fast_evaluate` (owner A/B)
- **What:** generated from `toolset.phase2.json` (test asserts it differs only by the
  added tool); evaluate described as read-only DOM queries, never cookies/storage,
  prefer fast_text for plain text. README lists the gate, the dated prompt and the
  toolsets.
- **Why:** the owner enabled evaluate on the relay account and wants to know whether it
  helps 4.3 once phase2 scores clean without it.
- **Files:** `fast-runner/toolset.phase2-eval.json`, `fast-runner/test/toolset.test.mjs`,
  `fast-runner/README.md`.
- **Watch out:** `no-cdp` never gets evaluate.
- **Status:** committed; A/B pass recorded in the hvm feedback doc.

## 2026-09-15 — hvm rig: clear the extension service-worker ScriptCache on Chrome launch; snapshot `hint` survives the spread
- **What:** `bench/hvm-rig.sh` removes `$RIG_PROFILE/Default/Service Worker/ScriptCache`
  before launching Chrome. `page.js` `markTruncated` always deletes the serializer's
  `hint:undefined` before spreading (it erased the truncation hint on explicit
  `fast_snapshot`).
- **Why:** two rig "restarts" after fast-forwarding the feedback build still ran the OLD
  background worker (`fast_key_press` returned `{keyDispatched,target:"INPUT#id"}`, the
  deleted `key.js` shape) while content scripts were current: Chrome serves an unpacked
  extension's SW script from the profile cache until the extension is reloaded. Clearing
  the cache dir fixed it on the spot.
- **Files:** `bench/hvm-rig.sh`, `fast-ext/src/actions/page.js`.
- **Watch out:** only the rig profile; the Windows copy still needs a manual reload at
  chrome://extensions after a sync.
- **Status:** committed; verified on hvm.

## 2026-09-15 — Extension: page results cross `executeScript` as a JSON string (Chrome sorts returned object keys)
- **What:** `index.js` `pageBridge` returns `JSON.stringify(result)` and `runBridge`
  parses it; `text.js` does the same for `fast_text`. `labelFor` strips a wrapping
  `<label>`'s own control text (every `<option>` of a `<select>`, an input's value).
- **Why:** the hvm smoke test of the feedback build came back with keys in
  ALPHABETICAL order (`{clicked, focused, index, snapshot, url…}`): Chrome marshals an
  object returned from `chrome.scripting.executeScript` through a `base::Value` dict,
  which sorts keys — so `verified` / `truncated` / `url` landed after `snapshot`, the
  opposite of "first field". A string crosses untouched; key order then survives
  JSON.parse → WebSocket → broker → server. `fast_select_option`'s `field.label` also
  read "Dropdown (select) Open this select menu One Two Three".
- **Files:** `fast-ext/src/actions/index.js`, `fast-ext/src/actions/text.js`,
  `fast-ext/src/actions/page.js`.
- **Watch out:** anything that returns an object from page.js must be JSON-serializable
  (it already had to be — executeScript serialized it before); `undefined` → `null`
  keeps the "injected script returned no value" error path.
- **Status:** committed; hvm rig.

## 2026-09-15 — phase2 toolset: drop `fast_evaluate`, miss/truncation/wait guidance, exact-quote `report_done`
- **What:** `fast-runner/toolset.phase2.json` is 12 FastLink tools + 2 native = 14:
  `fast_evaluate` is gone (was disabled on the runner's relay account; 11 of 32 bench
  cells burned a call on it). Descriptions now carry the tool-contract signals: "on a
  miss retry with a name from `candidates`", "truncated:true → full:true / limit:N",
  "fast_wait text is a substring — use ≥2 words", "index = N-th match, not a snapshot
  id", fast_key_press returns a snapshot, and `report_done` demands names/numbers/values
  quoted EXACTLY as the page shows them (the terse report made 4.3 write "US" and
  "1.429B", which the extract scorer cannot match) plus a verbatim evidence quote.
  `toolset.no-cdp.json` untouched (never had evaluate).
- **Why:** hvm pass 4 (grok-4.3 / phase2, 52/59): extract 19/22 from abbreviations,
  wasted evaluate calls, snapshot-id-as-index misses.
- **Files:** `fast-runner/toolset.phase2.json`, `fast-runner/test/toolset.test.mjs` (14
  tools, evaluate excluded, ≤2 sentences still enforced).
- **Watch out:** `toolset.json` (default baseline) is untouched; the phase-3 fold list in
  `docs/TOOL_TRIAGE_DRAFT.md` still lists evaluate as CORE — the owner has since enabled
  evaluate on the relay account; an A/B with it re-added is part of the feedback bench.
- **Status:** committed; benched on hvm (`docs/GROK_RUNNER_BENCH_hvm_feedback_2026-09-15.md`).

## 2026-09-15 — Runner: `report_done` evidence gate, dated system prompt, loud 80k cap
- **What:** `fast-runner/runner.mjs` — (1) **evidence gate** (every toolset; it is the
  caller-facing contract): `report_done` is refused unless a successful READ
  (fast_snapshot / fast_text / text-mode fast_wait / screenshot / evaluate…) came AFTER
  the run's last state-changing call (an action's own auto-snapshot is not a read-back),
  and unless `evidence` quotes a tool result of this run verbatim (a quoted fragment,
  any 3–6-word window, or a ≥6-char number, matched against the normalized full result
  texts). The refusal names what is missing ("no tool has read the page since your last
  fast_fill; call fast_snapshot or fast_text and cite it"); after 3 refusals the report
  is accepted and flagged `gateOverridden`. Refusals are logged per run
  (`gateRefusals[]` in `runs.jsonl` + the run snapshot). (2) The system prompt carries
  today's date + weekday in America/Chicago ("never guess the year") and the rule "a
  result that starts with truncated:true is partial — never report from it". (3) The
  80k result cap now PREFIXES `[truncated:true — N chars, first 80000 follow; narrow it]`
  instead of appending `[truncated]` at the end.
- **Why:** grok-4.3 overclaimed 4 of 8 cells (overlay / extract / mapsdir / cfworkers)
  by reporting without reading back; both models called fast_evaluate for today's date
  and 4.3 typed 2024.
- **Files:** `fast-runner/runner.mjs`, `fast-runner/test/toolset.test.mjs`
  (`gateProblems` unit-tested).
- **Watch out:** the date line changes the cached prefix once a day — expected. Gate
  cost = one extra read per run when the model stops one call short; watch
  `gateRefusals` in the bench doc.
- **Status:** committed; unit tests pass.

## 2026-09-15 — Extension: verified state on mutating tools, bounded auto-wait on misses, truncation-first, settled snapshots, `fast_key_press` in page.js
- **What:** `fast-ext/src/actions/page.js` (+ `index.js`, `text.js`; `key.js` deleted):
  1. **Verified state leads every mutating result.** `fast_fill` → `{ verified, value,
     filled… }` with the field's LIVE value after the page settled (`reason` when it
     did not hold; password masked). `fast_fill_form` verifies ALWAYS (the `verify` arg
     is gone): per-field `value` + `verified`, top-level `verified` + `reverted`.
     `fast_select_option` → `{ verified, picked, value, field, kind }` where `value` is
     what the control displays after the pick and `field` (label / aria / name / id /
     preceding heading) is the dropdown it actually acted on — the react-select.com
     "field:'Ocean' picked Forest in the wrong select" case is now visible. `fast_click`
     → `{ clicked, url, urlChanged, dialogOpened|dialogClosed, focused, … }` first.
  2. **Bounded auto-wait on targets.** `fast_fill`, `fast_select_option` (per field)
     and `fast_click` re-run the lookup every 150ms for up to 1.5s (`AUTO_WAIT_MS`)
     before returning a miss; the miss carries `waitedMs`, `settling` (page still
     mutating / resources still landing, from `pageActivity()`) and the fixer's
     `candidates` / `hiddenMatches` / `hint`. Nothing is clicked/filled on a miss.
  3. **Truncation first.** Any capped view now STARTS with `truncated:true`,
     `dropped:{items,content,offscreen,textTrimmed}` and a `hint` naming the exact
     call for the rest (`markTruncated`): explicit `fast_snapshot` (was a numeric
     `truncated` count + `contentTruncated`), the action auto-snapshot (count + byte
     cap), viewport-only snapshots (`dropped.offscreen` = visible interactive elements
     outside the viewport, counted in `serializeSnapshot`), and `fast_text` with
     `maxLen` (`dropped.chars`). `capAutoSnapshot` returns a NEW object — assign it.
  4. **Settled snapshots.** `withSnap` waits for the DOM to be quiet 150ms (≤1s,
     `SETTLE_MAX_MS`, `settleDom`) after the rAF before serializing; a page still
     mutating at the cap is flagged `settling:true` + hint at the top of the result.
     The observer stamps `INDEX.lastMutMs`; FastLink's own flash chip
     (`__fastlinkChip`) is neither activity nor indexed (it used to appear as a
     `{tag:"div",text:"fill"}` content block in every result).
  5. **`fast_key_press` runs in page.js** (PAGE_ACTIONS; `key.js` deleted): same DOM
     key events, now on the pinned target tab, returning `target`, `url`/`urlChanged`
     and a settled auto-snapshot — Enter on Google Maps used to return
     `{keyDispatched}` and nothing else, so the model reported route options it never
     saw. A navigating Enter returns `navigated:true` via the existing frame-teardown
     path.
  `fast-dxt/server/tools.js` + `fastlink-relay/tools.js` describe all of the above
  (mirrored; `fast_fill_form.verify` removed from the schema).
- **Why:** owner's thesis on the grok-4.3 bench (56/70 local, 52/59 hvm): "4.3 can do
  it, it needs more feedback". Each dropped checkpoint traced to a silent tool result:
  fill on a not-yet-rendered field, select_option on the wrong select, answering from a
  capped snapshot, fill 0.8s after a view change, Enter with no read-back.
- **Files:** `fast-ext/src/actions/page.js`, `fast-ext/src/actions/index.js`,
  `fast-ext/src/actions/text.js`, `fast-ext/src/actions/key.js` (deleted),
  `fast-dxt/server/tools.js`, `fastlink-relay/tools.js`.
- **Watch out:** every action result is ~150ms–1s later than before (settle) — cheaper
  than a model turn, but pages that never stop mutating (Maps) pay the full 1s and are
  flagged `settling`. A miss now costs up to 1.5s. Consumers of the old numeric
  `snapshot.truncated` / `contentTruncated` (none in-repo besides scout's own capping)
  must read `dropped`. `fast_fill_form` always spends ≤2.5s verifying.
- **Status:** committed; hvm rig loads the repo copy (bench below); Windows copy NOT
  synced by this change (other agent owns that sync).

## 2026-09-15 — Housekeeping: hvm bench branch merged, Windows extension copy synced (reload still manual)
- **What:** (1) hvm repo (`/home/dev/code/Fastlink`, commits `8eaff09…ba610e0`, bench passes
  1–4 on the rig) merged into WSL main as `fb94fd6` via a `hvm` git remote; both results
  docs kept (`docs/GROK_RUNNER_BENCH_2026-09-15.md` local, `…_hvm_2026-09-15.md` hvm);
  `bench/tool-usage.md` conflict resolved to the WSL render — it is generated per machine
  from the untracked `bench/tool-usage.jsonl`, the hvm histogram lives in the hvm doc.
  hvm main moved to the same commit by pushing a temp branch and `git reset` (mixed) +
  checkout of the 5 bench/doc files, so the rig's on-disk `fast-ext/` was never rewritten
  (its 3 rsynced files were byte-identical to WSL HEAD). (2) `fast-ext/` rsynced to
  `C:\Users\yjtur\FastLink\extension\` — differing files were `manifest.json` (0.4.3 →
  0.4.4), `src/actions/page.js`, `src/connection.js`; trees now identical. (3) No
  broker-reachable extension reload exists: `chrome.runtime.reload()` is only behind the
  toolbar click, the options-page `fastlink:relay-reconnect` message, and updateCheck's
  6h self-apply alarm, which needs a GitHub release newer than the running 0.4.3 (latest
  is `ext-v0.4.3`). Not hacked in; the one-line instruction is in
  `docs/GROK_RUNNER_PLAN.md` → Pick-up.
- **Verification:** `fast-runner/cli.mjs --local --toolset phase2` on selenium.dev web-form
  → 3 calls / 8.7s, `fast_select_option {field:"Dropdown (select)", option:"Two"}` →
  `picked:"Two", kind:"native-select"` — but that readback already existed in 0.4.3, so it
  does not discriminate builds. Discriminating probe: `fast_select_option` on a bogus field
  returned the bare `field … not found` (no `candidates`) → the user's Chrome is still
  running the OLD 0.4.3 code until it is reloaded.
- **Files:** `CHANGELOG.md`, `docs/GROK_RUNNER_PLAN.md`, `bench/tool-usage.md` (merge).
- **Status:** committed; WSL main == hvm main; Windows copy synced, NOT reloaded.

## 2026-09-15 — Grok runner latency study + terse `report_done` behind phase2
- **What:** `docs/GROK_LATENCY_2026-09-15.md`: 33-call synthetic matrix straight against
  api.x.ai (grok-4.6 / grok-4.3 × effort low / medium × 7k / 30k / 70k ctx × stream, plus
  sync and warm-cache controls) + per-turn evidence from the first instrumented live cells.
  Runner change: `toolset.describe` now also applies to the native `ask_caller` /
  `report_done`; `toolset.phase2.json` re-describes `report_done` as terse (≤3 sentences +
  one quote). Baseline toolset output is byte-identical (test asserts it).
- **Why:** the per-turn gap vs grok.com is **output tokens** on grok-4.6 (hidden reasoning +
  JSON at ~70 tok/s: 100 tok = 1.4s, the 877-token report_done turn = 12.7s), not context
  (warm-cache TTFT is 1.0s even at 72k tokens). `reasoning_effort` low ≈ medium; streaming
  and a smaller result cap gain nothing; grok-4.3 is 2–3× faster and flat with context.
- **Files:** `docs/GROK_LATENCY_2026-09-15.md`, `fast-runner/runner.mjs`,
  `fast-runner/toolset.phase2.json`, `fast-runner/test/toolset.test.mjs`.
- **Watch out:** recommended pass-3 order: phase2 on 4.6 first, then
  `FASTRUN_MODEL=grok-4.3 --toolset phase2` (env var already exists; judge score before wall).
  The report text is not what the bench scores, so the terse description cannot move scores.
- **Status:** committed; not yet benched.

## 2026-09-15 — Extension: one broker dial in flight (SW-start double dial); hvm launch delay root-caused (Chrome keyring wait, not FastLink)
- **What:** `fast-ext/src/connection.js` — `connect()` takes a synchronous `dialing`
  lock and delegates to `connectOnce()`. At service-worker start `startConnection()`
  and the `onInstalled`/`onStartup` `wake()` both call `connect()` within ~2ms; both
  passed the readyState guard on a still-null socket (the socket is created only
  AFTER `await hasAnyWindow()`), and the second's `recycle()` closed the first's
  brand-new socket — the SW console showed "WebSocket is closed before the connection
  is established" on every launch.
- **Why:** GLITCH hunt for the hvm rig's slow post-launch attach (~25s every Chrome
  start; a 90s case made `hvm-run.sh` skip pass 3 `multipage` as "rig down"). CDP
  attach to the SW showed the surviving dial "open after 24.8s", and a plain `fetch`
  to a local http server, a second WebSocket and a fetch to the broker port ALL
  released at that same instant — so it is Chrome's network service, not the
  extension or broker. `--no-proxy-server` changed nothing; `--password-store=basic`
  → "open after 19ms". The ≈25s is the D-Bus method-call timeout while os_crypt asks
  the session bus for a keyring on that headless box; the network service's cookie
  store waits on it. **Rig fix (not in this repo's code): add `--password-store=basic`
  to the Chrome flags in `bench/hvm-rig.sh`** (rig agent's file — handed over, not
  edited here). Also ruled out tonight: a SIGKILLed extension does NOT leave a busy
  slot — the kernel FIN reaches the broker in ~25ms ("primary disconnected"), so the
  slot-busy / 60s-cooldown path never ran.
- **Files:** `fast-ext/src/connection.js`.
- **Watch out:** the lock is per-call, released in `finally`; keep `connect()` the only
  public entry (alarm tick, window-created, wake and the slot-busy timer all go
  through it). It does NOT change backoff, fast-retry or recycle semantics — a
  CONNECTING socket older than `CONNECT_TIMEOUT_MS` is still recycled by
  `checkHealth()`.
- **Status:** committed; `node --check` clean; the double-dial itself was observed
  before the change on the isolated rig (two "dialing" lines 2ms apart, first one
  aborted) — the fixed file is rsynced to the hvm repo behind `bench/FIXER_READY` and
  not yet observed live there (the rig restarts on its own schedule). Windows copy
  NOT synced.

## 2026-09-15 — Auto-snapshot byte cap (≤ ~8k chars) on action results, `full` / `limit` pass-through
- **What:** the `snapshot` attached to every action result (fast_click / fast_fill /
  fast_wait / fast_select_option / fast_hover / … — everything through `withSnap`) is
  now capped by BYTES after the existing count caps: `byteCapSnapshot()` trims content
  block text to 100 chars, drops content blocks from the ranked tail, trims item
  text/innerText to 60 chars, then drops items from the tail (never below 8). Item ids
  (`i`) and geometry are never touched. When anything was dropped or trimmed (by count
  OR bytes) the snapshot carries `truncated:true`, `dropped:{items,content,textTrimmed}`
  and a `hint`. `full:true` on the ACTION returns the whole serialize uncapped;
  `limit:N` overrides the 30-item cap. (`capAutoSnapshot` is the single entry point;
  the stale-fallback path uses it too.) The explicit `fast_snapshot` path is unchanged
  (numeric `truncated` count, its own `full`/`limit`).
- **Why:** the Grok latency profile (`docs/GROK_LATENCY_2026-09-15.md`): click results
  reached ~37k chars on text-heavy pages because a single content block can be 500
  chars — ~0.9s of fresh prefill per model turn, every turn.
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** the cap measures `JSON.stringify(snap)` (the snapshot object, not the
  whole result) — a result lands at ~8.1k with its own fields. Loss order is
  deliberate (content before items, text before whole entries): don't reorder it or a
  click result loses the very control the model needs next. `full`/`limit` are read
  from the action's own args, so a `fast_batch` step passes them per step.
- **Status:** committed / verified on the isolated hvm rig on Wikipedia's Main_Page:
  default `fast_wait` result 8064 chars (`items 30, content 15, truncated:true,
  dropped {content:6, items:18}`), `full:true` → 11849 chars (48 items / 21 content,
  no `truncated`), `limit:3` → 2913 chars. Shipped to hvm via rsync + `bench/FIXER_READY`
  (rig agent restarts); Windows copy NOT synced.

## 2026-09-15 — Grok-runner bench fumbles → tool fixes: actionable misses, titled/emotion react-select, portal listbox sweep, storm-safe fast_wait
- **What:** Four tool defects surfaced by the 2026-09-15 Grok runner pass (local bench,
  8/8 cells, every fumble classified from `~/.local/state/fastrun/runs.jsonl`), all in
  `fast-ext/src/actions/page.js`:
  1. **`fast_fill` miss is now actionable.** A miss returns `candidates` (the visible
     fillable fields with label/placeholder/aria/name) and `hiddenMatches` + `hint` when
     a label-matching field EXISTS but is hidden, read straight from the live DOM
     (bounded, `FILLABLE_SEL`, ≤500 elements). `fast_fill_form` attaches the same
     report once per call when a field is `not found`. The match logic is unchanged —
     Wikipedia's `fast_fill {match:"Search"}` miss was CORRECT (the `#searchInput` is
     `display:none` behind Vector's `.search-toggle` at that width); the error just
     said nothing, so Grok guessed.
  2. **`fast_select_option` finds heading-titled and emotion-styled react-selects.**
     `findField` falls through to a document-outline section lookup (`resolveSection`
     with a new `DROPDOWN_SEL`): "Single" → `<h4>Single</h4>` → the first combobox /
     select / `react-select-*-input` in that section. React-select detection no longer
     needs a classNamePrefix: with none set, classes are emotion hashes
     (`css-1y6m8t7-control`) and both `[class*="select__control"]` and
     `[class*="__control"]` missed, so the control fell into the generic-ARIA branch;
     now the nearest ancestor whose class token ends in `control` is the control,
     open-state is read from the input's `aria-expanded` (the `--menu-is-open`
     modifier only exists with a prefix), and the menu is opened with a real
     `mousedown` (react-select opens on `onControlMouseDown`, not click — a bare
     `.click()` only ever worked when typed filter text opened the menu, which a
     non-searchable dummy-input select never does). A miss returns `candidates`
     (every visible dropdown-ish control with label/aria/placeholder/name/id + its
     `section` heading). Non-searchable react-selects render a 1px opacity-0 dummy
     input, so section resolution and the candidate list measure the CONTROL's
     visibility for `react-select-*-input`s (`fieldVisible`).
  3. **Generic-ARIA dropdown poll sweeps portals.** Options mounted in a portal
     (Angular `cdk-overlay-container`, end-of-body `[role=listbox]`) were only reached
     through the mutation drain, which on a storm-tripped / backlogged page (GCP) never
     indexed them → 3s to `no listbox detected` while a plain `fast_click` on the
     option worked because snapshots sweep overlays. The poll now calls
     `collectOverlayEls()` every 4th tick (bounded 60ms / 500 elements).
  4. **`fast_wait` on storm-tripped pages.** With the observer disconnected (Maps after
     "Directions": thousands of mutations), nothing new was ever indexed, and the
     body-textContent fallback cannot see attribute text (aria-label / placeholder), so
     `fast_wait {text:"Choose starting point"}` timed out at 6.8s while the input was
     on screen. The poll now re-seeds the resumable DOM walk when storm-tripped (same
     rule as `serializeSnapshot`), drains 2000/30ms like a snapshot, and probes
     `aria-label` / `placeholder` directly (bounded 1500 elements, every other poll),
     returning the element with coords + a stable id. The fallback also stops matching
     text that lives ONLY inside `<script>/<style>/<template>/<noscript>` bodies
     (`body.textContent` includes inline JSON state blobs) — that was a latent false
     "found".
  - `fast-runner/runner.mjs`: tool-log `preview` 160 → 1200 chars so a fumble can be
    post-mortemed from `runs.jsonl` (an error's candidates, a batch's per-step results);
    this hunk was swept into `f3d8b20` (another agent's runner commit) — noted here, not
    a separate commit. Touched `fast-runner/` per the owner's "change any code" word.
- **Why:** classification of tonight's runs: `overlay` (react-select.com) cost 24 calls /
  125s wall after one `field "Single" not found` (→ scout, xy-clicks, fast_do, typing);
  `gcpform` lost a 7s batch to `no listbox detected`; `mapsdir` lost 6.8s to the wait
  timeout; phase-0 Wikipedia lost 2 calls to the bare fill error. Not tool defects:
  `fast_evaluate` "disabled for this account" (relay setting, ×2 — a toolset item),
  `fast_click "Ocean"` hitting `Remove Ocean` (ranking picked the role=button; model
  choice), `fast_wait {text:"From"}` resolving on "Offers from our partners" (substring
  semantics as documented). No GLITCH-class failures tonight: 0 timeouts, 0 STUCK, no
  broker drops in any of the 8 local or 6 hvm pass-1 cells.
- **Files:** `fast-ext/src/actions/page.js` (only). No tool description changed, so
  `fast-dxt/server/tools.js` / `fastlink-relay/tools.js` are untouched.
- **Watch out:** a `fast_fill` / `fast_select_option` miss is STILL a hard error — the
  reports are advisory, nothing auto-reveals or auto-falls-back (a hidden match is
  reported, not filled). `fieldVisible` widens visibility ONLY for
  `input[id^="react-select-"]`; do not generalise it or hidden inputs become fill
  targets. The fast_wait attribute probe runs only on the fallback (odd) polls and only
  after the index scan misses — keep it there or every poll pays a querySelectorAll.
  `fast_wait`'s storm re-seed must keep the "only when nothing pending" guard (same
  reason as the snapshot's: nulling the cursor restarts DFS from `<body>` every poll).
  The hvm rig loads `fast-ext` UNPACKED, so shipping = copy the file + restart that
  Chrome; the runner spawns a fresh `fast-dxt/server` per cell, the broker is untouched.
- **Status:** committed / verified on an ISOLATED hvm rig (own Xvfb :97, patched-port
  broker 9886/9880, Chrome for Testing + this `fast-ext`, no contact with the bench rig):
  test page — hidden "Search" → `hiddenMatches` + `candidates`; portal listbox
  `Application type → Web application` picked (`kind:aria-listbox`, read back);
  storm + late aria-label input → `fast_wait` found it with coords in 1.9s; live
  react-select.com/home — `fast_select_option {field:"Single", option:"Forest"}` →
  `picked:"Forest"` (`kind:react-select`), first `singleValue` reads "Forest".
  **hvm bench passes:** pass 1 = unfixed baseline (`8eaff09`). The first fix build
  (this entry minus items "script-only text" and `fieldVisible`; file md5
  `2b1465f5…`, committed as-is) reached the rig 9s INTO pass 2 cell 1 — my boundary
  watcher started after the pass-1 commit line had already been written — so
  **pass 2 `multipage` (06:16:48Z, score 0/6, 48 calls, marked valid) is a rig
  restart artifact, exclude it**; pass 2 cells 2–6 ran on `2b1465f5…` (= commit
  `5ba6bd6`). Pass 3 (all 6 cells) runs on the final file (`cd7af46a…`, this commit),
  shipped at the pass-2 → 3 boundary at 06:22:31Z: the watcher fired the instant the
  pass-2 `mapsdir` run.js exited, before hvm-run.sh's `rig_up`, which relaunched the
  rig Chrome on the new file (06:22:38Z). That Chrome needed SIGKILL (SIGTERM had not
  finished in 0.5s) and the fresh extension then took ~90s to get its broker slot back,
  so `rig_up` gave up and **pass 3 `multipage` was SKIPPED by hvm-run.sh ("rig down",
  no row)**; pass 3 cells 2–6 ran on `cd7af46a…`. The slow re-slot is a broker defect
  (see the slot-probe entry above, if present). **Windows extension copy NOT synced
  tonight** (the local bench stays on unfixed tools); `chrome://extensions` reload
  still needed there later.

## 2026-09-15 — fast-runner: per-model-turn instrumentation (`turns[]` in runs.jsonl)
- **What:** every model call is logged to the run row as `turns[]`: `{turn, t, latencyMs,
  attempts, requestChars, inputTokens, cacheRead, cacheCreate, outputTokens, toolResultChars,
  stop_reason, tools, thinking, …any extra xAI usage keys}`; `usage` gains `cacheCreate` +
  `modelMs`. `createMessage` returns `_timing` on the body. No request/behaviour change.
- **Why:** the runner's per-turn latency (5–11s on heavy cells vs grok.com's ~2.6s) could only
  be inferred from toolLog gaps; result sizes were not stored at all (1200-char previews).
- **Files:** `fast-runner/xai.mjs`, `fast-runner/runner.mjs`.
- **Watch out:** the bench spawns `cli.mjs` per cell, so cells started after this commit carry
  `turns[]`; older rows don't. `bench/drive-runner.js` ignores the new keys.
- **Status:** committed; in flight on the pass-2/3 cells that start after it.

## 2026-09-15 — Grok runner bench, phase 1: full suite ×3 over the relay + tool-usage data
- **What:** All 8 bench tests run through `bench/run.js --client grok_runner --browser
  yaakovschrome` (fast-runner over relay.ytx.app, grok-4.6 effort low). Pass 1: **70/70,
  428.2s wall, 110 calls, 8/8 valid** vs the 08-06 grok.com baseline 70/70 / 259.3s / 99.
  Results + fumble review in `docs/GROK_RUNNER_BENCH_2026-09-15.md` (passes 2–3 appended as
  they land). Driver fixes in `bench/` only: runner rows re-summarize wall/calls from the run
  store's toolLog after exit (streamed stderr rows lagged by a call); negative `ms` from
  WSL clock skew clamped; `tool-usage.md` now aggregates ALL cells (n=3) with per-tool
  `retry` / `switch` / `fumble %` (next call on the same target), each usage row carrying a
  `target` per call (backfilled from the run store for older rows).
  Final 3-way (the lead's plan changed twice mid-run; an extra default pass `d2` = 70/70 /
  401.7s / 100 calls is kept as variance data): **pass 2 = phase2 toolset on grok-4.6: 70/70,
  414.5s, 91 calls, 0 reflex** (239.8s without overlay's 174.7s blow-up); **pass 3 = phase2 on
  grok-4.3: 56/70, 55.3s wall, 50 calls, 4 overclaims** — gcpform 2/6 (no recovery after the
  `<cfc-select>` select_option miss, 3 consecutive errors), overlay 1/3 (selected Forest in
  the wrong react-select), extract 19/22 (counted the World row), mapsdir 4/6 (fill before
  the input rendered), cfworkers 2/5 (never clicked the Worker). `run.js --toolset <name>`
  forwards to `cli.mjs --toolset`; rows carry `toolset` + `model`; `tool-usage.md` renders
  one histogram per toolset × model.
- **Why:** plan phase 1 — the data phase 2's tool triage needs.
- **Files:** `bench/{drive-runner,run}.js`, `bench/tool-usage.md`, `docs/GROK_RUNNER_BENCH_2026-09-15.md`.
- **Watch out:** `fast_evaluate` is BLOCKED for the runner's relay account (`evalBlocked`);
  both models reach for it in 11 of 32 cells (forms, tables, and "today's date") despite the
  phase2 description saying it may be disabled. On 4.6, round-trips are 80–96% of wall and the
  toolset does not move it; on 4.3 the wall collapses but the model stops one action short or
  skips the read-back. Two rows were re-run after my timestamp pruning of aborted passes
  caught them (d2 + p1 cfworkers; originals noted in the doc). The pre-pass 05:52 `extract`
  cell was pruned from `tool-usage.jsonl`. Snapshot `i` gets passed as `fast_click index` by
  both models.
- **Status:** all three passes committed; results doc final.

## 2026-09-15 — bench: self-driving hvm rig (grok_runner over the LOCAL transport, n=3)
- **What:** `bench/hvm-rig.sh` (env + idempotent bring-up: Xvfb `:98`, Chrome for Testing
  with the unpacked `fast-ext`, broker `:9876`, grokcode proxy `:8791`, proof that the
  extension is on the broker), `bench/hvm-run.sh` (PASSES×6 auth-free cells, commit per
  pass, doc regenerated per pass), `bench/hvm-report.js` (per test × pass score/wall/calls,
  best + median wall vs the relay baseline, all-pass tool histogram with per-tool fumble
  count, fumble list; targets read from the runner's run store). `drive-runner.start` takes
  `transport` so `run.js --transport local` spawns `cli.mjs --local` instead of always
  `--relay`.
- **Why:** run the Grok-runner suite on a box that does not sleep; phase 1 needs tool-choice
  data, not hop latency, so the local transport is fine there.
- **Files:** `bench/hvm-rig.sh`, `bench/hvm-run.sh`, `bench/hvm-report.js`,
  `bench/drive-runner.js`, `bench/run.js`.
- **Watch out:** hvm-specific facts baked into hvm-rig.sh — branded Chrome ≥137 ignores
  `--load-extension` (hence Chrome for Testing under `~/.local/share/fastlink-bench-chrome`),
  Chrome needs `--no-sandbox` there (AppArmor), `:8790` on hvm is an unrelated service so the
  proxy is on `:8791` (`GROKCODE_PORT/URL`, already env-driven in `xai.mjs`). `gcpform` /
  `cfworkers` are skipped (no login in that profile). hvm and WSL now hold separate copies of
  `~/.grok/auth.json`: if xAI rotates refresh tokens, one side's refresh can invalidate the
  other — cure is `grok login` on the side that breaks.
- **Status:** in code / committed / rig verified live on hvm.

## 2026-09-15 — fast-runner: explicit per-run toolsets (`--toolset`) + phase-2 / no-cdp sets
- **What:** `runner.mjs` `loadToolset(spec)` — `"default"`/unset → `toolset.json` (all 45 tools +
  the server's `instructions` essay, the A/B baseline, untouched); a bare name → `toolset.<name>.json`;
  a path → that file. `buildTools`/`buildSystem` exported; `runs.jsonl` rows + the finished-run
  snapshot carry `toolset`. Non-default toolsets DROP `client.instructions` from the system prompt.
  New `toolset.phase2.json` (13 raw tools + 2 native = 15, ≤2-sentence Grok descriptions) and
  `toolset.no-cdp.json` (12, no `chrome.debugger` tools), per `docs/TOOL_TRIAGE_DRAFT.md` §3.
  `cli.mjs --toolset <name|path>` and `--dump-tools` (reads `fast-dxt/server/tools.js`, no browser);
  `grok_run{toolset}`; `FASTRUN_TOOLSET` env. `npm test` → `test/toolset.test.mjs` (node:test).
- **Why:** owner: "we are looking to optimize" — the bench needs to A/B the triaged list against the
  baseline per cell, so selection must be explicit, not ambient.
- **Files:** `fast-runner/runner.mjs`, `cli.mjs`, `caller-mcp.mjs`, `package.json`, `README.md`,
  new `toolset.phase2.json`, `toolset.no-cdp.json`, `test/toolset.test.mjs`; `docs/TOOL_TRIAGE_DRAFT.md` §3a/3b.
- **Watch out:** `describe` keys are REAL tool names (pre-rename). A missing/mistyped toolset name
  throws before any connect. Bench slicing: filter `runs.jsonl` by `toolset`, not by date.
- **Status:** unit-tested + `--dump-tools` eyeballed; NOT yet run against a browser (both busy with bench passes).

## 2026-09-15 — docs: Grok runner phase-2 tool triage draft (`docs/TOOL_TRIAGE_DRAFT.md`) — 45-tool inventory + use counts, overlap map, ≤15-tool toolset (core/fold/internal/drop), Grok-tuned descriptions, no-cdp profile, phase-3 risks; source only, no code touched.

## 2026-09-15 — fast-runner phase 0b + 1: relay transport (OAuth client) + bench runner driver
- **What:** `fast-runner/relay-transport.mjs` — `connectRelay({browser})` is an MCP
  Streamable-HTTP client to `relay.ytx.app/mcp` authenticated the way claude.ai/grok.com
  are: the SDK's `OAuthClientProvider` does discovery → dynamic registration
  (`client_name` "fastrun", `token_endpoint_auth_method` none) → authorization_code +
  PKCE S256; the one-time login redirects to a loopback `http://127.0.0.1:47821/callback`
  the transport serves itself; tokens + client registration + PKCE verifier live in ONE
  file `~/.config/fastrun/relay-token.json` (dir 700, file 600) and the SDK refreshes
  silently on 401. ONE MCP session per connect; `browser` → `fast_profile` right after
  connect, so the pin is stored under the runner's own OAuth `cid`. `relay-login.mjs` =
  login + smoke (`--reset` re-registers). `bench/drive-runner.js` — bench driver that
  spawns `fast-runner/cli.mjs --relay [--browser N] "<prompt>"`, feeds the runner's
  streamed tool-call lines to a `RunnerTrace` (RelayTrace-shaped rows), then swaps in the
  exact `toolLog` from `~/.local/state/fastrun/runs.jsonl` at exit; process exit is the
  FINISH signal, STUCK/NO_ACTIVITY keep monitor.js's meaning; `ask_caller` is answered
  with a fixed "proceed" line. Appends every cell to `bench/tool-usage.jsonl` and
  regenerates `bench/tool-usage.md` (tool / calls / errors / avg ms / tests). `run.js`:
  client `grok_runner` (always the runner driver), `--browser`, runner preflight = a real
  `fast_status` over the runner's own relay session (no device token needed),
  `claimedComplete` = runner status (`done`) instead of phrase heuristics.
- **Why:** plan phases 0b/1 — same channel grok.com used in the 08-06 bench so numbers
  compare 1:1, and a driver that needs no chat site.
- **Files:** `fast-runner/{relay-transport,relay-login}.mjs`, `bench/{drive-runner,run}.js`,
  `bench/.gitignore`, `bench/tool-usage.md`.
- **Watch out:** the loopback port is REGISTERED with the relay at DCR — change
  `CALLBACK_PORT` and you must `relay-login.mjs --reset`. `OAuthError` is exported from
  `@modelcontextprotocol/sdk/server/auth/errors.js`, not `client/auth.js`. The account's
  browser names are now `browser-1` (offline), `fastlinkchrome`, `fastlinkchrome-2`,
  `yaakovschrome` (the live one) — the plan's "browser-1" is stale. `cli.mjs` has no
  `--json` flag: unknown flags become part of the task text, so the driver passes only
  `--relay`/`--browser`; the final JSON carries `so_far.recent` (last 10) — the full log
  is the run store. `FASTLINK_DEVICE_TOKEN` in `~/fastlink-secrets.txt` is REJECTED by
  `/devices` (invalid_device_token): chat-site cells (`--client grok|claude`) still need a
  valid one; the runner path does not.
- **Status:** committed / **verified live**: login completed by driving Chrome through the
  local connector (Google account chooser → loopback callback from Windows Chrome into
  WSL worked), `listTools` = 45 fast_* tools, `fast_status` over the relay shows
  `userId 115636077357721664019`, `selected:"yaakovschrome"`, `selectionMode:"pinned"`;
  `fast_tab` example.com → `fast_snapshot` h1 "Example Domain" (4 calls, 1.08s incl.
  connect). Bench cell `grok_runner × relay × extract`: **22/22, 7.4s wall, 6 calls**,
  `bench/tool-usage.md` produced. Other 7 tests not yet run through the runner.

## 2026-09-15 — fast-runner phase 0: Grok drives FastLink, Claude is the caller
- **What:** New `fast-runner/` (see `docs/GROK_RUNNER_PLAN.md`). `runner.mjs` runs an
  agent loop with grok-4.6 (Anthropic-Messages format via the grokcode proxy on :8790,
  which owns the xAI OAuth token) over FastLink's MCP tools listed dynamically from
  `fastlink-client.mjs` (`local` = spawn `fast-dxt/server/index.js` over stdio with the
  same env as the `fastlink` MCP entry in `~/.claude.json`; `relay` = `relay-transport.mjs`).
  Runner-native tools `ask_caller` / `report_done`; budgets 60 calls / 10 min / 3
  consecutive errors; runs logged to `~/.local/state/fastrun/runs.jsonl`. `caller-mcp.mjs`
  is the `fastrun` MCP server (user-scope) with `grok_run` / `grok_answer` /
  `grok_status` / `grok_cancel` (240s hold, question/running/done). `cli.mjs` runs one
  task from the shell; `toolset.json` = allow/rename/describe overrides Grok sees.
- **Why:** bench 2026-08-06 — Grok finished the suite 2× faster than claude.ai; make it
  the operator and keep Claude as dispatcher.
- **Files:** `fast-runner/{package.json,runner.mjs,xai.mjs,fastlink-client.mjs,caller-mcp.mjs,cli.mjs,toolset.json,README.md}`.
- **Watch out:** reasoning effort is fixed at proxy start (`GROKCODE_EFFORT`; runner starts
  it with `low`) — restart the proxy to change it. FastLink signals failures as
  `{"error":…}` text, not MCP `isError`; the runner parses that for its ok flag and the
  consecutive-error budget. The local server spawn is a SECOND fast-dxt process attached
  to the shared broker (no `--http`, so no port clash with Claude Code's own instance).
- **Status:** committed; verified live over `local` (Wikipedia search 58.6s/14 calls,
  ask_caller fill task 14.2s/4 calls, fill read back via fast_snapshot). Relay transport
  is phase 0b.

## 2026-08-06 — fast_tab returned before the tab existed → "Restricted URL: " in fast_batch
- **What:** `chrome.tabs.create` resolves BEFORE the navigation commits — the new tab's
  `.url` is `""` and only `.pendingUrl` holds the target. `openTab` pinned the tab and
  returned immediately (reporting `pendingUrl`, so it *looked* fine), and the next
  action resolved that pinned tab, hit `isInjectableUrl(tab.url)` with `""`, and failed
  with `Restricted URL: ` — an EMPTY url after the colon, which is the signature of
  this race. All three tab-creation paths in `openTab` now await a new
  `waitForUrlCommit()` before returning, and return the COMMITTED url.
- **Why:** every `fast_batch` starting with `fast_tab` lost all subsequent steps.
  Reproduced 100% on example.com: `[fast_tab, fast_snapshot]` → step 1
  `"Restricted URL: "`. Between two separate MCP calls the model's round-trip masks
  it, which is why it only ever showed up inside a batch.
- **Files:** `fast-ext/src/actions/tab.js`.
- **Watch out:** `waitForUrlCommit` deliberately does NOT reuse `waitForComplete()`.
  That one waits for `status:'complete'` via an `onUpdated` listener, so a load that
  finishes before the listener attaches would burn the FULL timeout on every single
  `fast_tab`. A committed URL is what callers actually need and it has a natural
  early-out. Do not "simplify" the two into one.
- **Status:** in code / synced to Windows copy / reloaded / **VERIFIED LIVE** as the
  running content script: `[fast_tab, fast_snapshot]` on example.com now returns real
  page content (was `"Restricted URL: "`), and the full original failure path
  `[fast_tab, fast_fill, fast_evaluate]` on selenium web-form succeeds with the value
  confirmed present in the DOM.

## 2026-08-06 — bench/: chat-vs-chat FastLink benchmark harness
- **What:** New `bench/` harness measuring how well different AI chats drive FastLink.
  EIGHT tests (`multipage`, `gcpform`, `staticform`, `overlay`, `extract`,
  `flightsearch` aa.com, `mapsdir` Google Maps, `cfworkers` Cloudflare dashboard), each scored
  by ORDERED CHECKPOINTS verified against **live page state read back through the
  LOCAL broker** — deliberately off-transport, so the channel under test (the relay)
  is never also the channel doing the verifying. Nothing is scored from what the model
  claims. A separate `claimedComplete` column records whether the chat asserted success,
  so "filled 3 of 4 fields" and "claimed 4" cannot blur into one number.
  `monitor.js` flags a run STUCK (no tool call for ~60s) or NO_ACTIVITY so a broken
  cell is marked `valid:false` instead of being recorded as a slow/failed model.
- **Why:** wall-clock alone is misleading — a model that quits at 60% looks fast. Also
  to quantify what FastLink fixes actually buy, by re-running the suite after changes.
- **Files:** `bench/{suite,score,monitor,drive-web,run,report,fastlink}.js`, `bench/package.json`.
- **Watch out:** Prompts MUST name the FastLink connector explicitly — with a neutral
  prompt, Grok answered from its own web browsing and made **zero** FastLink calls
  (scored 0/6 until the harness flagged NO_ACTIVITY). The suite then measures tool
  choice rather than driving speed.
  Test pages hand out FALSE results from their default state: on selenium's web-form
  the `<select>` starts non-empty, the FIRST radio is pre-checked, and BOTH checkboxes
  share `name="my-check"` so `form.elements['my-check'].checked` is `undefined` — that
  last one scored a false FAILURE against both models until fixed by reading
  `#my-check-2` directly. Verify every checkpoint against an UNTOUCHED page.
  Relay clients open a new MCP session per tool call, so traces must be aggregated
  across all sessions and sliced by time window.
  **Authed tests are NOT symmetric across two Chrome profiles on different accounts.**
  `gcpform` needed `gcloud projects add-iam-policy-binding booming-argon-464605-n5
  --member=user:yaakov@ytx.app --role=roles/editor`; `cfworkers` needed the second
  profile signed into the SAME Cloudflare account. Cookies are per-profile, so an
  OAuth flow completed in one profile does NOT give the other a session.
  **claude.ai asks tool permission PER TOOL** and blocks the whole turn until a human
  clicks — with no trace activity, so a blocked run records as NO_ACTIVITY / a low
  score. `drive-web.approveToolPrompts()` clears it, hooked to `watchRun`'s new
  `onQuiet` so it only fires when nothing is driving the browser.
  aa.com persists a submitted itinerary to `localStorage` and RE-FILLS the form from
  it on the next load — cleared via `reset.clearStorage`, since closing tabs cannot.
  `cfworkers` runs against a REAL production Cloudflare account: it is read-only by
  construction. Do NOT add a mutating step.
- **Status:** in code / all 8 tests validated in BOTH directions; suite running live.

## 2026-08-06 — Multi-browser: named browsers + per-client routing on the relay
- **What:** One relay account can now drive MANY named browsers, and a client picks
  which one. `devices.label` becomes the user-facing NAME (migration `0006` renumbers
  existing labels to `browser-N` and adds a **partial** unique index on
  `(user_id, label) WHERE revoked = 0`, so revoking frees a name). `extSocket()` is
  **deleted**, replaced by `resolveTarget(clientKey)` → name → `device_token` → the
  live socket carrying it; the socket is resolved ONCE per MCP request and threaded
  through consent probes, `fast_batch` nav-settle, `fast_evaluate`, `notifyExtension`
  and the vision tier, so two chat products calling concurrently cannot race.
  Relay `fast_profile` (`install:"<name>"|"auto"`) mirrors the local tool byte-for-byte;
  `fast_status` gains `browsers[]`, `selected`, `selectionMode`, `selectionSource`,
  `defaultBrowser`, `routedBrowser`. New `GET/POST /devices` (same device-token auth
  as `/consent`, `/trace`). Options page gains a "This browser's name" card modelled
  on the Broker-slot card.
  - Two bugs found en route: the `hello` frame's `serializeAttachment({installId,version})`
    was **erasing** the `{connectedAt, deviceToken}` stamp (which also broke targeted
    revoke) — now merged; and background prewarm-on-nav snapshotted "whichever
    connected last" instead of the browser that actually navigated.
- **Why:** `userRelay.js` routed every command to the MOST-RECENTLY-CONNECTED socket
  ("multi-device most-recent-wins"). With two browsers paired, which one got driven
  flipped whenever an MV3 service worker redialed — silently wrong, not merely
  blocked. The local broker had solved this years earlier with install slots; the
  relay never caught up.
- **Files:** `fastlink-relay/migrations/0006_device_names.sql` (new),
  `fastlink-relay/src/{db,auth,index,mcp,userRelay,composite,timing}.js`,
  `fastlink-relay/tools.js`, `fast-ext/options.html`, `fast-ext/options.js`.
- **Watch out:** Selection is keyed by **OAuth client id** (`cid`, stamped into grant
  props, forwarded as `X-Fastlink-Client-Id`), NOT the MCP session and NOT the raw
  bearer. This is load-bearing: relay clients open a NEW MCP session per tool call
  (measured: claude.ai 5 sessions for 5 calls; Grok 11 for 11), and access tokens
  refresh hourly — a session-scoped or raw-token-keyed pin would silently drop.
  Grants minted before the `cid` stamp fall back to `tokenKey()` until the client
  re-authorizes. Most-recent-wins survives ONLY inside the explicit `auto` branch —
  do NOT reintroduce it as a fallback; a pinned-but-offline browser must stay a hard
  error naming the connected ones.
- **Status:** deployed to relay.ytx.app (version `d1abf155`) + migration applied
  remote / extension synced to Windows copy, **needs `chrome://extensions` reload**
  for the options card. Verified live: `/devices` returns the new shape and the
  migration renamed the existing device to `browser-1`. NOT yet verified: any
  second-browser pairing — only one browser is paired, so multi-browser routing has
  never run end-to-end on the wire.

## 2026-08-06 — Snapshot served STALE input values; password leak; section-scoping rewrite
- **What:** Two bugs in `fast-ext/src/actions/page.js`, both reproduced live on the
  GCP "Create OAuth client ID" form.
  1. **Stale input values.** `makeClickEntry` baked `el.value` into the cached
     `entry.text`, and *nothing could ever invalidate it*: writing `.value` through
     the property setter mutates **no attribute**, so no MutationRecord exists; the
     observer's `attributeFilter` excludes `value` and `characterData` isn't
     observed. A filled field reported its pre-fill default forever. Fix: a
     control's value is **no longer cached** — `liveKindOf()` tags value-bearing
     entries and `refreshLiveEntry()` re-reads the DOM as the single derivation
     point (index time, serialize loop, and `fast_wait`'s scan). Snapshot items now
     also carry an explicit live `value`.
  2. **`section:` silently wrote the WRONG field.** Two defects: `fast_fill` did
     `if (scoped.length) pool = scoped;` so an unresolved section silently kept the
     page-wide pool and the first global match won; and the nearest-preceding-heading
     resolver could never resolve on GCP, which renders an `<h3>Item 1</h3> `directly
     above *each* URI row. Fix: sections resolve by **document outline** (anchor to
     next same-or-higher-level anchor), candidates collected from the DOM inside
     that span. An unresolved section is now a **hard error** listing the page's
     real sections.
  - Also: `input[type=password]` was putting the **raw password** into snapshot
    text — now reports a `•` mask of the right length.
  - Also: `fast_fill_form` was ignoring `section`/`near` **entirely and silently**
    (args forwarded verbatim); now wired to the same resolver, with the same hard error.
  - `near` was documented as "nearest context text" but implemented as heading
    scoping — it is now an explicit alias of `section` (one resolver).
- **Why:** benchmarking Claude vs Grok on the GCP form. The stale snapshot forced
  ~49s of screenshot round-trips in a single run because the agent couldn't trust
  the DOM; the `section:` bug silently overwrote the JavaScript-origins field while
  reporting success.
- **Files:** `fast-ext/src/actions/page.js`; descriptions only in
  `fast-dxt/server/tools.js` + `fastlink-relay/tools.js` (mirrors kept in sync).
- **Watch out:** Do NOT re-add `el.value` to `makeClickEntry`'s text chain — the
  cache cannot be invalidated for property-setter writes, that IS the bug.
  `refreshLiveEntry()` must stay the single derivation point. Do NOT reintroduce a
  silent fallback when a section fails to resolve — silent wrong-field writes are
  worse than errors. Note this page hits the `MAX_WALK` ceiling (`capped:true`,
  ~130 entries), which is why a plain `fast_fill {match:"Name"}` can miss right
  after render; section-scoped fills bypass it by reading candidates from the DOM.
- **Status:** in code / synced to Windows copy / **needs `chrome://extensions`
  reload**; root causes verified live in-page, but nothing yet exercised as the
  actual content script (password masking, `fast_fill_form` section path, and
  `fast_wait`'s live re-read are unverified).

## 2026-08-06 — Relay per-tool-call timing instrumentation
- **What:** The cloud relay recorded no timing, so only the local path could be
  measured. Added per-call `{t, name, gapMs, durMs}` traces (same semantics as the
  local `logTiming`: `gapMs` = model think time, `durMs` = action time) stored in
  the user's own Durable Object, scoped per session and stamped with the MCP
  `clientInfo` name so a trace can be attributed to grok / claude / gpt. Read them
  back with `relay-timing-report.js` (device-token authed `/trace`). The local
  report's inline summarizer was **deleted**; both now render through the shared
  `fast-dxt/server/timing-format.js`.
- **Why:** to compare how different AI clients drive FastLink. Without this there
  was zero data on any relay-driven client.
- **Files:** new `fastlink-relay/src/timing.js`, `fastlink-relay/relay-timing-report.js`,
  `fast-dxt/server/timing-format.js`; modified `fastlink-relay/src/mcp.js`,
  `src/userRelay.js`, `src/auth.js`, `src/index.js`, `package.json`,
  `fast-dxt/server/timing-report.js`.
- **Watch out:** Caps are deliberate — 500 rows/session, 20 sessions/user, 7-day
  TTL. `/trace` is device-token authed and deliberately sends **no** CORS header
  (its consumer is a CLI), unlike `/consent` and `/settings/gemini-key`.
  **Grok's connector opens a NEW MCP session per tool call** (11 sessions for 11
  calls), so any consumer must aggregate across ALL sessions sorted by timestamp
  and slice by time window — never assume one run maps to one session. In the rows,
  `t` is the END timestamp, so gap = (thisEnd − prevEnd) − thisDur.
- **Status:** deployed to relay.ytx.app (version `614f1ebc`) / verified live —
  captured a full 11-call Grok trace and a 14-call Claude trace.

## 2026-07-12 — Alex's laptop moved to the official release channel (fplhij → ockcja)
- **What:** HKLM forcelist entry repointed to the official channel
  (`ockcja…;raw.githubusercontent…/release/updates.xml`); signed 0.4.3 installed,
  auto-updates from now on. Dead local-channel artifacts deleted (kept `fast-ext-pack.pem`).
- **Why:** Laptop stuck on 0.4.2 — local repacking hit the manifest-`"key"` gotcha
  (crx signed as fplhij but manifest pins ockcja → Chrome silently refuses).
- **Files:** none in-repo (registry + local cleanup); channel per `release/README.md`.
- **Watch out:** releases per `release/README.md` are now the ONLY way to ship
  extension changes to self-hosted installs; never resurrect a local-file channel.
- **Status:** done; verified live 2026-07-12.

## 2026-07-12 — Launch-time fast-retry burst for broker connect (+ connect-path logging)
- **What:** For 8s after a window opens / SW wakes, failed broker dials retry every
  250ms instead of climbing the 1s→30s backoff ladder; pending slow reconnects are
  cancelled. Sparse timestamped `[conn …]` SW-console logs added (dial/open/close/retry).
- **Why:** Cold Chrome launch ate 1s+2s+4s of backoff — "extension connects ~5s late".
- **Files:** `fast-ext/src/connection.js`.
- **Watch out:** burst must not override the slot-busy cooldown (`connect()` checks
  `slotBusyUntil` first); steady-state failure pacing unchanged outside the burst.
- **Status:** committed; verified live 2026-07-12 (instant attach on quit/relaunch).

## 2026-07-11 — fast_locate scroll, empty-snapshot iframe hint, update-check tag parse
- **What:** Three fixes.
  1. **`fast_locate` `scroll:true`** — on a not-found vision tier, wheel-scrolls
     and re-points (up to 4 passes), mirroring `handlePoint`'s loop, so
     below-the-fold visual-only targets no longer return `found:false`. Added on
     the server (`handleLocate` → `pointOnce`), the relay, and both tool schemas.
  2. **Empty-snapshot iframe hint** — `fast_snapshot` now attaches a `hint` field
     when the result is near-empty but a large cross-origin iframe is present,
     nudging toward the vision tier (`fast_point`/`fast_fill_vision`) instead of
     leaving the agent to screenshot-and-read.
  3. **Update-check tag parse** — `updateCheck.js` strips an `ext-` tag prefix so
     `1.x` version comparisons against `ext-`-prefixed release tags don't break.
- **Why:** aa.com finding #4a (off-viewport `fast_locate` miss); Apple-setup
  P2/P3/I1 (near-empty snapshot didn't steer to vision); self-hosted auto-update
  tag mismatch.
- **Files:** `fast-dxt/server/handlers.js`, `fast-dxt/server/tools.js`,
  `fastlink-relay/src/composite.js`, `fastlink-relay/tools.js`,
  `fast-ext/src/actions/page.js`, `fast-ext/src/updateCheck.js`.
- **Watch out:** `fast_locate scroll:true` is opt-in (default off) — don't make it
  default or every locate pays the scroll cost. The snapshot `hint` is advisory
  only; don't gate behavior on it. `updateCheck.js` tag stripping assumes the
  `ext-` prefix scheme — revisit if the release tag format changes.
- **Status:** committed + released as extension v0.4.3 (signed .crx +
  `updates.xml` bumped); synced to Windows copy — needs extension reload +
  Claude Code restart to take effect locally; relay deployed (`wrangler deploy`,
  2026-07-12).

## 2026-07-11 — issue-doc reconciliation (retroactive)
- **What:** Verified the following against current code and closed/deleted their
  issue docs (git history retains the deleted files):
  - **ISSUES-2026-06-08 #1–7** — all fixed (doc self-confirmed; deleted).
  - **BUG-1** (empty-string fill dropped) — fixed; fills now write empty strings
    through the same path (confirmed in the BUG-2 doc's session note).
  - **BUG-2** (batch inter-step rebind) — fixed; `settleIfNavigated` +
    urlBefore/after detection in `runBatch` (both `fast-dxt/server/handlers.js`
    and `fastlink-relay/src/mcp.js`), keyed off ACTUAL navigation. Doc deleted.
  - **BUG-3** — fixed (closed alongside the batch/fill work). Doc deleted.
  - **BUG-4** (fill_form response path) — fixed; `fast_fill_form` races `withSnap`
    against a `HANDLER_CAP_MS=8000` hard cap, `withSnap` bounded/non-fatal
    (`fast-ext/src/actions/page.js`). Doc deleted.
  - **aa.com #3** — `composed:true` shipped: fill/select paths dispatch
    `input`/`change` with `{bubbles:true, composed:true}` (`page.js`).
  - **FEEDBACK 06-21 #1** post-action snapshot (`withSnap` → `snapshotFresh:true`)
    + **#6** profile discoverability (`fast_profile` + `fast_status`
    `selectedInstall`, commit `0aa05f0`).
  - **FEEDBACK 06-24 P4** Gemini retry/backoff+OpenRouter fallback (`scout.js`);
    **P5** `fast_type` `force`/`allowIframe` (`input.js`); **P6** `fast_screenshot`
    `fresh` (`screenshot.js`); **P7** `fast_fill_vision` `freshCapture`-default +
    `verifyVisionFills` read-back (`tools.js`/`handlers.js`); **P8** target-tab pin.
- **Why:** The issue docs had drifted behind the code; this entry is the record
  that replaces the three deleted docs (ISSUES-2026-06-08, BUG-2, BUG-4).
- **Files:** deleted `docs/ISSUES-2026-06-08.md`,
  `docs/BUG-2-batch-inter-step-rebind.md`, `docs/BUG-4-fill-form-response-path.md`;
  updated `docs/FEEDBACK-aa-com-2026-06-10.md`, `FEEDBACK_2026-06-21.md`,
  `FEEDBACK_2026-06-24.md` (reconciled status blocks).
- **Still OPEN:** 06-21 #2 (conditional multi-step executor — batch still linear),
  #3 (transparent auto-wake/retry), #4 (atomic hidden-radio label-targeting),
  #5 (`fast_locate` top-N candidates); 06-24 P1 (unified "is FastLink ready?"
  preflight across the local + relay connectors).
- **Status:** documentation only; no code change in this entry.

## 2026-07-08 — Read-aloud widget: hidden by default, toggled from the popup
- **What:** The read-aloud pill no longer auto-mounts on every page. It now mounts
  only when toggled on via a new "🔊 Read aloud on this page" button in the toolbar
  popup (messages `fastlink:read-aloud-toggle` / `fastlink:read-aloud-state` to the
  content script). The ✕ button hides it fully again; removed the dead
  `readAloudEnabled` options flag; neural voices load lazily on first show.
- **Why:** The always-on bottom-right overlay was covering page buttons.
- **Files:** `fast-ext/src/readAloud.js`, `fast-ext/popup.html`, `fast-ext/popup.js`.
- **Watch out:** the popup button hides itself on tabs without a content script
  (chrome:// pages, tabs opened before the extension loaded — reload the tab).
  Shadow-DOM listeners now attach inside `mount()` (recreated per show), and
  `mount()` resets the paint signature so a re-show repaints fully.
- **Status:** in code / synced to Windows copy — needs extension reload at
  `chrome://extensions` to take effect.

## 2026-07-07 — `fast_select_option` react-select targeting fix
- **What:** Made react-select detection class-prefix-agnostic and scoped option
  matching to the specific react-select instance.
  1. Detect the control with `[class*="select__control"]` (covers both the default
     `react-select__control` prefix AND `select__control`, which Greenhouse uses),
     plus a structural fallback via the `react-select-<N>-input` id for any other
     custom prefix.
  2. New `containerLabel()` helper resolves a field's human label from a sibling
     `<label>` in the same field group — rescues inputs whose only `aria-label` is
     an opaque internal id (`question_6132162009`, `gender`, `veteran_status`).
  3. Option lookup now queries `[id^="react-select-<N>-option"]`, so it can only
     return THIS control's options and can never fall back to another react-select
     on the page.
- **Why:** Reported by the Claude-fellowship (Greenhouse form) session: on that form
  `fast_select_option` failed for every dropdown ("no matching option in listbox /
  no listbox detected") and, worse, returned the **phone-country widget's** dial-code
  list — because the old code matched only `.react-select__control`, missed
  Greenhouse's `select__` prefix, fell through to the generic ARIA branch, and there
  grabbed the first react-select's options on the page.
- **Files:** `fast-ext/src/actions/page.js` (containerLabel helper, findField label
  loop, react-select branch of `fast_select_option`).
- **Watch out:** `containerLabel` deliberately stops climbing when an ancestor holds
  >1 `<label>` (a form section, not a field) — don't loosen that or unrelated labels
  will match. The instance-scoped `[id^="react-select-N-option"]` query assumes the
  default react-select option-id scheme; the id-derived `-listbox` and
  `[class*="select__menu"]` fallbacks cover non-standard builds. Native `<select>`
  and generic-ARIA-listbox branches are untouched.
- **Status:** committed + pushed (`0aa05f0`), synced to Windows copy. Needs extension
  reload + live retest on the Greenhouse form.

## 2026-07-07 — `fast_upload` (file upload without the OS picker)
- **What:** New tool `fast_upload` that sets file(s) on a `<input type=file>` via the
  trusted CDP `DOM.setFileInputFiles` (fires input/change), bypassing the native OS
  file-picker that browser automation can't drive. Windows-path aware: accepts a
  Windows path (`C:\...`), a WSL mount path (`/mnt/c/...`), or a native WSL path
  (`/home/...`) — the WSL server resolves each to a path the Windows Chrome process
  can open (native WSL → `\\wsl.localhost\<distro>\...` via `wslpath`) and verifies it
  exists first. Targeting by `selector` / `text` / `index`, default = the page's only
  file input. Returns `{ uploaded, accepted:[{name,size,type}], input }`.
- **Why:** User request ("drop in a file upload feature, make it work from Windows");
  also the exact "nice-to-have" the fellowship session asked FastLink for.
- **Files:** `fast-ext/src/actions/upload.js` (new), `fast-ext/src/actions/index.js`
  (wire), `fast-dxt/server/handlers.js` (`handleUpload` + `wslpath` path resolver +
  add to MUTATING_TOOLS), `fast-dxt/server/tools.js` (schema),
  `fastlink-relay/tools.js` (mirror schema), `fastlink-relay/src/mcp.js` (mark
  mutating), overlay/background/sidepanel ("Uploading file" label).
- **Watch out:** Requires "Advanced control" (CDP) enabled — same gate as
  `fast_click_xy`. Searches the TOP document only (not cross-origin iframes). The
  extension-side `winifyPath` is idempotent (safe on already-Windows paths) so the
  relay passthrough handles `/mnt/c` and `C:/` too; native-WSL translation only
  happens server-side (WSL MCP), not on the relay.
- **Status:** committed + pushed (`0aa05f0`), synced to Windows copy. Needs extension
  reload + Claude Code restart (to expose the new tool) before it's callable.

---

## Pre-existing in-flight work (bundled into commit `0aa05f0`, 2026-07-07)

The tree already carried a large body of **uncommitted** changes when this log
started (~997 insertions across 24 files) — now committed together with the above in
`0aa05f0` (they were entangled in the same files, so couldn't be split cleanly). Not
written entry-by-entry because they predate the log. High level, so we don't
accidentally revert them:

- **BUG-5 multi-install routing** — arbitrary N Chrome profiles via slot labels
  (`fast_profile`, `fast_status` selectedInstall); broker demux by label.
  See `docs/BUG-5-multi-install-routing.md`. Touches `fast-dxt/broker/*`,
  `server/handlers.js`, `server/config.js`, `options.*`, `connection.js`.
- **scout.js** — substantial additions (~+200 lines).
- **Read-aloud / Edge neural TTS** — new `fast-ext/src/readAloud.js`,
  `fast-ext/src/edgeTts.js` (untracked).
- Feedback logs `FEEDBACK_2026-06-21.md`, `FEEDBACK_2026-06-24.md` (untracked).

> These should be reviewed and committed in logical chunks so the history reflects
> them; until then, treat them as load-bearing and don't overwrite.

## 2026-09-15 — hvm rig: --password-store=basic
- **What:** Chrome for Testing on the hvm rig launches with `--password-store=basic`.
- **Why:** every service-worker network path (fetch, WS, broker dial) was frozen ~24.8s after launch — Chrome's os_crypt keyring D-Bus timeout on a headless box; with the flag the extension attaches in ~19ms. Root-caused by the fixer via CDP; it made the rig look like a slot-busy stall and cost a bench cell.
- **Files:** `bench/hvm-rig.sh`.
- **Watch out:** rig-only flag; not a FastLink change. The same symptom will appear in any headless container without a keyring — the box10 image needs the same flag.
- **Status:** in code / rsynced to hvm; takes effect on the next Chrome restart there.

## 2026-09-15 — relay: fast_evaluate enabled for the operator account (config, no code)
- **What:** D1 `users` row for the operator (yjturetsky@gmail.com): `allow_evaluate=1, eval_allow_all=1` via `wrangler d1 execute --remote`. Was 0/0.
- **Why:** owner: "get it on for now and see the numbers" — both Grok models reached for fast_evaluate in 11/32 bench cells and every call was blocked, one wasted turn each. Aug's Grok speed came partly from pushing work into the page with it.
- **Files:** none (remote D1 data). Revert: same UPDATE with 0/0.
- **Watch out:** allow_all is honored only because the row is `is_operator=1`; other relay users still need per-origin allowlisting. The box10 container profile excludes fast_evaluate regardless (cookie reach).
- **Status:** applied remote / verified via the runner over the relay (see next entry or bench doc).

## 2026-09-15 — hvm rig: clear the whole Service Worker dir, not just ScriptCache
- **What:** `bench/hvm-rig.sh` removes `Default/Service Worker` (registration DB + cache) before launching Chrome.
- **Why:** c12716f deleted only `ScriptCache`; the registration DB still referenced the cached script and every SW start failed (`DidStartWorkerFail ockcja…: 5` in chrome.log), so the extension never connected and the overnight queue (4.3 feedback pass, 4.6 control, evaluate A/B) ran zero cells.
- **Files:** `bench/hvm-rig.sh`.
- **Watch out:** rig-only. Any container start script that wipes SW cache must wipe the registration with it.
- **Status:** in code / pushed / applied on hvm via git pull.

## 2026-09-15 — bench: observation readback pins `primary` by default
- **What:** `runCell` default `install` is now `primary` (was `null`).
- **Why:** since 8498cbe the local broker refuses unpinned calls when >1 profile is connected; an unpinned scoring readback returned errors for every checkpoint, so two 4.3 cells at 18:44Z scored all-FAIL while the runner had actually filled the form (runs.jsonl: all four GCP values set, 10 calls, 38s).
- **Files:** `bench/run.js`.
- **Watch out:** pass `--install <label>` explicitly when observing another profile; never rely on the broker default again.
- **Status:** in code.
