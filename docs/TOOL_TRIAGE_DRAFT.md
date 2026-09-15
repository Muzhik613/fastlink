# Grok runner — phase-2 tool triage (DRAFT, 2026-09-15)

Goal: Grok sees ≤ 15 tools. Plan: `docs/GROK_RUNNER_PLAN.md` phase 2 (toolset.json only) → phase 3 (folds land in `tools.js` + relay mirror).
Every claim is tagged **[D]** data-backed (source cited) or **[J]** judgment.

## 0. Data sources

| id | source | what it holds | caveat |
|---|---|---|---|
| R | `~/.local/state/fastrun/runs.jsonl` (11 runs, 135 calls; 2 `local`, 9 `relay`; last read 2026-09-15 ~01:15) | per-call `{name,args,ms,ok,preview}` for tonight's grok-4.6 runner (`bench/tool-usage.md` = latest 6 cells of the same log) | `local` runs had no `GEMINI_API_KEY` → scout `disabled:true` |
| A | `bench/results.jsonl` 2026-08-06 rows (`client: grok` = grok.com via relay, 8 valid tests, 99 calls; `claude` 117) | per-test call COUNTS only, no tool names | relay `/trace` rows have a 7-day TTL (CHANGELOG 2026-08-06) and the stored device token is `invalid_device_token` → the 11-call Grok / 14-call Claude traces are gone; not re-creatable |
| M | memory `project_fastlink_grok_speed_benchmark.md` (2026-08-06) | qualitative: Grok never screenshotted; used `fast_scout` / `fast_evaluate` / `fast_text`; wiki fumble `fast_click_xy → fast_type → fast_snapshot → fast_fill`; scouted twice | n=1 per cell |
| C | code: `fast-ext/src/actions/input.js`, `evaluate.js`, `upload.js`, `key.js`, `util.js`; `fast-dxt/server/tools.js` (45 tools, relay mirror also 45) | which tools attach `chrome.debugger` | — |
| X | `/tmp/fastlink-timing.jsonl` (281 rows) | EXCLUDED: 221× `fast_list` is `bench/monitor.js`'s URL-trail sampler, not a model | — |

Aggregate (R): `fast_status` was call #1 in **9/11** runs; `fast_prewarm` in 6/11; `fast_scout` 6/11 (2 disabled, 4 live — **0** scout plans executed successfully, every live scout was followed by a full `fast_snapshot` or a failed batch; 0.9–3.4s each); `fast_tab → fast_wait{text}` load-wait pair in 8/10 tab opens; 26/45 tools never called. Reflex/overhead calls ≈ 9+6+6+8 = 29 of 135 (21%) **[D:R]**. Secondary pattern: `fast_snapshot{full:true}` re-issued right after `fast_click` 7× (paginated tables, GCP) because the action's auto-snapshot is a capped preview **[D:R b6df0f56, ebfcf719]**.

## 1. Inventory (45 tools)

Families: read / locate / act / input-cdp / vision-gemini / tab-nav / wait / batch-macro / ops. CDP = attaches `chrome.debugger` (yellow banner; needs "Advanced control"). Use = calls (errors) tonight [R] · Aug [M] mention.

