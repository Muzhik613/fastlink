# FastLink PRUNE PLAN (2026-09-16)

Owner's instruction: *"prune the fastlink files instead of building on top of the old stuff… trim it to
the very bare bones and build from there."*

**This pass is PLAN ONLY. Nothing is deleted. No code file is touched by this commit.**

Every claim below is tagged **[D]** (data-backed, source cited) or **[J]** (judgment). Where the
briefing's numbers and the data disagree, the data wins and the correction is stated.

---

## 0. The evidence, re-verified

I re-derived the usage numbers from the raw log rather than from `docs/TOOL_TRIAGE_DRAFT.md`, because
the draft's counts come from an 11-run slice and the log now holds 74 runs.

Source: `~/.local/state/fastrun/runs.jsonl` — **74 runs, 710 tool calls**, toolsets
`(default)` 13 / `default` 15 / `phase2` 46 **[D]**.

| claim as briefed | verdict | actual |
|---|---|---|
| 26 of 45 tools never called | **corrected ↓** | **24 of 45** never called. `fast_point` (1), `fast_do` (2), `fast_fill_vision` (2), `fast_screenshot` (2) have non-zero live use **[D]** |
| 19 hidden by phase2/no-cdp | **corrected ↑** | `toolset.phase2.json` allows **12** FastLink tools → **33 hidden**; `no-cdp` allows 11 → 34 hidden **[D]** |
| macros: zero uses ever | **confirmed exactly** | `fast_macro_save/list/run/delete` = **0 calls in 74 runs** **[D]** |
| scout never produced an executed plan | **confirmed** | `fast_scout` 14 calls, 0 plans executed **[D:R + draft §0]** |
| every description exists twice | **understated** | tool names are duplicated across **7+ sites** (below) **[D]** |
| page.js ~4k lines, home of every recent bug | **confirmed** | 4,099 lines at time of writing, and moving **[D]** |

Per-tool, all 710 calls **[D]**:

| tool | calls | errors | runs used in |
|---|---:|---:|---:|
| fast_snapshot | 154 | 0 | 65 |
| fast_click | 121 | 15 | 45 |
| fast_fill | 91 | 7 | 31 |
| fast_tab | 73 | 2 | 72 |
| fast_wait | 69 | 4 | 38 |
| fast_text | 44 | 1 | 26 |
| fast_select_option | 31 | 14 | 25 |
| fast_status | 18 | 0 | 18 |
| fast_scroll | 17 | 0 | 10 |
| fast_batch | 15 | 0 | 10 |
| fast_scout | 14 | 0 | 14 |
| fast_prewarm | 13 | 0 | 13 |
| fast_evaluate | 12 | **11** | 12 |
| fast_click_xy | 11 | 0 | 4 |
| fast_key_press | 8 | 0 | 8 |
| fast_nav | 7 | 0 | 7 |
| fast_type | 4 | 1 | 3 |
| fast_screenshot / fast_do / fast_fill_vision | 2 each | 0 | 2 each |
| fast_fill_form / fast_point | 1 each | 0 | 1 each |
| **everything else (24 tools)** | **0** | — | — |

**The duplication is worse than "twice".** Distinct `fast_*` names per file **[D]**:
`fast-dxt/server/tools.js` 47 · `fastlink-relay/tools.js` 46 · `fast-dxt/manifest.json` (the `.mcpb`)
45 · `fastlink-relay/src/mcp.js` 39 · `fast-ext/src/actions/index.js` 36 · `fast-ext/src/overlay.js`
36 · `fast-ext/sidepanel.js` 33 · `fast-dxt/server/handlers.js` 33 · `fast-ext/background.js` 29 ·
`fastlink-relay/src/composite.js` 17. Adding a tool means touching up to ten files; removing one, the
same. The MCP `instructions` essay is an **eleventh** copy of the tool doctrine
(`transports.js:13-29`, 3,001 chars; `relay/src/mcp.js:29-45`, 3,014 chars).

**Cost metric note:** `tools.js` is 567 lines but **62,643 characters** — each description is one very
long line. For the tool surface, *chars shipped per turn* is the real cost, not lines. The four
largest are `fast_click` 4,891 · `fast_snapshot` 4,435 · `fast_select_option` 4,282 · `fast_fill`
3,803 **[D]**.

---

## 1. KEEP — the minimal tool surface the data supports

