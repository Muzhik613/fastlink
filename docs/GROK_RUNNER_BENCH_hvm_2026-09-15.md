# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 3 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T06:12:56.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

## Per test

Cell = `score/total wall calls` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | pass 3 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 14.8s 9c | 0/6 107.4s 48c ! | – | 14.8s | 61.1s | 28.5 | 0–6/6 | 16.9s | −2.1s (-12%) |
| staticform | 12/12 19.8s 5c | 12/12 25.3s 6c | – | 19.8s | 22.5s | 5.5 | 12–12/12 | 30.4s | −10.6s (-35%) |
| overlay | 3/3 53.3s 19c | 3/3 24.7s 7c | – | 24.7s | 39.0s | 13 | 3–3/3 | 66.0s | −41.3s (-63%) |
| flightsearch | 10/10 57.9s 21c | 10/10 47.8s 17c | – | 47.8s | 52.9s | 19 | 10–10/10 | 23.3s | +24.5s (105%) |
| mapsdir | 6/6 20.8s 11c | 6/6 32.6s 17c | – | 20.8s | 26.7s | 14 | 6–6/6 | 41.9s | −21.1s (-50%) |
| extract | 22/22 7.0s 3c | 20/22 6.5s 3c ! | – | 6.5s | 6.7s | 3 | 20–22/22 | 5.7s | +0.8s (14%) |

Totals over valid cells: 12 cells, 110/118 checkpoints, 166 tool calls, 417.9s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED, multipage#2=FINISHED, staticform#2=FINISHED, overlay#2=FINISHED, extract#2=FINISHED, flightsearch#2=FINISHED, mapsdir#2=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_status | 50 | 0 | 5 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_wait | 26 | 2 | 43 | 7 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 14 | 1 | 60 | 4 | multipage, overlay, flightsearch, mapsdir |
| fast_tab | 12 | 0 | 284 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_evaluate | 11 | 0 | 34 | 0 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_snapshot | 11 | 0 | 33 | 0 | multipage, overlay, flightsearch, mapsdir |
| fast_fill | 10 | 0 | 77 | 0 | flightsearch, mapsdir |
| fast_prewarm | 9 | 0 | 2 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_click_xy | 6 | 0 | 47 | 0 | overlay, mapsdir |
| fast_select_option | 4 | 1 | 308 | 1 | overlay, flightsearch |
| fast_batch | 2 | 0 | 2036 | 0 | staticform |
| fast_list | 2 | 1 | 10 | 1 | multipage, flightsearch |
| fast_scout | 2 | 0 | 3961 | 0 | flightsearch |
| fast_text | 2 | 0 | 13 | 0 | mapsdir |
| fast_fill_form | 1 | 0 | 66 | 0 | mapsdir |
| fast_key_press | 1 | 0 | 17 | 0 | mapsdir |
| fast_nav | 1 | 1 | 3 | 1 | multipage |
| fast_scroll | 1 | 0 | 65 | 0 | overlay |
| fast_type | 1 | 0 | 82 | 1 | overlay |

Total: 166 calls across 19 distinct tools, 15 fumbles.

## Fumbles

- pass 1 multipage #4: `fast_wait` (text=Travel) — switched to fast_click on the same target
- pass 1 multipage #5: `fast_click` (text=Travel) — switched to fast_wait on the same target
- pass 1 multipage #8: `fast_click` (text=It's Only the Himalayas) — switched to fast_wait on the same target
- pass 1 overlay #5: `fast_select_option` — failed → followed by fast_click — {"error":"field \"Single\" not found","origin":"https://react-select.com"}
- pass 1 overlay #9: `fast_wait` (text=Forest) — switched to fast_click on the same target
- pass 1 overlay #16: `fast_type` (text=Forest) — switched to fast_wait on the same target
- pass 1 flightsearch #4: `fast_wait` (text=From) — failed → followed by fast_list — {"error":"fast_wait: could not inject into target tab 81232633 (Frame with ID 0 was removed.). The t
- pass 1 mapsdir #4: `fast_wait` (text=Directions) — switched to fast_click on the same target
- pass 2 multipage #4: `fast_wait` (text=Travel) — switched to fast_click on the same target
- pass 2 multipage #5: `fast_click` (text=Travel) — switched to fast_wait on the same target
- pass 2 multipage #6: `fast_wait` (text=Travel) — failed → followed by fast_status — {"error":"Chrome extension not connected."}
- pass 2 multipage #29: `fast_list` — failed → followed by fast_status — {"error":"Chrome extension not connected."}
- pass 2 multipage #36: `fast_nav` (url=https://books.toscrape.com/catalogue/category/books/travel_2) — failed → followed by fast_status — {"error":"Chrome extension not connected."}
- pass 2 mapsdir #4: `fast_wait` (text=Directions) — switched to fast_click on the same target
- pass 2 mapsdir #13: `fast_click` (text=Times Square New York, Manhattan, NY) — failed → followed by fast_click_xy — {"diagnostics":["Text \"Times Square New York, Manhattan, NY\" not found in document, open shadow DO