| tool | purpose | family | CDP? [C] | use [R] | Aug [M] |
|---|---|---|---|---|---|
| fast_snapshot | structured DOM read (items + content), `screenshot`/`overlay`/`full` | read | no (screenshot:true → captureVisibleTab) | 20 (0), 9 runs | used |
| fast_text | innerText/outerHTML by selector | read | no | 4 (0) | used |
| fast_screenshot | PNG for visual check; `fresh:true` via CDP | read | **fresh:true only** (`util.js captureViaDebugger`) | 1 (0) | never |
| fast_marks | SoM-annotated screenshot of interactive els | read | no | 0 | — |
| fast_console | page console buffer | read | no | 0 | — |
| fast_network | request log (+bodies) | read | no | 0 | — |
| fast_network_replay | re-fire request in page ctx | ops | no | 0 | — |
| fast_scout | Gemini page read / intent → step plan | vision-gemini | no (capture path) | 6 (0; 2 disabled, 0 plans paid off) | used 2× |
| fast_point | Gemini coord grounding | vision-gemini | no* | 0 | — |
| fast_point_som | Gemini set-of-mark pick | vision-gemini | no* | 0 | — |
| fast_locate | DOM ∥ vision race → xy | locate | no* | 0 | — |
| fast_fill_vision | Gemini locate + trusted click/type whole form | vision-gemini | **yes** (clickXY+typeText) | 0 | — |
| fast_do | Gemini plans AND locates from one intent | vision-gemini | **yes** | 1 (0; did not finish the task — Grok followed with click_xy+type+Enter) | — |
| fast_vision_capture | raw capture primitive | vision-gemini | no* | 0 | — |
| fast_annotate_boxes | SoM draw primitive | vision-gemini | no | 0 | — |
| fast_prewarm | arm scout/vision pre-pass 60s | ops | no | 6 (0) | — |
| fast_status | connection + browser list | ops | no | 9 (0) | — |
| fast_profile | pin browser | ops | no | 0 (runner calls it itself) | — |
| fast_click | click by text/role/tag/index; auto-snapshot | act | no | 28 (2), 7 runs | used |
| fast_click_xy | trusted click at xy; NO auto-snapshot | input-cdp | **yes** | 4 (0), 1 run | fumble |
| fast_hover | hover by text; auto-snapshot | act | no | 0 | — |
| fast_drag | synthetic drag by text/xy | act | no | 0 | — |
| fast_drag_xy | trusted drag | input-cdp | **yes** | 0 | — |
| fast_fill | fill one field by label; auto-snapshot | act | no | 10 (0) | used |
| fast_fill_form | fill many fields (+native select) | act | no | 0 direct (1× inside fast_batch, ok) | — |
| fast_type | trusted insertText into focused el | input-cdp | **yes** | 1 (0) | fumble |
| fast_select_option | pick option (native/react-select/ARIA), batch `selections` | act | no | 2 (1) +1 in batch (failed) | — |
| fast_key_press | single key via DOM KeyboardEvent | act | no (`key.js dispatchEvent`) | 4 (0) | — |
| fast_key | key chord via CDP Input | input-cdp | **yes** | 0 | — |
| fast_scroll | scrollTop on detected container; auto-snapshot | act | no | 6 (0) | — |
| fast_wheel | trusted wheel at xy | input-cdp | **yes** | 0 | — |
| fast_upload | set files on `<input type=file>` | input-cdp | **yes** (`DOM.setFileInputFiles`) | 0 | — |
| fast_evaluate | run JS (CDP Runtime.evaluate, in-page fallback) | ops | **yes** (falls back) | 2 (2: relay `evalBlocked`) | used |
| fast_tab | open new tab | tab-nav | no | 10 (0), 10 runs | used |
| fast_nav | navigate active tab, waits load | tab-nav | no | 2 (0) | — |
| fast_reload | reload active tab | tab-nav | no | 0 | — |
| fast_list | list tabs | tab-nav | no | 0 | — |
| fast_switch | focus tab by id/match | tab-nav | no | 0 | — |
| fast_close | close tab | tab-nav | no | 0 | — |
| fast_wait | wait for text / networkIdle; auto-snapshot | wait | no | 16 (1), 9 runs | — |
| fast_batch | run N actions in one call | batch-macro | inherits | 3 (0; 1 inner step failed) | used |
| fast_macro_save | persist recipe | batch-macro | no | 0 | — |
| fast_macro_list | list recipes | batch-macro | no | 0 | — |
| fast_macro_run | replay recipe | batch-macro | inherits | 0 | — |
| fast_macro_delete | delete recipe | batch-macro | no | 0 | — |