The briefing asked me to start from the triage draft's proposed core and argue each change from
evidence. The strongest available evidence is that **the keep list already exists and already
passed**: `toolset.phase2.json` is exactly 12 FastLink tools, and on the six-cell bench it scored
**59/59 in 28 calls / 52.8s** (`docs/GROK_RUNNER_BENCH_hvm_selectfix_2026-09-15.md:26`) **[D]**.
46 of the 74 logged runs are phase2 **[D]**. This is not a proposal; it is the measured working set.

| KEEP | calls | why it survives |
|---|---:|---|
| `fast_snapshot` | 154 / 65 runs | the read. Every run's spine **[D]** |
| `fast_click` | 121 / 45 runs | the act **[D]** |
| `fast_fill` | 91 / 31 runs | absorbed `fast_fill_form` already (2026-09-15) **[D]** |
| `fast_nav` (+`fast_tab` folded) | 7 + 73 | `fast_tab` is in **72 of 74 runs** — the single most universal call **[D]** |
| `fast_wait` | 69 / 38 runs | **[D]** |
| `fast_text` | 44 / 26 runs | the extraction path; the ONLY tool that reads a control's live value since 2026-09-15 **[D]** |
| `fast_select_option` | 31 / 25 runs | highest error rate of any kept tool (14/31) — kept because dropdowns are unavoidable, not because it is healthy **[D]** |
| `fast_scroll` | 17 / 10 runs | **[D]** |
| `fast_batch` | 15 / 10 runs | the round-trip amortizer; batch is the default form path since 2026-09-15 **[D]** |
| `fast_key_press` | 8 / 8 runs | **[D]** |

**Additions to the draft's core, argued from evidence:**

- **`fast_click_xy` — ADD.** The draft folds it away. Keep it (as its own tool or as `fast_click
  {x,y}`): 11 calls **[D]**, and the holdout record shows it is the *only* tool that reaches four
  whole widget families — a Wunderbaum virtualized row, an EJ2 grid row, the National Rail combobox,
  and the Azure cross-origin blade (`docs/GROK_RUNNER_HOLDOUT2_2026-09-15.md` §"done by hand", every
  row) **[D]**. Deleting it removes FastLink's only escape hatch from the DOM.
- **`fast_type` — KEEP (fold into `fast_fill {focused:true}`).** Only 4 calls **[D]**, but it is the
  cross-origin write path (`fast_fill` cannot reach into an opaque iframe), it is the subject of two
  CHANGELOG entries from the last 24 hours, and it has the single best test file in the repo
  (`type-guard.test.mjs`, 11 tests) **[D]**.

**Removals from the draft's core:**

- **`fast_evaluate` — REMOVE from the model-facing surface, KEEP the implementation.** 12 calls, **11
  errors** **[D]** — a 92% failure rate. `toolset.phase2.json:2` already records it was dropped
  because "11/32 cells wasted a call on it", and phase2 then scored 59/59 without it **[D]**. But see
  §3: it cannot be deleted, because the bench scorer *is* `fast_evaluate`.

**Model-facing total: 11 tools** (the 10 above + `fast_click_xy`), with `fast_tab`/`fast_reload`
folded into `fast_nav` and `fast_type` into `fast_fill`. Down from 45.

---

## 2. DELETE

### Tier A — dead code: nothing calls it, no contract needs it

| item | evidence | lines |
|---|---|---:|
| `fast_macro_save/list/run/delete` | **0 calls in 74 runs** **[D]**; `macros.js` 64 lines; 4 schemas ×2 files (1,892 chars); purge `fb_macro_*` from `chrome.storage` (already on the box-10 strip list) | **~158** |
| `walkSubtree` (`page.js:628-656`) | **defined, never called** — zero references in `page.js` or anywhere in `fast-ext/src`; superseded by `stepInitWalk`/`stepCursor` **[D]** | **29** |
| `fast-ext/dist/staging/` | stale build output from **2026-06-08** (its `page.js` is 1,399 lines vs 4,099 today); gitignored, so `rm -rf` with no commit **[D]** | ~3,000 (disk) |
| `fast_network_replay` | 0 calls **[D]** + live security liability (§below) | ~59 |
| `fast_console` + `fast_network` | 0 calls each **[D]**. Also deletes two MAIN/ISOLATED-world content scripts that wrap `console` and `fetch` on **every page load** (`consoleHook.js` 39, `networkHook.js` 123, `buffers.js` 80, listeners 11) | ~378 |
| `fast_hover` (28) · `fast_drag` (42) · `fast_drag_xy` (29) · `fast_wheel` (12) · `fast_key` (34) | 0 calls each **[D]**. `fast_key_press` is the one that gets used (8 calls) | ~145 |
| `fast_upload` | 0 calls **[D]**; `upload.js` 165 + server `wslpath` resolver 62. Box-10 review: "`fast_upload` wslpath fails every call in-container" — it is WSL-only by construction | ~227 |
| `fast_marks` + `fast_vision_capture` + `fast_annotate_boxes` | 0 calls each **[D]**; see Tier B (they are the SoM tier) | counted in B |

