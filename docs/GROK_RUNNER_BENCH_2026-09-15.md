# Grok runner bench — 2026-09-15 (plan phase 1)

`fast-runner` drives the 8-test FastLink suite over the relay (`relay.ytx.app`, browser `yaakovschrome`, grokcode proxy :8790, effort `low`), submitted by `bench/run.js --client grok_runner --browser yaakovschrome [--toolset phase2]` (+ `FASTRUN_MODEL=grok-4.3` for pass 3). Scoring is unchanged: live page state read back through the LOCAL broker, never the model's claim. Baseline = the 2026-08-06 grok.com-via-relay row per test (70/70, 259.3s wall, 99 calls).

Passes (3-way, per the lead's final plan):

| pass | label | toolset | model | what Grok sees |
|---|---|---|---|---|
| 1 | `d1` (+ `d2`, an extra default run left over from the earlier n=3 plan) | `default` | grok-4.6 | all 45 tools + the server's instructions essay — what grok.com saw on 08-06 |
| 2 | `p1` | `phase2` (`fast-runner/toolset.phase2.json`) | grok-4.6 | 13 raw tools + ask_caller/report_done, 2-sentence descriptions, no essay |
| 3 | `q1` | `phase2` + terse `report_done` (a9a1cd0) | grok-4.3 | same tools, faster model |

Every cell resets before it runs (`reset.closeUrlPatterns` + aa.com `clearStorage`), so nothing is inherited between passes. Raw rows: `bench/results.jsonl` (`client:"grok_runner"`, `toolset` + `model` per row), tool logs: `bench/tool-usage.jsonl` + `~/.local/state/fastrun/runs.jsonl` (gitignored — measurements, not source).

## Headline

| pass | toolset / model | score | wall | model time | calls | reflex calls | valid | overclaims |
|---|---|---:|---:|---:|---:|---:|---|---:|
| baseline grok.com via relay (08-06) | site / grok | 70/70 | 259.3s | — | 99 | — | 8/8 | 0 |
| 1 `d1` | default / 4.6 | 70/70 | 428.2s | 376.6s* | 110 | 16 | 8/8 | 0 |
| 1 `d2` (extra) | default / 4.6 | 70/70 | 401.7s | 373.4s* | 100 | 16 | 8/8 | 0 |
| 2 `p1` | phase2 / 4.6 | 70/70 | 414.5s | 419.0s | 91 | 0 | 8/8 | 0 |
| 3 `q1` | phase2 / 4.3 | **56/70** | 55.3s | 264.1s | 50 | 0 | 8/8 | **4** |

- **wall** = thinking + action between the first and last FastLink call (the run store's tool log; same definition as the baseline rows).
- **model time** = Σ `turns[].latencyMs` — every model turn including the opening turn before the first tool call and the `report_done` turn after the last, so it can exceed wall. `*` = gap-sum proxy (`thinkingMs`); those runs predate the per-turn instrumentation (801b4c7).
- **reflex calls** = `fast_status` + `fast_prewarm` + `fast_scout` (none can change the next action on this channel; all three are outside phase2).
- **overclaims** = cells where the runner returned `report_done` but live page state failed a checkpoint.

Read score before wall: on grok-4.6 the score is identical everywhere and the toolset barely moves wall (calls 100–110 → 91, reflex 16 → 0, but one cell — overlay — blew up to 174.7s; **excluding overlay, phase2 = 239.8s vs default 303.5s (d1) / 356.9s (d2) vs baseline 193.3s**). On grok-4.3 the wall collapses (55s, 1–3s turns) but **5 of 8 tests lose checkpoints and 4 of those are overclaimed**; its 264s model time is mostly two stalled opening turns (129.7s flightsearch, 49.8s mapsdir) that land before the first tool call and so outside wall — process wall (spawn→exit) for q1 is 286s.

## Per test, per pass

cell = score / wall s / model time s / calls / reflex.

| test | 1 `d1` default/4.6 | 1 `d2` default/4.6 | 2 `p1` phase2/4.6 | 3 `q1` phase2/4.3 | base wall / calls |
|---|---|---|---|---|---:|
| multipage | 6/6 / 14.3 / 13.0* / 7 / 1 | 6/6 / 11.9 / 10.7* / 8 / 2 | 6/6 / 38.7 / 13.4 / 5 / 0 | 6/6 / 5.5 / 22.0 / 5 / 0 | 16.9 / 8 |
| gcpform | 6/6 / 41.6 / 29.1* / 16 / 3 | 6/6 / 160.7 / 150.9* / 14 / 2 | 6/6 / 44.9 / 47.0 / 15 / 0 | **2/6** / 12.7 / 8.2 / 6 / 0 | 54.3 / 17 |
| staticform | 12/12 / 53.5 / 50.2* / 9 / 1 | 12/12 / 46.0 / 43.2* / 16 / 3 | 12/12 / 43.5 / 47.2 / 8 / 0 | 12/12 / 6.1 / 8.7 / 11 / 0 | 30.4 / 7 |
| overlay | 3/3 / 124.7 / 110.1* / 24 / 3 | 3/3 / 44.8 / 42.3* / 16 / 2 | 3/3 / 174.7 / 174.7 / 27 / 0 | **1/3** / 7.1 / 8.3 / 6 / 0 | 66.0 / 30 |
| extract | 22/22 / 9.7 / 9.1* / 4 / 0 | 22/22 / 7.8 / 7.1* / 4 / 0 | 22/22 / 14.8 / 25.2 / 4 / 0 | **19/22** / 1.7 / 7.2 / 2 / 0 | 5.7 / 3 |
| flightsearch | 10/10 / 67.2 / 63.6* / 22 / 3 | 10/10 / 49.8 / 47.0* / 15 / 2 | 10/10 / 42.2 / 44.2 / 15 / 0 | 10/10 / 9.2 / 145.4 / 10 / 0 | 23.3 / 12 |
| mapsdir | 6/6 / 48.1 / 38.5* / 14 / 2 | 6/6 / 55.7 / 37.9* / 18 / 3 | 6/6 / 24.4 / 27.0 / 10 / 0 | **4/6** / 7.2 / 57.4 / 7 / 0 | 41.9 / 15 |
| cfworkers | 5/5 / 69.2 / 63.1* / 14 / 3 | 5/5 / 25.0 / 34.4 / 9 / 2 | 5/5 / 31.3 / 40.4 / 7 / 0 | **2/5** / 5.9 / 7.0 / 3 / 0 | 20.7 / 7 |

q1 process wall (spawn → exit) per test: multipage 23.4, gcpform 16.0, staticform 10.8, overlay 10.9, extract 8.4, **flightsearch 146.1**, **mapsdir 59.6**, cfworkers 11.0 (s).

Variance on the same configuration (default, d1 vs d2): multipage 1.2×, gcpform **3.9×** (d2 = one 124s model turn), staticform 1.2×, overlay **2.8×**, extract 1.2×, flightsearch 1.3×, mapsdir 1.2×, cfworkers **2.8×**. The high-variance three are where Grok's path differs run to run (overlay: which widget it hits first; cfworkers: paginate vs scroll-to-bottom; gcpform: an upstream stall); the other five are deterministic paths whose wall is pure turn latency. Single-run phase2 numbers carry that spread — p1's multipage (38.7s) contains one 30s broker timeout and its overlay is the widget that varied 2.8× on default.

Environment: every cell ran first try — no IAM / login-wall / stale-localStorage retries in 32 cells. Two rows were re-run because my pruning of aborted passes caught them by timestamp: d2 cfworkers (original run `52bd8916`: 5/5 / 54.1s / 12 calls; recorded re-run 06:21: 5/5 / 25.0s / 9) and p1 cfworkers (original run `7e34e387`: 5/5 / 31.4s / 11 calls; recorded re-run 06:31: 5/5 / 31.3s / 7). All four were clean passes.

Token usage per run (input / output / cache-read, model turns; max single turn where instrumented):
- d1: multipage 26k/0.6k/134k (8); gcpform 57k/1.5k/264k (13); staticform 25k/3.0k/182k (10); overlay 53k/2.9k/589k (24); extract 9k/1.1k/82k (5); flightsearch 59k/3.1k/542k (18); mapsdir 35k/1.6k/291k (14); cfworkers 111k/3.7k/511k (14).
- d2: multipage 27k/0.6k/135k (8); gcpform 84k/1.6k/264k (14); staticform 13k/2.4k/224k (11); overlay 50k/1.7k/303k (16); extract 7k/1.4k/83k (5); flightsearch 32k/3.2k/337k (13); mapsdir 25k/2.2k/372k (16); cfworkers 19k/1.5k/185k (9, 8.0s).
- p1: multipage 9k/0.5k/33k (6, 3.6s); gcpform 33k/2.2k/202k (14, 6.4s); staticform 34k/2.6k/37k (9, 10.6s); overlay 108k/8.6k/468k (26, 20.7s); extract 48k/1.2k/88k (5, 10.5s); flightsearch 70k/2.3k/319k (16, 6.7s); mapsdir 25k/1.3k/97k (11, 3.3s); cfworkers 47k/2.0k/85k (8, 13.8s).
- q1: multipage 8k/0.4k/33k (6, 15.5s); gcpform 4k/0.6k/15k (4, 2.8s); staticform 15k/0.7k/26k (5, 2.6s); overlay 13k/0.5k/38k (6, 1.9s); extract 34k/0.5k/10k (3, 4.4s); flightsearch 16k/0.8k/26k (5, **129.7s**); mapsdir 11k/0.5k/34k (7, **49.8s**); cfworkers 16k/0.5k/10k (4, 2.7s). Output tokens are 3–17× lower than 4.6 on the same tests — the latency lever from `docs/GROK_LATENCY_2026-09-15.md` — but the model also stops one tool call short.

## Tool histogram (per toolset × model, all passes)

Generated by the driver into `bench/tool-usage.md` (that file is the exact, regenerated-per-cell record). `retry` = the next call was the same tool on the same target; `switch` = the next call was a different tool on the same target (e.g. `fast_wait "X"` → `fast_click "X"`, the reflex wait-then-click); `fumble %` = (retry+switch)/calls.

### default / grok-4.6 (d1 + d2, 16 cells)

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_click | 41 | 5 | 179 | 0 | 4 | 10 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, cfworkers |
| fast_wait | 30 | 2 | 886 | 0 | 10 | 33 | all 8 |
| fast_snapshot | 27 | 0 | 148 | 0 | 0 | 0 | gcpform, staticform, overlay, flightsearch, mapsdir, cfworkers |
| fast_fill | 16 | 0 | 187 | 0 | 0 | 0 | gcpform, flightsearch, mapsdir |
| fast_tab | 16 | 0 | 679 | 0 | 0 | 0 | all 8 |
| fast_status | 14 | 0 | 158 | 0 | 0 | 0 | 7 of 8 (never extract) |
| fast_prewarm | 12 | 0 | 87 | 0 | 0 | 0 | 7 of 8 |
| fast_scroll | 9 | 0 | 193 | 0 | 0 | 0 | gcpform, overlay, flightsearch, cfworkers |
| fast_click_xy | 7 | 0 | 198 | 0 | 0 | 0 | overlay |
| fast_text | 7 | 0 | 125 | 0 | 0 | 0 | staticform, flightsearch, mapsdir, extract |
| fast_key_press | 6 | 0 | 152 | 0 | 0 | 0 | staticform, overlay, flightsearch, mapsdir |
| fast_scout | 6 | 0 | 1566 | 0 | 0 | 0 | gcpform, staticform, overlay, flightsearch, mapsdir, cfworkers |
| fast_select_option | 6 | 3 | 1138 | 0 | 1 | 17 | gcpform, staticform, overlay, flightsearch |
| fast_evaluate | 5 | 5 | 132 | 0 | 0 | 0 | staticform, flightsearch, extract |
| fast_batch | 3 | 0 | 2976 | 0 | 0 | 0 | gcpform, staticform |
| fast_screenshot | 2 | 0 | 461 | 0 | 0 | 0 | staticform |
| fast_type | 2 | 0 | 209 | 0 | 1 | 50 | overlay |
| fast_do | 1 | 0 | 3600 | 0 | 0 | 0 | overlay |
| fast_fill_form | 1 | 0 | 231 | 0 | 0 | 0 | staticform |

211 calls across 19 distinct tools; 16 fumbles (8%). 19 of the 45 listed tools were ever used.

### phase2 / grok-4.6 (p1, 8 cells)

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_snapshot | 19 | 0 | 211 | 0 | 0 | 0 | all 8 |
| fast_click | 18 | 4 | 1839 | 1 | 2 | 17 | multipage, gcpform, overlay, flightsearch, mapsdir, cfworkers |
| fast_fill | 10 | 1 | 160 | 0 | 0 | 0 | gcpform, overlay, flightsearch, mapsdir |
| fast_text | 9 | 0 | 141 | 0 | 0 | 0 | gcpform, staticform, overlay, extract, cfworkers |
| fast_tab | 8 | 0 | 420 | 0 | 0 | 0 | all 8 |
| fast_wait | 6 | 0 | 231 | 0 | 1 | 17 | multipage, mapsdir, cfworkers |
| fast_evaluate | 5 | 5 | 207 | 0 | 0 | 0 | gcpform, staticform, overlay, flightsearch, extract |
| fast_scroll | 4 | 0 | 232 | 0 | 0 | 0 | gcpform, overlay |
| fast_batch | 3 | 0 | 1366 | 0 | 0 | 0 | staticform, flightsearch |
| fast_click_xy | 3 | 0 | 224 | 0 | 0 | 0 | overlay |
| fast_select_option | 3 | 2 | 2380 | 0 | 1 | 33 | gcpform, overlay |
| fast_key_press | 2 | 0 | 156 | 0 | 0 | 0 | staticform, mapsdir |
| fast_nav | 1 | 0 | 730 | 0 | 0 | 0 | overlay |

91 calls across 13 distinct tools (all 13 of phase2's raw tools were used); 5 fumbles (5%). `fast_click` avg 1839ms is one 30s broker timeout (multipage) — the other 17 clicks averaged ~180ms. `fast_wait` fell from 30 calls (33% reflex) to 6.

### phase2 / grok-4.3 (q1, 8 cells)

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_fill | 13 | 3 | 137 | 0 | 0 | 0 | gcpform, staticform, flightsearch, mapsdir |
| fast_snapshot | 11 | 0 | 208 | 0 | 0 | 0 | all 8 |
| fast_click | 9 | 3 | 137 | 2 | 1 | 33 | multipage, staticform, overlay, mapsdir |
| fast_tab | 8 | 0 | 436 | 0 | 0 | 0 | all 8 |
| fast_select_option | 6 | 1 | 1206 | 0 | 0 | 0 | gcpform, staticform, overlay, flightsearch |
| fast_evaluate | 1 | 1 | 114 | 0 | 0 | 0 | flightsearch |
| fast_text | 1 | 0 | 99 | 0 | 0 | 0 | staticform |
| fast_wait | 1 | 0 | 2987 | 0 | 0 | 0 | cfworkers |

50 calls across 8 distinct tools; 3 fumbles (6%). Never used: `fast_scroll`, `fast_batch`, `fast_click_xy`, `fast_key_press`, `fast_nav`. 4.3 fills field-by-field (13 fills, no batch) at 0.1–0.3s per turn, which is why staticform's 11 calls took 6.1s.

## Fumbles

Read from the run store's tool log (args + result preview per call). "reflex" = a call whose result could not change the next action.

### Cross-cutting

- **`fast_status` as call #1, `fast_prewarm` as call #2** (default only) — 14 + 12 of 16 cells; each is a full model turn (1–3s). Gone in phase2 (not listed).
- **`fast_evaluate` is BLOCKED on this relay account** (`evalBlocked`, "enable it in relay settings") — 5/5 errors on default, 5/5 on phase2/4.6 despite its description saying "may be disabled; if so use fast_text", 1/1 on 4.3. Grok reaches for it to read forms/tables (staticform, extract, gcpform read-back), to get today's date (flightsearch in all three configurations: `() => new Date().toISOString()`), and as an escape hatch when a widget resists (overlay p1). It is the one listed tool that can never succeed here. Whether the 08-06 grok.com account had it enabled is unknown (different Google account).
- **reflex wait-then-click** — `fast_wait "X"` immediately followed by `fast_click "X"` (default: 10 of 30 waits; phase2: 1 of 6; 4.3: 0). The click would have waited/failed identically; each is a model turn.
- **`fast_select_option` on a non-native control** — `<cfc-select>` "no listbox detected" (5.7–6.2s) in all four gcpform runs; react-select `field "Single" not found` in all three 4.6 overlay runs. 4.6 recovers with click-combobox + click-option every time; 4.3 does not recover (see below). The success shape everywhere: `selections:{…}` / per-field on aa.com's native selects.
- **snapshot element id passed as `index`** — `fast_click {text, index:388}` (p1 cfworkers), `{text:"Directions", index:6}` (q1 mapsdir): both models read the snapshot's `i` as the click `index` (which is the nth text match). Description/schema fix candidate.
- **post-completion verification thrash (4.6 only)** — after the task is visibly done Grok spends 3–10 more calls "confirming" (screenshots, `fast_text` html dumps, `Escape`, `fast_scout {}`, blind `fast_click_xy`). staticform d2: 7 of 16 calls after the form was complete at 13.5s; overlay d1: 10 of 24 after Forest was selected at 62s; staticform p1: 3 of 8. 4.3 has the opposite failure: it stops before reading back.

### Per test (4.6 passes)

- **multipage** — d1/d2 clean apart from reflex waits (3 of 7–8 calls). p1: 5 calls, but `fast_click "It's Only the Himalayas"` hit the **30s broker timeout** (ERR; the page had navigated — the response never came back), so wall 38.7s is ~8s of work + one dead 30s. Extension/relay hiccup, not toolset.
- **gcpform** — d1: `fast_batch [select_option, fill]` aborted at step 0 (7s + 2 recovery clicks); redundant `fast_snapshot` after `fast_fill`. d2: **one model turn took 124s** (t=8.7→133.3s, before `fast_select_option`) — nothing in the proxy log, run predates turn instrumentation; then the same select_option failure (6.2s) + recovery; excluding that turn ≈37s. p1: same failure (5.8s) + recovery, redundant snapshot after fill, blocked `fast_evaluate` for the read-back → `scroll top` + `fast_text cfc-virtual-viewport`. Section targeting (`Add URI` index 0/1, `URIs 1` index 1) was right all three times.
- **staticform** — d1: 94% of 53.5s was model turns on 9 calls (8s to compose the batch, 20s before a stray `Escape`, 8s before a `fast_screenshot`). d2: the right shape in 4 calls (`fast_fill_form` + `fast_select_option` + 2 clicks, done at 13.5s), then 7 verification calls ending in `fast_click "Web form"` ERR (clicking the heading). p1: blocked `fast_evaluate` to list datalist options, two `fast_batch`es (done at 25s), then `fast_text html` + `fast_snapshot screenshot` + `Escape` (3 verification calls, 20s).
- **overlay** — the cell that decides the suite's wall. d1 (24 calls / 125s): select_option ERR; `fast_click "Ocean"` hit the **Remove Ocean** chip of the multi-select demo at y=1881; 3 blind `fast_click_xy`; Forest selected at 62s, then 10 calls / 65s re-verifying (`fast_do` whose own plan read "Dropdown with current value Forest", `fast_type` + Enter). d2 (16 / 45s): same opening, Forest at 26s, 6 more calls. **p1 (27 / 175s, 108k in / 8.6k out, max turn 20.7s)**: select_option ERR → click Ocean → xy → blocked `fast_evaluate` → 3× `fast_fill {section:"Single"}` (typed "Forest" into the react-select input without selecting) → `fast_click role:combobox` ERR ×2 → **`fast_nav` reload of the page at 132s** (threw away its own state) → 4× `fast_text html` probing ids → `fast_select_option {field:"react-select-3-input"}` finally succeeded at 171s. Without `fast_do`/`fast_type`/`fast_scout`, phase2 left 4.6 fewer escape hatches and it burned them on the blocked `fast_evaluate` and html spelunking. grok.com also needed 30 calls here.
- **extract** — all 4.6 passes: `fast_evaluate` blocked → `fast_text`; 4 calls. p1 was slower (14.8s, model 25.2s) because it opened with `fast_snapshot {full:true}` on the whole article (48k input) and the report turn took 10.5s.
- **flightsearch** — d1 (22): `fast_wait "From"` satisfied by "Offers **from** our partners"; `fast_scout {}`; scroll thrash; `fast_text body maxLen:50`; 5-click calendar + `Escape`. d2 (15): blocked `fast_evaluate` for the date, then typed the dates straight into the inputs; three selects in one `fast_select_option {selections}`. p1 (15, 42.2s): blocked `fast_evaluate` again; calendar path (open, snapshot, 30, 7) then **`fast_batch [Done, select_option{3 selections}]`** — the best shape seen.
- **mapsdir** — d1: `fast_wait "Choose starting point"` timed out (6.8s); after `Search` had requested the route, 2 dead-end clicks on autocomplete text not in the DOM. d2 (18): `fast_wait "fastest route"` timed out **13s**; 2 dead-end clicks + `fast_scout`; route had loaded anyway. **p1 (10 calls, 24.4s) — the cleanest cell of the suite**: Directions → wait (found in 150ms) → 2 fills → Enter → wait "min" → Search → wait networkIdle → snapshot. The same `fast_wait "Choose starting point"` that timed out in d1 returned in 150ms in d2 and p1 — consistent with the `page.js` storm-safe fast_wait fix (853f5d7) being loaded into Chrome between d1 and d2; see caveats.
- **cfworkers** — d1 (14 / 69s): `fast_scout` 3.4s + full snapshot, paged the 26-app list before opening fastlink-relay; 4.9s/turn on 111k input. d2 (9 / 25s): full snapshot → `scroll to bottom` → click. p1 (7 / 31s): the `index:388` mistake above, retried with `index:1`; 14s turn on the 47k-token snapshot. All three read "other Workers you saw" differently; nothing scores it.

### Pass 3 — grok-4.3 dropped checkpoints (test → mis-chosen tool)

- **gcpform 2/6** (status `error`, no claim) — `fast_select_option "Application type"` failed exactly as on 4.6 ("no listbox detected"), but instead of the click-combobox + click-option recovery 4.6 uses, 4.3 went straight to `fast_fill "Name"` → "No fillable element" (the Name input is only rendered after an application type is picked) → `fast_fill "Authorized JavaScript origins"` → same → **3 consecutive errors, runner budget stop** at 15s. Mis-choice: `fast_fill` on fields that do not exist yet, no recovery from the select_option miss. Only the tab + "Create not clicked" checkpoints passed.
- **overlay 1/3** (overclaimed) — `fast_click "Ocean" role:combobox` ERR (only match is the `Remove Ocean` button) → `fast_click "Ocean" index:0` clicked **Remove Ocean** on the multi-select demo → `fast_select_option {field:"Ocean", option:"Forest"}` "picked Forest" — in the **wrong select** (the one it had just found "Ocean" in). Live value of the first dropdown: still "Ocean". Reported "Selected Forest in the first Single dropdown" without reading it back. Mis-choice: `fast_click "Ocean"` (ranking hit the chip, same as 4.6) then `fast_select_option` keyed on `field:"Ocean"` instead of the section heading.
- **extract 19/22** (overclaimed) — 2 calls: `fast_snapshot {full, limit:100}` then `report_done`. It answered from the capped snapshot and **counted the "World" aggregate row as #1**, so Mexico (#10) fell off and the order checkpoint failed; values were also rounded ("1.429B"). Mis-choice: no `fast_text` on the table (every 4.6 run used it and excluded World).
- **mapsdir 4/6** (overclaimed) — `fast_click "Directions" index:6` ERR (snapshot id as index) → `fast_click {text:"", role:"button"}` happened to hit Directions → `fast_fill "Choose starting point"` **0.8s after the click, before the input rendered** → "No fillable element" → no retry, filled only the destination → snapshot → done. Live: start = "Your location", no route. Mis-choice: `fast_fill` with no `fast_wait` after a view change, and reporting "3 route options" it never saw.
- **cfworkers 2/5** (overclaimed) — 3 calls: tab → `fast_wait networkIdle` → `fast_snapshot full` → `report_done` listing names from the list. **It never clicked into fastlink-relay** although the prompt says "open the Worker". Mis-choice: no `fast_click` at all — the report turn replaced the action.
- flightsearch 10/10 — correct shape (6 fills, 3 selects, 10 calls, 9.2s) but the dates it typed were **11/20/2024 – 11/27/2024**, in the past: `fast_evaluate` for today's date was blocked and 4.3 guessed a 2024 date (4.6 guessed 2026). The checkpoints assert only the mm/dd/yyyy shape and return-after-departure, so this passed; a real booking would not. Also the 129.7s opening turn.
- multipage 6/6 (5 calls, 5.5s) and staticform 12/12 (11 calls, 6.1s) — clean; staticform filled field-by-field at 0.1–0.3s per turn.

## Driver notes (`bench/` only — `fast-runner/` untouched by this pass)

- runner results rows re-derive wall/calls from the run store's tool log after exit (the streamed stderr rows lagged by one call: flightsearch d1 22 vs 23).
- `ms < 0` in the run store (`fast_wait` −859ms d1 flightsearch, `fast_tab` −1424ms d2 mapsdir: `Date.now()` went backwards inside the runner — WSL clock skew) is clamped to 0.
- `--toolset <name>` on `run.js` → `cli.mjs --toolset`; `toolset` + `model` recorded on the results row and each usage row (backfilled from the run store for older rows). `FASTRUN_MODEL` is inherited by the spawned runner from the environment.
- `tool-usage.md` aggregates ALL cells, one table per toolset × model, with `retry` / `switch` / `fumble %` per tool; each usage row records a `target` per call.

## Caveats (concurrent work in the same checkout)

- `fast-runner/` changed under the bench between passes (f3d8b20 explicit toolsets, 801b4c7 turn instrumentation, a9a1cd0 terse `report_done` in phase2). `default` resolves to the same `toolset.json` throughout, so d1 and d2 are one configuration; p1 ran before a9a1cd0's terse report (its `report_done` turns were 10–13s on extract/cfworkers), q1 ran after it — so pass 2 vs 3 differs by model AND by the report description.
- `fast-ext/src/actions/page.js` received four tool fixes (853f5d7 and an uncommitted follow-up) during the bench. Whether the user's Chrome reloaded them mid-bench is not recorded; the mapsdir `fast_wait` evidence says it did between d1 and d2, while `fast_select_option` on `<cfc-select>` still failed in every later run and the react-select `field "Single"` lookup still failed in p1. Treat cross-pass tool-behaviour differences as partly extension-version, not only model/toolset.
- q1's two opening-turn stalls (129.7s, 49.8s) are upstream (xAI) latency on grok-4.3's first turn; the turn record shows `attempts:1`, so no proxy retry. They are excluded from wall by definition and included in model time.

## Open items

- **Score before wall: grok-4.3 is not a drop-in.** 56/70 with 4 overclaims — it stops one action short (cfworkers, mapsdir) or acts without reading back (overlay, extract). Its per-turn speed is real (staticform 6.1s for 11 calls). Candidates: 4.3 with a mandatory read-back step in `report_done`'s description, or 4.6 for the loop with 4.3 only for report turns.
- `fast_evaluate` blocked for the runner's relay account and reached for in 11 of 32 cells — enable it for this account or drop it from phase2; the "may be disabled" description did not stop the reach. Both models also want it for **today's date** — a `date`/`now` hint in the system prompt would remove that call outright.
- overlay is the suite's variance on 4.6: 45–175s on identical prompts. The `page.js` react-select fixes target its first failure (`field "Single" not found`); re-bench once the extension is confirmed reloaded.
- Snapshot `i` vs click `index` confusion appeared in both models — tighten the `fast_click` description/schema (phase 2 triage input).
- One unexplained 124s model turn (gcpform d2) on 4.6; two 50–130s opening turns on 4.3. Turn instrumentation now records `latencyMs`/`attempts` per turn for the next pass to correlate.
- Post-completion verification thrash (4.6) is the biggest call sink after reflex openers: the system prompt's "never claim success without reading it back" is over-applied there (3–10 confirmation calls after one clean read-back) and under-applied by 4.3.