`*` capture normally uses `chrome.tabs.captureVisibleTab`; `util.js` routes through CDP only when the pinned tab is not the on-screen tab (relay case with the user on another tab) **[D:C]**.

## 2. Overlap map

| group | tools doing the same job | single entry point for Grok | others become |
|---|---|---|---|
| click | fast_click · fast_click_xy · fast_locate→click_xy · fast_hover | **fast_click** | `x,y` args → trusted CDP path (click_xy); `hover:true` → hover. Auto-snapshot on every path (click_xy has none today → Grok re-snapshotted after each of 4 click_xy calls **[D:R ad2b318b]**), plus `full`/`limit` passthrough for the auto-snapshot (7 post-click `full:true` re-snapshots **[D:R]**) |
| fill | fast_fill · fast_fill_form · fast_type · fast_fill_vision · fast_do | **fast_fill** | `fields:{}` map → fill_form path; `focused:true` (no `match`) → CDP insertText into focused element (type). Vision variants → `vision` profile only (0 successful uses **[D:R]**; plan says Gemini untouched this pass) |
| read | fast_snapshot · fast_scout(no intent) · fast_text · fast_screenshot · fast_marks | **fast_snapshot** + **fast_text** (2, not 1: text is the extraction path Grok reached for 4× tonight and in Aug **[D:R,M]**) | `screenshot:true` already exists → add `fresh:true`; fast_screenshot, fast_marks hidden. scout summary hidden (4 live scouts were each followed by a full fast_snapshot or a failed batch **[D:R]**) |
| locate | fast_point · fast_point_som · fast_locate · fast_vision_capture · fast_annotate_boxes | **fast_locate** (vision profile only) | `mode:"race"\|"vision"\|"som"`; capture/annotate primitives internal-only |
| wait | fast_wait · fast_batch[…wait] · fast_nav `waitMs` | **fast_wait** + `waitFor:"text"` arg on fast_nav | 8/10 tab opens were immediately followed by `fast_wait{text}` **[D:R]** → one arg removes a round-trip per run |
| key | fast_key_press · fast_key | **fast_key** | no `modifiers` → DOM dispatch (no CDP, = key_press today); with `modifiers` → CDP chord. Grok used key_press 4×, key 0× **[D:R]** |
| scroll | fast_scroll · fast_wheel | **fast_scroll** | `x,y` present → trusted wheel |
| tab/nav | fast_tab · fast_nav · fast_reload · fast_list · fast_switch · fast_close | **fast_nav** | `newTab:true` (= fast_tab; 9/10 runs opened a new tab **[D:R]**), `reload:true`; list/switch/close → one internal `fast_tabs {list\|switch\|close}` (0 use) |
| ops | fast_status · fast_profile · fast_prewarm | none (runner-internal) | runner already pins via fast_profile; it should call status once pre-run and arm prewarm itself when the vision profile is on. 9 reflex status calls returned nothing actionable **[D:R]** |
| batch/macro | fast_batch · fast_macro_* | **fast_batch** | macros: 0 use [R], not mentioned [M] → DROP candidate (phase 3) **[J]** |
| debug | fast_console · fast_network · fast_network_replay · fast_evaluate | **fast_evaluate** only | console/network/replay are dev tools, not task-runner tools **[J]**; evaluate stays because Grok reaches for it (Aug: used; tonight 2× → blocked on relay, then `fast_text` **[D:R,M]**) |
| drag | fast_drag · fast_drag_xy | internal `fast_drag` (`trusted:true`) | 0 use both sources |
| upload | fast_upload | internal | needs a local path the runner host owns; 0 use |

## 3. Proposed toolset

Tiers: **CORE** visible as-is · **FOLD** merged into a CORE tool (arg shape given) · **INTERNAL** stays in the server, hidden from Grok (runner or a profile may use it) · **DROP** dead/superseded (phase 3 deletes it, no alias — replace, never layer).

