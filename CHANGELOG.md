# FastLink CHANGELOG

Running log of every deliberate change to FastLink, newest first. The point is to
**stop the fix→break→refix churn**: before touching something, skim this file to see
what a prior change already fixed, so we don't reintroduce a bug we already solved.

**Format for each entry**

```
## YYYY-MM-DD — <short title>
- **What:** the change, in one or two lines.
- **Why:** the symptom / feedback that prompted it.
- **Files:** the files touched.
- **Watch out:** what this could regress / interacts with (so a future change doesn't undo it).
- **Status:** in code / synced to Windows copy / committed / verified live.
```

Extension changes only take effect after **syncing `fast-ext/` → `C:\Users\yjtur\FastLink\extension\` and reloading at `chrome://extensions`**. Server changes need a Claude Code restart (WSL MCP) or `.mcpb` rebuild (Desktop). Relay changes need `wrangler deploy`.

---

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