**Tier A total ≈ 1,000 lines of code + ~3,000 lines of stale staging.**

### Tier B — subsystems whose value is unproven: the Gemini tier

Total tier ≈ **3,300 lines** (`fast-dxt/server/scout.js` 855, `fastlink-relay/src/scout.js` 497,
`fastlink-relay/src/composite.js` 597, ~1,000 of `handlers.js`, `fast-ext/src/actions/vision.js` 156,
`marks.js` 121, `config.js:41-81`) plus 9 tool schemas ≈ 12,400 chars **in each** `tools.js` **[D]**.

Being unflinching about it, as asked:

**DELETE — the scout/plan half. It has never worked.**

`fast_scout` was called 14 times live and produced **zero executed plans**; every live scout was
followed by a full `fast_snapshot` or a failed batch **[D:R, draft §0]**. Worse, it is not passive:
`fast-dxt/server/index.js:13-18` fires `prewarmScout` **and** `prewarmVision` on **every `navigated`
event**, so the tier bills Gemini calls on page loads nobody asked for **[D]**.

| delete | lines |
|---|---:|
| `scout.js`: `scout`, `getPageMap`, `buildPageMap`, `overlayIntent`, `normalizeSteps`, `slimDigest`, `capItems`, `digestHash`, `slimMacros`, `warm`, `callModel`, `locateByImage` | ~215 |
| `handlers.js`: `handleScout`, `visionScoutRead`, `screenshotRung`, `scoutSnapshot`, `currentUrl` | 200 |
| prewarm: `prewarmScout`, `prewarmVision`, `runVisionWarm`, warm getters + the `index.js` nav hooks | ~118 |
| `fast_do`: `planByImage` (60) + `handleDo` (120) — 2 calls, and the log notes it "did not finish the task" **[D]** | 180 |
| `fast_point_som`: `boxByImage` (38) + `pickMarks` (28) + `handlePointSom` (63) + `annotateBoxes` (40) + `marks.js` (121) — 0 calls | 290 |
| `fast_locate`: `handleLocate` + `pickLocateWinner` + `matchItem` + `domLocate` — 0 calls. (The `fast_locate` mentions in `bench/suite.js` are **prose in a comment**, not calls — verified) | 156 |
| `fastlink-relay/src/scout.js` + the scout/do/som/locate half of `composite.js` | ~700 |
| 7 tool schemas ×2 files | ~9,000 chars |

**Tier B deletable ≈ 1,900–2,100 lines.**

**KEEP — precisely this much, and no more.**

`fast_point` and `fast_fill_vision` **did work on the cross-origin Azure case** and on the jQuery-UI
datepicker holdout, and nothing else can reach a cross-origin blade **[D:HOLDOUT, CHANGELOG
2026-09-16]**. What they need:

- Server: `handlePoint`, `handleFillVision`, **`pointOnce` (142 lines — the shared engine)**,
  `refinePoint`, `captureForVision`, `domFillFallback`, `verifyVisionFills` ≈ **600 lines**
- `scout.js`: **`pointByImage` only** (77), plus the shared transport/fallback plumbing
  `httpsPostJson`, `withRetry`, `callModelParts`, `exhaustedMessage`, `callGemini`,
  `callOpenRouterModel`, `safeJson`, `prune` ≈ **380 lines**
- Extension: `vision.js` `visionCapture` + shared capture ≈ **94 lines**

**Survival cost of the cross-origin capability: ~1,074 lines.** That is the honest price; the other
~2,100 goes.

**The visual-note checker has already moved to grok-4.6 — do not delete its inputs.**
`runner.mjs:547` sets `NOTE_MODEL = 'grok-4.6'` and the default path `describeWithGrok` goes through
`xai.mjs`, **not** Gemini **[D]**. But it still imports **`observationPrompt`, `plainObservations`,
`safeJson`** from `scout.js` — the prompt text and parser, not the model call. **Move those three out
of `scout.js` before touching it**, or the runner's visual note breaks. `describeScreen` itself (23
lines) is now reachable only via `FASTRUN_NOTE_MODEL=gemini` — but it is covered by 5 tests and is
being actively edited right now, so it is a **landmine, not a delete** (§6).