| tier | tool | into / arg shape | basis |
|---|---|---|---|
| CORE | fast_snapshot | add `fresh:boolean` (CDP capture when `screenshot:true`) | 20 calls [R] |
| CORE | fast_text | as is | 4 [R], Aug [M] |
| CORE | fast_click | + `x:number, y:number` (trusted click; requires no `text`), `hover:boolean`, `button`, `clickCount`, `full`/`limit` for the returned snapshot | 28 [R] |
| CORE | fast_fill | + `fields:object` (fill_form semantics incl. per-field `{value,index,section}`), `focused:boolean` (insertText into focused el; `clear`, `force`), `verify` | 10 [R] |
| CORE | fast_select_option | as is | 2 (+1 batch) [R] |
| CORE | fast_key | `{key, modifiers?}`; no modifiers → DOM dispatch, modifiers → CDP | 4 as key_press [R] |
| CORE | fast_scroll | + `x,y` → wheel path; `deltaY` alias of `pixels` | 6 [R] |
| CORE | fast_wait | as is | 16 [R] |
| CORE | fast_nav | + `newTab:boolean`, `background`, `reload:boolean`, `waitFor:string` (text, default timeout 10s) | tab 10 + nav 2 [R] |
| CORE | fast_batch | as is | 3 [R], Aug [M] |
| CORE | fast_evaluate | as is; description says it may be disabled → use fast_text | 2 blocked [R], Aug used [M] |
| FOLD | fast_click_xy | fast_click `{x,y}` | Aug fumble [M]; 4 re-snapshots [R] |
| FOLD | fast_hover | fast_click `{text, hover:true}` | 0 use |
| FOLD | fast_fill_form | fast_fill `{fields}` | 1 batch use [R] |
| FOLD | fast_type | fast_fill `{value, focused:true, clear?, force?}` | 1 [R], Aug [M] |
| FOLD | fast_key_press | fast_key `{key}` | 4 [R] |
| FOLD | fast_wheel | fast_scroll `{x,y,pixels}` | 0 |
| FOLD | fast_tab | fast_nav `{url, newTab:true, background?}` | 10 [R] |
| FOLD | fast_reload | fast_nav `{reload:true, waitMs?}` | 0 |
| FOLD | fast_screenshot | fast_snapshot `{screenshot:true, fresh?, screenshotFormat}` | 1 [R] |
| FOLD | fast_point, fast_point_som | fast_locate `{target(s), mode:"vision"\|"som"}` (vision profile) | 0 |
| INTERNAL | fast_locate, fast_fill_vision, fast_do, fast_scout | `vision` profile only; scout hidden until re-benched (plan: Gemini untouched this pass) | 0 successful [R] |
| INTERNAL | fast_status, fast_profile, fast_prewarm | runner calls status once pre-run + profile pin (already does) + prewarm when vision profile on | 9/6 reflex calls [R] |
| INTERNAL | fast_list, fast_switch, fast_close | one `fast_tabs {list\|switch\|close}` for Claude callers; not offered to Grok | 0 |
| INTERNAL | fast_drag + fast_drag_xy → `fast_drag {…, trusted:true}` | Claude callers | 0 |
| INTERNAL | fast_upload, fast_console, fast_network, fast_network_replay | Claude Code dev use | 0 |
| INTERNAL | fast_vision_capture, fast_annotate_boxes, fast_marks | primitives behind locate | 0 |
| DROP | fast_macro_save/list/run/delete | fast_batch covers it; chrome.storage recipes referencing folded names would break anyway | 0 [R], absent [M] **[J]** |

**Grok sees (phase-3 shape): 11 FastLink + `ask_caller` + `report_done` = 13.**

### 3a. `fast-runner/toolset.phase2.json` — phase 2 (IMPLEMENTED; works with today's `runner.mjs`, no server change)

Folds cannot be expressed by `allow/rename/describe`, so phase 2 allows the raw tools that make up the core; the CDP companion `fast_click_xy` stays visible until the `fast_click{x,y}` fold lands (`fast_type` is left out: its only use was the react-select fumble [R]). 13 FastLink + 2 native = 15. `toolset.json` (all 45 + the server `instructions` essay) is untouched as the A/B baseline.

