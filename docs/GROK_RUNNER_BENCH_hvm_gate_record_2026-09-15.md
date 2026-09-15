# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 3 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T20:32:47.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: 4.3 alone: gate record-only on 3839858 pass 1 on 3839858 (grok-4.3, toolset phase2, gate record);

Run store per pass (model/toolset/gate): pass 1 = grok-4.3/phase2/gate record.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | pass 3 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 5.1s 5c m=8.1s | – | – | 5.1s | 5.1s | 5 | 6–6/6 | 16.9s | −11.8s (-70%) |
| staticform | 12/12 8.2s 4c m=8.3s | – | – | 8.2s | 8.2s | 4 | 12–12/12 | 30.4s | −22.2s (-73%) |
| overlay | 3/3 7.3s 4c m=6.9s | – | – | 7.3s | 7.3s | 4 | 3–3/3 | 66.0s | −58.7s (-89%) |
| flightsearch | 10/10 11.0s 5c m=15.2s | – | – | 11.0s | 11.0s | 5 | 10–10/10 | 23.3s | −12.3s (-53%) |
| mapsdir | 6/6 7.6s 6c m=10.0s | – | – | 7.6s | 7.6s | 6 | 6–6/6 | 41.9s | −34.3s (-82%) |
| extract | 22/22 5.0s 3c m=9.6s | – | – | 5.0s | 5.0s | 3 | 22–22/22 | 5.7s | −0.7s (-13%) |

Totals over valid cells: 6 cells, 59/59 checkpoints, 27 tool calls, 44.1s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED.

## Gate would-refuse (gate=record)

- pass 1 overlay: scored 3/3 (full — the gate would have been WRONG) — no tool has read the page since your last fast_select_option; call fast_snapshot or fast_text (its own auto-snapshot is not a read-back) and cite what it return | your last attempt to fast_click "Ocean" failed and was never retried; retry it or explain in `result` why it is not needed
- pass 1 flightsearch: scored 10/10 (full — the gate would have been WRONG) — your result says "opened" but no fast_click / fast_nav / fast_tab (beyond the first page load) call succeeded. If the task asked you to open, do it now; only if

## Overclaims (reported done, score < total)

- none

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_snapshot | 10 | 0 | 132 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 6 | 0 | 329 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 4 | 1 | 584 | 1 | multipage, overlay, mapsdir |
| fast_batch | 2 | 0 | 2761 | 0 | staticform, flightsearch |
| fast_text | 2 | 0 | 40 | 0 | flightsearch, extract |
| fast_fill | 1 | 0 | 348 | 0 | mapsdir |
| fast_key_press | 1 | 0 | 22 | 0 | mapsdir |
| fast_select_option | 1 | 0 | 914 | 0 | overlay |

Total: 27 calls across 8 distinct tools, 1 fumbles.

## Fumbles

- pass 1 overlay #3: `fast_click` (text=Ocean) — failed → followed by fast_select_option — {"error":"Found 1 match(es) for \"Ocean\" but none satisfied role=\"combobox\". Nothing was clicked 