### Tier C — legacy trees

| tree | tracked files | size | action |
|---|---:|---:|---|
| `fastlink-cloud-mcp/` | **0** (gitignored) | 3.7M / 62 files | `rm -rf` — **no commit needed** |
| `fast-ext-dad/` | **0** (gitignored) | 1.5M / 113 files | `rm -rf` — **but confirm with owner first** (see §6) |
| `fastlink-proxy/` | 4 | 632K | delete + commit; superseded by `fastlink-relay/` per CLAUDE.md |
| `fastlink-site/` | 7 | 84K | **flag only** — a marketing site the owner never mentioned; not mine to remove |

**Tier C ≈ 5.8M / ~35,000 lines**, of which only ~18,000 lines (4 files) are even in git.

Also update `README.md:33-44`, which still carries a "Repo-tidiness recommendation (not performed)"
for exactly these three trees.

---

## 3. KEEP-BUT-MOVE — survives because a contract needs it

**These nearly got deleted for having zero model calls. Each one is load-bearing.**

| item | 0 model calls, but… | where it belongs |
|---|---|---|
| **`fast_evaluate`** | **`bench/score.js` IS `fast_evaluate`.** Its header: "Live DOM read back through the LOCAL FastLink connector after the run (fast_evaluate / fast_list)". Every `live` checkpoint in the suite is scored through it **[D]**. Delete it and the entire benchmark loses its measurement instrument | keep implemented; **hide from every model toolset** (phase2 already does); add the local eval gate it lacks (§7) |
| **`fast_list`** | `bench/monitor.js`, `run.js`, `score.js` — carries the passive **URL trail** used to score "passed through page X"; `trail.test.mjs` covers it **[D]** | harness-only |
| **`fast_switch`, `fast_close`** | `bench/fastlink.js` reset path — closes tabs and clears aa.com's `localStorage` between cells **[D]** | harness-only |
| **`fast_status`, `fast_profile`** | 18 calls, all runner/harness. The broker **refuses unpinned calls** when >1 profile is connected (8498cbe), so the pin is mandatory; `scripts/ship-ext.sh` calls both **[D]** | internal ops, never offered to the model |
| **`fast_ext_reload`** | `scripts/ship-ext.sh` step 3; the **only tool with real dispatch test coverage** (`broker.test.mjs:92`) **[D]** | broker-internal; stays absent from the relay mirror **by design** |
| **`fast_screenshot`** | the runner's visual note takes one screenshot per triggering run **[D]** | internal |
| **`no-cdp` profile** | box-10's `toolProfile` hypothesis rides on it; `toolset.test.mjs` asserts it contains no `chrome.debugger` tool **[D]** | keep as-is; it is the container's tool contract |
| **`batch.js` ↔ relay mirror** | the two files are **byte-identical and a test enforces it** (`batch.test.mjs`) **[D]** | keep both, keep the test |
| **box-10 container needs** | per `docs/BOX10_FASTLINK_REVIEW_2026-09-15.md`: managed-storage config reader, `:8080` HTTP shim, action log, stop latch, tool-profile allowlist enforced server **and** ext side, base64 results, no tunnel / no relay dial / no auto-update / no idle-exit | these are **additions**, not survivals — pruning must not remove the seams they hook into (`handlers.js:100 dispatchCall`, `actions/index.js` dispatcher) |

**The `tools.js` duplication — the actual fix.** The two files differ by exactly **9 lines in 3
hunks**: `fast_ext_reload` (dxt-only, correct) and `fast_upload`'s description + `path` param
(**deliberately divergent** — dxt promises native-WSL path resolution the Worker cannot do) **[D]**.
So "keep them byte-identical by hand" was never true and must not become the fix. Replace the hand-sync
with **one source of truth plus an explicit divergence map**: `tools.js` generates the relay mirror and
the `.mcpb` manifest, with `fast_ext_reload` excluded and `fast_upload` overridden. A naive
"make them identical" generator would silently break the relay's upload contract.

---

## 4. THE SPLIT of `page.js`