Selection is explicit per run, never ambient: `node fast-runner/cli.mjs --toolset phase2 …` · `grok_run{toolset:"phase2"}` · `FASTRUN_TOOLSET=phase2`; a bare name means `fast-runner/toolset.<name>.json`, a path is used as given. Every `runs.jsonl` row carries `toolset`. `node fast-runner/cli.mjs --toolset phase2 --dump-tools` prints exactly what Grok receives without touching a browser.

```json
{
  "allow": [
    "fast_snapshot", "fast_text", "fast_click", "fast_click_xy", "fast_fill",
    "fast_select_option", "fast_key_press", "fast_scroll", "fast_wait", "fast_tab", "fast_nav",
    "fast_batch", "fast_evaluate"
  ],
  "rename": {},
  "describe": { "<one entry per allowed tool — §4 text, see the file>": "" }
}
```
(`fast_key_press` not `fast_key` because Grok's 4 key uses had no modifiers and key_press needs no CDP [R]; phase 3 collapses both into `fast_key`.) On any non-default toolset the runner drops `client.instructions` from the system prompt — that essay is where "fast_scout can pre-read a page" and "call fast_status first" come from **[D:runner.mjs buildSystem, MCP instructions]**; the baseline prompt stays byte-identical.

### 3b. `no-cdp` profile (`fast-runner/toolset.no-cdp.json`, `--toolset no-cdp`; IMPLEMENTED)

For browsers without "Advanced control" (e.g. dad's laptop, tester installs): no tool that attaches `chrome.debugger`. 12 FastLink + 2 native = 14.

```json
{
  "allow": [
    "fast_snapshot", "fast_text", "fast_click", "fast_fill", "fast_fill_form",
    "fast_select_option", "fast_key_press", "fast_scroll", "fast_wait", "fast_tab", "fast_nav",
    "fast_batch"
  ],
  "rename": {},
  "describe": { "<same §4 text; fast_fill_form gets its own line>": "" }
}
```
Post-fold, the same profile is expressed by hiding the CDP args (`x,y`, `focused`, `fresh`, `modifiers`) via `describe`.

## 4. Grok-tuned descriptions (CORE, ≤ 2 sentences)

Today's descriptions are 80–200-word essays (`tools.js`); `fast_scout` says "PREFERRED … use this instead of fast_snapshot in most cases" and `fast_status` says "Call this first" → Grok called scout in 6/11 runs (0 payoff) and status first in 9/11 **[D:R,C]**.

| tool | description |
|---|---|
| fast_snapshot | Read the current page: interactive elements (text, label, live value, coords) plus readable content blocks. Pass `overlay:true` when an open menu's options are missing, `full:true` to lift the ~70-item cap, `screenshot:true` only to visually confirm. |
| fast_text | Return the page's innerText (or one element's via `selector`; `html:true` for outerHTML). Use for data extraction such as tables and lists; `maxLen` caps the size. |
| fast_click | Click the element whose text/label/placeholder matches `text` (narrow with `role`, `tag`, `index`). Returns a fresh snapshot, so do not call fast_snapshot right after; pass `x,y` instead of `text` only for canvas/iframe targets. |
| fast_fill | Set one field by label/placeholder/name (`match`, `value`; disambiguate with `index` or `section`), or many at once with `fields:{label:value}` (native selects included). Replaces the existing value and returns a fresh snapshot. |
| fast_select_option | Choose `option` in the dropdown labelled `field` (native, react-select, Angular, ARIA). Use `selections:{field:option}` to set several in one call. |
| fast_key | Press `key` (Enter, Escape, Tab, ArrowDown…) on the focused element; add `modifiers` (ctrl/shift/alt/meta) for chords. |
| fast_scroll | Scroll the page or the nearest scroll container: `to:"top"|"bottom"|"50%"` or `pixels` (negative = up). Returns a fresh snapshot. |
| fast_wait | Wait until `text` appears (default 5s) or, with `networkIdle:true`, until requests settle. Use only after an action that triggers async loading; returns the matched element and a snapshot. |
| fast_nav | Go to `url` in the current tab, or in a new one with `newTab:true`; waits for load and, if `waitFor` is given, for that text. `reload:true` reloads the current tab. |
| fast_batch | Run several tool calls in order in one round-trip (`actions:[{name,args}]`); stops at the first failure unless `continueOnError`. Use when the next steps are already certain. |
| fast_evaluate | Run a JS function (`fn`, optional `args`) in the page and return its JSON result. May be disabled for this browser; if so use fast_text or fast_snapshot instead. |

Phase-2 interim descriptions for the raw companions: `fast_click_xy` — "Trusted click at viewport CSS coords `x,y`; returns no snapshot. Only when fast_click cannot match the element (canvas, cross-origin iframe)." `fast_type` — "Type `text` into the focused element (click it first). `clear:true` replaces a default value." `fast_tab` — "Open `url` in a new tab and focus it." `fast_key_press` — as fast_key without the modifiers sentence.

## 5. Risks (phase 3 folds vs. claude.ai / Claude Code callers)

| risk | who breaks | mitigation |
|---|---|---|
| Folded names vanish (`fast_click_xy`, `fast_type`, `fast_tab`, `fast_key_press`, `fast_screenshot`…) | Claude Code sessions, claude.ai relay users, `fast_batch` recipes in memory/docs, MCP `instructions` text, `bench/suite.js` checkpoints, `docs/*` playbooks | Phase 2 touches only `fast-runner/toolset.json` (+ optional `toolset.no-cdp.json`) — `tools.js`, the relay mirror, the extension dispatch (`actions/index.js`) and every other caller are byte-identical. Phase 3 is a hard cutover: rename in `tools.js`, `fastlink-relay/tools.js`, `actions/index.js`, the instructions block, docs/bench in one commit; no alias names (replace, never layer) **[J]** |
| Saved macros in `chrome.storage.local` reference old step names | any profile with macros | DROP macros in phase 3 and purge the storage key in the extension update (0 observed use [R]) **[J]** |
| Relay `tools.js` drifts from local | claude.ai users see one shape, CLI another | keep the CLAUDE.md rule: edit both in the same commit; add a `bench` check that diffs the two name lists **[J]** |
| `fast_click {x,y}` on the no-cdp profile → CDP attach error | tester installs without Advanced control | `input.js` already degrades to a clear error when the flag is off **[D:C input.js:28-35]**; no-cdp profile hides the args |
| Hiding `fast_status`/`fast_prewarm` from Grok removes its "extension not connected" self-diagnosis | runner | runner already fails fast on connect + `fast_profile`; surface connection errors as tool errors so Grok reports them instead of probing (Aug: Grok stopped after 3 calls on an access error [M]) |
| Hiding the vision tier leaves Grok without a non-DOM path | cross-origin iframe forms (Apple, some GCP) | `fast_click {x,y}` + `fast_fill {focused:true}` + `fast_snapshot {screenshot:true}` remain; `vision` profile re-adds `fast_locate`/`fast_fill_vision`. Tonight's suite had no such page [R] |
| `fast_evaluate` blocked on relay by default | Grok wastes 1 call then falls back (2/2 tonight [R]) | description names the fallback; runner could pre-check the relay setting and hide the tool when `evalBlocked` **[J]** |

## 6. Re-bench gate (plan phase 2 exit)

Score ≥ 70/70, wall ≤ 259s, calls < 99 (grok.com Aug) and < 102 (runner tonight, first 8 cells, 366s incl. one 130s react-select cell) **[D:A,R]**. Expected savings from this triage alone: ~29 reflex/overhead calls of 135 (§0) ≈ 70s of Grok think at 2.5s/turn **[J]**.
