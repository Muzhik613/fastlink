# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 3 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T06:12:56.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

## Per test

Cell = `score/total wall calls` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | pass 3 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 14.8s 9c | – | – | 14.8s | 14.8s | 9 | 6–6/6 | 16.9s | −2.1s (-12%) |
| staticform | 12/12 19.8s 5c | – | – | 19.8s | 19.8s | 5 | 12–12/12 | 30.4s | −10.6s (-35%) |
| overlay | 3/3 53.3s 19c | – | – | 53.3s | 53.3s | 19 | 3–3/3 | 66.0s | −12.7s (-19%) |
| flightsearch | 10/10 57.9s 21c | – | – | 57.9s | 57.9s | 21 | 10–10/10 | 23.3s | +34.6s (149%) |
| mapsdir | 6/6 20.8s 11c | – | – | 20.8s | 20.8s | 11 | 6–6/6 | 41.9s | −21.1s (-50%) |
| extract | 22/22 7.0s 3c | – | – | 7.0s | 7.0s | 3 | 22–22/22 | 5.7s | +1.3s (22%) |

Totals over valid cells: 6 cells, 59/59 checkpoints, 68 tool calls, 173.6s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_wait | 16 | 1 | 48 | 4 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 9 | 0 | 63 | 2 | multipage, overlay, flightsearch, mapsdir |
| fast_snapshot | 6 | 0 | 33 | 0 | multipage, overlay, flightsearch, mapsdir |
| fast_tab | 6 | 0 | 324 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click_xy | 5 | 0 | 47 | 0 | overlay |
| fast_evaluate | 5 | 0 | 31 | 0 | staticform, flightsearch, mapsdir, extract |
| fast_status | 5 | 0 | 8 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_fill | 4 | 0 | 100 | 0 | flightsearch |
| fast_prewarm | 4 | 0 | 3 | 0 | multipage, overlay, flightsearch, mapsdir |
| fast_select_option | 2 | 1 | 69 | 1 | overlay, flightsearch |
| fast_batch | 1 | 0 | 2063 | 0 | staticform |
| fast_fill_form | 1 | 0 | 66 | 0 | mapsdir |
| fast_list | 1 | 0 | 17 | 0 | flightsearch |
| fast_scout | 1 | 0 | 1563 | 0 | flightsearch |
| fast_scroll | 1 | 0 | 65 | 0 | overlay |
| fast_type | 1 | 0 | 82 | 1 | overlay |

Total: 68 calls across 16 distinct tools, 8 fumbles.

## Fumbles

- pass 1 multipage #4: `fast_wait` (text=Travel) — switched to fast_click on the same target
- pass 1 multipage #5: `fast_click` (text=Travel) — switched to fast_wait on the same target
- pass 1 multipage #8: `fast_click` (text=It's Only the Himalayas) — switched to fast_wait on the same target
- pass 1 overlay #5: `fast_select_option` — failed → followed by fast_click — {"error":"field \"Single\" not found","origin":"https://react-select.com"}
- pass 1 overlay #9: `fast_wait` (text=Forest) — switched to fast_click on the same target
- pass 1 overlay #16: `fast_type` (text=Forest) — switched to fast_wait on the same target
- pass 1 flightsearch #4: `fast_wait` (text=From) — failed → followed by fast_list — {"error":"fast_wait: could not inject into target tab 81232633 (Frame with ID 0 was removed.). The t
- pass 1 mapsdir #4: `fast_wait` (text=Directions) — switched to fast_click on the same target