**The constraint that governs everything here** (verified, and it invalidates the obvious approach):
`page.js` is injected into the target tab's **MAIN world as a manifest content script**, declares
*"MUST stay self-contained — no imports, no closures from outside this file"*, has **zero exports**,
and its only contract is `window.__fastlink.run` (`page.js:1-16, 4065`) **[D]**. There is **no bundler
anywhere in the repo** — `fast-ext/scripts/package.sh` is a plain allowlist copy-and-zip, and
`dist/staging` is a stale copy, not a build **[D]**.

**But the split needs no build step.** `manifest.json` already loads three MAIN-world files in order
(`consoleHook.js`, `networkHook.js`, `page.js`) into one shared global scope **[D]**. Ordered plain
scripts share globals natively. The cost: `MAIN_WORLD_FILES` is duplicated in **two** places
(`src/actions/index.js:187`, `src/actions/tab.js:29`) and both must list every part **in order**, or
the stale-content-script re-injection path silently loads a partial `page.js`.

Seams, in dependency order (line counts are a snapshot — see §6, the file is being edited live):

| # | new file | contents | lines | depends on |
|---|---|---|---:|---|
| P1 | `page-index.js` | `SELECTOR`/consts, visibility+geometry leaves, `labelFor`, `walkDeep`/`offsetFor`, `INDEX`, entry construction, chunked init walk, scheduler, MutationObserver + storm guards | **~1,000** | nothing |
| P2 | `page-snapshot.js` | `collectOverlayEls`, `serializeSnapshot` (203), cap/hint layer (`rankItemScore`…`frontload`), `withSnap` result envelope | **~510** | P1 |
| P3 | `page-resolve.js` | **the name-resolution tier**: match/score, section resolution, row scoping, label maps, candidate lists, ambiguity refusals, `diagnoseNoMatch` | **~1,064** | P1, P2 |
| P4 | `page-combobox.js` | autocomplete + ARIA/react-select open chains, option sweeping, read-back | **~440** | P1 |
| P5 | `page-actions.js` | the ten `if (action === …)` blocks + `runPageAction` shell and self-install | **~1,085** | all |

**Cut P1 and P2 first** — they have no upward dependency on anything inside `runPageAction`, so the
move is mechanical and byte-verifiable. Then P4 (self-contained mechanics). **Do not modularize P3
until the id-first question is settled** — most of it is about to become deletable, and moving 1,064
lines into a new file only to delete them is wasted motion.

The largest single blocks today: `fast_select_option` **592**, `fast_fill` **269**, `fast_wait`
**233**, `fast_click` **223** **[D]**. `runPageAction` alone is 2,566 lines — **63% of the file in one
function**.

---

## 5. THE ORDER of operations

Verification gates available at every step **[D]**:

- `cd fast-runner && npm test` → **79 tests** across 13 files (gate 19, type-guard 11, visual-note 11,
  toolset 7, text-controls 6, batch 5, holdout-replay 4, select-perf 4, fill-ambiguity 4,
  fill-miss-hint 3, aria-options 2, trail 2, score-report 1). This is the "79/79".
- `cd fast-dxt && npm test` → **11 tests** (broker 6, describe-screen 5).
- Six-cell bench: `node bench/run.js --client grok_runner --transport local --install primary
  --toolset phase2 --test <id>` over `multipage, staticform, overlay, extract, flightsearch, mapsdir`.
  Last clean: **59/59, 28 calls, 52.8s** (the briefing said 50.8s; the doc of record says 52.8s).

| # | step | gate |
|---|---|---|
| 0 | **Baseline.** Both suites + the six-cell bench, recorded. Nothing deleted | 79/79 · 11/11 · 59/59 |
| 1 | **Tier C legacy trees.** `fastlink-cloud-mcp/`, `fastlink-proxy/` (+`fast-ext-dad/` if confirmed). Update `README.md` | tests only — no runtime path touches these |
| 2 | **Tier A dead code**, one commit per family: macros → `walkSubtree` + `dist/staging` → network_replay → console/network → hover/drag/wheel/key → upload | tests + **bench after each** |
| 3 | **Single source of truth for tool schemas.** Generate the relay mirror + `.mcpb` manifest from `tools.js` with an explicit divergence map (`fast_ext_reload` excluded, `fast_upload` overridden) | `toolset.test.mjs`, `batch.test.mjs` byte-identity, + bench |
| 4 | **Gemini tier.** (a) move `observationPrompt`/`plainObservations`/`safeJson` out of `scout.js` **first**; (b) delete scout/do/point_som/locate/marks/vision_capture/annotate_boxes; (c) keep `pointOnce` + `pointByImage` + transport for point/fill_vision; (d) delete the `index.js` nav prewarm hooks | tests + bench + **one manual cross-origin check that `fast_point`/`fast_fill_vision` still reach an opaque iframe** |
| 5 | **The `instructions` essay** (`transports.js:13-29` + relay mirror) — must die in the *same commit* as step 4, or the model keeps being told to call `fast_scout` | bench (watch for calls to now-missing tools) |
| 6 | **page.js split P1 + P2**, then P4. Mechanical only — no behavior change. Update `MAIN_WORLD_FILES` in both places + `manifest.json` | tests + bench; a diff of `serializeSnapshot` output on a fixed page should be **byte-identical** |
| 7 | **ID-FIRST targeting** (separate project, after the split) | new tests + bench |

Steps 1–3 are independent of each other. Step 4 depends on 4a. Step 6 should not start until 2 is
done, or the split has to be re-done around deleted blocks.

---

## 6. WHAT I WOULD NOT TOUCH

**Live-fire hazards (right now, this session):**

- **`fast-ext/src/actions/*` and `fast-runner/runner.mjs` are being edited by two other agents.**
  `page.js` moved 4066→4099, `input.js` 377→400, `scout.js` 866→855, `runner.mjs` 877→923 *during*
  this analysis. **Every line number in §4 is a snapshot, not a coordinate** — re-derive at execution
  time.
- **The visual-note / `describeScreen` path.** Three CHANGELOG entries in the last 24 hours, an agent
  editing it now. Leave it entirely this pass.
- **`bench/tool-usage.md`** — generated per machine; never commit it.

**CHANGELOG landmines — each says "watch out" or "do NOT", and a prune could plausibly trip it:**

1. **`waitForUrlCommit` must NOT be merged with `waitForComplete()`** (2026-08-06) — "Do not
   'simplify' the two into one." A dedup pass would do exactly this; it would burn the full timeout on
   every `fast_tab`.
2. **Do NOT re-add `el.value` to `makeClickEntry`'s text chain**; `refreshLiveEntry()` must stay the
   single derivation point (2026-08-06) — that cache *is* the stale-value bug.
3. **Do NOT reintroduce a silent fallback when a section fails to resolve** (2026-08-06) — silent
   wrong-field writes are worse than errors.
4. **Do NOT reintroduce most-recent-wins as a routing fallback** (2026-08-06) — it survives only
   inside the explicit `auto` branch.
5. **`walkDeep`: keep BOTH budget checks** (in-root *and* between-roots) (2026-09-16) — with only the
   latter, one 400k-node root is walked to completion and the guard never fires.
6. **`walkDeep` offsets stay opt-in**; any caller needing frame coords must pass `{offsets:true}`
   (2026-09-16).
7. **`toControls`: keep the `blocked` set** (2026-09-16) — without it the candidate count regresses
   5001→10001.
8. **THE GCP FIX — "Do not re-litigate this"** (2026-09-16). The per-iframe forced synchronous layout
   was the entire 45s; confirmed 6/6 five consecutive times including on stock timeouts.
9. **`clear:true` must never select-all the page** (2026-09-16) — "If a future change re-allows an
   unfocused select-all 'just for force mode', this bug is back."
10. **`fast_select_option`: react-select keeps its own mousedown open path**, and `Enter` is
    deliberately not sent to a trigger already reporting expanded (2026-09-15).
11. **Ambiguity refusals are deliberate, not bugs** — a label matching 2+ fields is refused, not
    written (2026-09-15). A "simplify the error paths" pass would undo the entire holdout fix series.
12. **`ROW_SCAN_NODES` / `fieldVisible` bounds are deliberate** (2026-09-15); don't generalize
    `fieldVisible` or hidden inputs become fill targets.
13. **`fast_locate scroll:true` stays opt-in** (2026-07-11) — though the tool itself is a Tier-B delete.
14. **The release channel is the ONLY way to ship to self-hosted installs; never resurrect a
    local-file channel** (2026-07-12). So `release/` and the `scripts/install-tester*` /
    `pull-extension*` / `update-extension-git*` family **stay** — Alex's laptop updates through them.
15. **`fast_ext_reload` is deliberately absent from the relay mirror**, and **`fast_upload`'s two
    descriptions are deliberately divergent** (2026-09-15) — the byte-identical rule has two sanctioned
    exceptions. Step 3 must encode them, not erase them.
16. **`fast_fill_form` no longer exists** but `STEP_RENAMES` in both `batch.js` files still rewrites
    it — keep that alias while any doc, memory or saved batch names it.
17. **`fast-ext-dad/`** — CLAUDE.md calls it "a physical 2nd-profile copy". If a second Chrome profile
    loads it **unpacked from this path**, deleting it breaks that profile. Gitignored, so git cannot
    restore it. **Owner must confirm before this one is removed.**

---

## 7. RISK — what breaks if I am wrong, and how it surfaces

| deletion | if I am wrong | detected by |
|---|---|---|
| macros | a saved `fb_macro_*` recipe somewhere replays | nothing — **no test covers macros**. Mitigation: 0 calls in 74 runs is strong; purge the storage key in the same change |
| `walkSubtree` | it was reachable by a path the scan missed | `select-perf`, `fill-ambiguity`, `aria-options` (all slice `page.js` under jsdom) + bench |
| `fast_network_replay` / console / network | a debugging workflow the owner uses by hand | **nothing** — untested, unbenched. Judgment call; reversible from git |
| hover / drag / wheel / key / upload | a Claude Code session (not the runner) uses them | **nothing.** These are absent from the runner's toolsets, so bench cannot see them. **This is the least-covered deletion in the plan [J]** |
| `fast_evaluate` (if deleted rather than hidden) | **every bench checkpoint stops scoring** | immediately: the six-cell bench goes to ~0/59. This is why it is KEEP-BUT-MOVE |
| `fast_list` / `switch` / `close` | bench reset and URL-trail scoring break | `trail.test.mjs` + a bench run that mis-scores `multipage` |
| Gemini scout half | a page needs a pre-read | bench (six cells + both holdout suites). **No test covers any of it** — ~1,000 lines of `handlers.js` and every scout model function have **zero coverage** |
| `fast_point` / `fast_fill_vision` (if over-deleted) | **the Azure cross-origin case becomes unreachable** — no tool can read or write into an opaque blade | **nothing automated.** Requires the manual cross-origin check in step 4 |
| `observationPrompt`/`plainObservations` (if deleted with `scout.js`) | the runner's visual note dies | `visual-note.test.mjs` (11 tests) + `describe-screen.test.mjs` (5) |
| relay mirror generation | relay users get a shape CLI users don't | `batch.test.mjs` byte-identity assert; `toolset.test.mjs`. **The relay has no other tests at all** |
| page.js split | a part loads out of order / re-injection loads a partial file | `select-perf`, `fill-ambiguity`, `fill-miss-hint`, `aria-options`, `text-controls` + bench. The re-injection path is the risky one: it only fires on a *stale* content script, which the bench may not hit — **test it deliberately** |
| legacy trees | `fast-ext-dad/` is a live unpacked extension | a second Chrome profile stops connecting; **gitignored, so unrecoverable** — hence the confirmation gate |

**Coverage reality check:** of the 45 tools, only `fast_fill`, `fast_select_option`, `fast_text`,
`fast_type`/`fast_key`, `fast_batch` and `fast_ext_reload` have real tests. `fast_click`,
`fast_snapshot` and `fast_wait` are exercised only indirectly through fake-extension batch tests. The
entire Gemini tier, the whole relay, and `broker/tunnel.js` are **untested** **[D]**. **The six-cell
bench, not the unit suite, is the real regression gate for most of this plan** — which is why it runs
after every destructive step.

### Security items found en route (not deletions — live liabilities)

1. **`fast_evaluate` has no local gate at all.** The relay checks `checkEvalAllowed` and defaults to
   OFF (`relay/src/mcp.js:319-324`); the local broker path has **no eval policy whatsoever**
   (`handlers.js:114-148`). Both routes reach cookies/localStorage — CDP `Runtime.evaluate` with
   `userGesture:true`, or `(0, eval)(...)` in the MAIN world (`evaluate.js:16-54`) **[D]**.
2. **`fast_network_replay` refetches with `credentials:'include'`**, caller-supplied headers and body,
   and returns **all response headers + the body** to the model (`page.js:3752-3780`). Ungated locally
   **[D]**.
3. **The cloudflared tunnel spawns on mere file existence — confirmed exactly as briefed.**
   `broker/tunnel.js:17-23`: not-already-running + default port (9870) + `~/.cloudflared/config.yml`
   exists → `spawn('cloudflared', …)`. **No env flag, no consent, no `--tunnel` argument — and no
   check that the HTTP transport is even enabled**, though `HTTP_ENABLED` requires an explicit
   `--http` **[D]**. It is called unconditionally at `broker/index.js:11`. Box-10 requires it absent.

---

## 8. DESIGN ANSWER: how much dies under ID-FIRST targeting

**Short answer: ~1,020 lines become dead weight, not fallback. That is 25% of `page.js` and 40% of
`runPageAction`.**

**The key finding: the id-first plumbing already exists.** `INDEX.byId` is a `Map<number, Element>`
and `elById` is a single Map get (`page.js:390, 1497`). Ids are already stable across
re-classification ("Stable id across re-classifications of the same element", `indexElement`). Every
act path **already funnels through `elById` internally** — `fast_click` resolves a name to `m.i` then
calls `elById(m.i)`; `fast_fill` does `elById(it.i)`. **Nothing today passes an id in**: the only
targeting args anywhere are `text`, `match`, `field`, `index`, `section`/`near`, `role`, `tag`
**[D]**.

So id-first is an **entry-point change, not a rewrite**. Its value is entirely in what it lets you
delete:

| bucket | lines | survives to BUILD the index? | survives as stale-id fallback? |
|---|---:|---|---|
| **Ambiguity detection & refusal** — candidate arrays, `diagnoseNoMatch`, every "N fields match — nothing was filled" path, `enrichMiss`, miss reports | **412** | no | no — an id cannot be ambiguous |
| **Section/row scoping** — `resolveSection`, `rowContextOf`, `computeRowContext`, `fieldsWithin`, `applySectionScope` | **236** | no | no — `section:`/`index:` exist only to disambiguate names |
| **Candidate scanning/scoring** — `matchScore`, `matchItems`, `isFillable`, `pickByText`, `pointerTargetByText` | **173** | no | **partly — keep ~32** |
| **Select-option name resolution** — `findFields`, `listCands`, `dropdownCandidates`, `widgetFor`, `queryAllDeep` | **173** | no | only the name/id fast path (~6) |
| **`toControls`** (the O(n²) one) | **32** | no | no — its job is collapsing a multi-candidate name match |
| **`containerLabel`** (the label storm) | **38** | no — all 6 call sites are act-time | no |
| **total act-time name resolution** | **1,064** | — | **~40 survive** |

**~1,020 lines are genuine dead weight.**

Two corrections to the framing in the brief:

- **`walkDeep` and the iframe layout are NOT name-resolution machinery** and do not die. `walkDeep`
  (54) + `offsetFor` (17) + the iframe branches (~90 total) are **index construction** — `walkDeep`
  feeds `collectOverlayEls` which feeds `serializeSnapshot`, and `offsetFor` supplies per-iframe
  geometry for every emitted item. They survive in full. So does `labelFor` (43), called by
  `makeClickEntry` at **index-build** time. Only `containerLabel` (act-time only) dies.
- **`fast_select_option` does not collapse.** ~440 of its 592 lines are **actuation** — react-select
  detection, the ARIA open chain, option sweeping, read-back — which id-first does not shrink at all.
  It goes 592 → ~400, not to zero.

The biggest single win is the **ambiguity/refusal tier (412 lines)**, and there is an irony worth
stating plainly: that tier is the *entire output of the last two days of holdout fixes* — repeated-row
refusals, candidate lists, section hints. It is excellent work that exists solely to compensate for
names being ambiguous. **Id-first does not fix those bugs; it deletes the conditions that cause
them.** Which is exactly the owner's point about pruning rather than building on top.

**Recommendation [J]:** land the split (§4, steps 6) and id-first (step 7) **together but in that
order** — P1/P2 first so the index engine is isolated and testable, then id-first, which turns P3 from
a 1,064-line module into a ~40-line fallback. Do **not** invest in refactoring P3 beforehand.

---

## Open questions for the owner

1. **`fast-ext-dad/`** — does a Chrome profile still load it unpacked from this path? It is
   gitignored; deletion is unrecoverable.
2. **`fastlink-site/`** — keep, or out with the legacy trees?
3. **`fast_evaluate`** — confirm: keep implemented for the bench scorer + Claude Code dev use, hidden
   from every model toolset, with a local gate added? (Deleting it outright would blind the benchmark.)
4. **Tester install channel** (`release/`, `scripts/install-tester*`, `pull-extension*`) — are there
   still self-hosted installs (Alex's laptop) depending on it? If not, that is another ~60KB of
   scripts and the `updates.xml` channel.
5. **`fast_upload`** — 0 calls and WSL-only, but it was a direct user request in 2026-07-07. Delete,
   or keep as a dev-only internal?
