# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 3 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T06:12:56.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

## Per test

Cell = `score/total wall calls` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | pass 3 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 14.8s 9c | 0/6 107.4s 48c ! | – | 14.8s | 61.1s | 28.5 | 0–6/6 | 16.9s | −2.1s (-12%) |
| staticform | 12/12 19.8s 5c | 12/12 25.3s 6c | 12/12 23.6s 6c | 19.8s | 23.6s | 6 | 12–12/12 | 30.4s | −10.6s (-35%) |
| overlay | 3/3 53.3s 19c | 3/3 24.7s 7c | 3/3 22.2s 7c | 22.2s | 24.7s | 7 | 3–3/3 | 66.0s | −43.8s (-66%) |
| flightsearch | 10/10 57.9s 21c | 10/10 47.8s 17c | 10/10 42.7s 16c | 42.7s | 47.8s | 17 | 10–10/10 | 23.3s | +19.4s (83%) |
| mapsdir | 6/6 20.8s 11c | 6/6 32.6s 17c | 6/6 53.1s 24c | 20.8s | 32.6s | 17 | 6–6/6 | 41.9s | −21.1s (-50%) |
| extract | 22/22 7.0s 3c | 20/22 6.5s 3c ! | 20/22 6.0s 3c ! | 6.0s | 6.5s | 3 | 20–22/22 | 5.7s | +0.3s (6%) |

Totals over valid cells: 17 cells, 161/171 checkpoints, 222 tool calls, 565.5s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED, multipage#2=FINISHED, staticform#2=FINISHED, overlay#2=FINISHED, extract#2=FINISHED, flightsearch#2=FINISHED, mapsdir#2=FINISHED, staticform#3=FINISHED, overlay#3=FINISHED, extract#3=FINISHED, flightsearch#3=FINISHED, mapsdir#3=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_status | 54 | 0 | 5 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_wait | 37 | 4 | 184 | 10 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 20 | 2 | 55 | 5 | multipage, overlay, flightsearch, mapsdir |
| fast_snapshot | 20 | 0 | 38 | 0 | multipage, overlay, flightsearch, mapsdir |
| fast_tab | 17 | 0 | 282 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_evaluate | 16 | 0 | 36 | 0 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_fill | 14 | 0 | 80 | 0 | flightsearch, mapsdir |
| fast_prewarm | 12 | 0 | 2 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_click_xy | 9 | 0 | 53 | 0 | overlay, mapsdir |
| fast_select_option | 5 | 1 | 444 | 1 | overlay, flightsearch |
| fast_batch | 4 | 0 | 1592 | 0 | staticform, flightsearch |
| fast_scout | 3 | 0 | 3317 | 0 | flightsearch |
| fast_type | 3 | 0 | 59 | 2 | overlay, mapsdir |
| fast_list | 2 | 1 | 10 | 1 | multipage, flightsearch |
| fast_text | 2 | 0 | 13 | 0 | mapsdir |
| fast_fill_form | 1 | 0 | 66 | 0 | mapsdir |
| fast_key_press | 1 | 0 | 17 | 0 | mapsdir |
| fast_nav | 1 | 1 | 3 | 1 | multipage |
| fast_scroll | 1 | 0 | 65 | 0 | overlay |

Total: 222 calls across 19 distinct tools, 20 fumbles.

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
- pass 3 flightsearch #8: `fast_wait` (text=John F. Kennedy) — failed → followed by fast_snapshot — {"error":"Timed out waiting for \"John F. Kennedy\"","headings":["Book flights","Cities and dates","
- pass 3 mapsdir #4: `fast_wait` (text=Directions) — switched to fast_click on the same target
- pass 3 mapsdir #8: `fast_type` (text=John F. Kennedy International Airport) — switched to fast_wait on the same target
- pass 3 mapsdir #11: `fast_click` (text=Jamaica, NY) — failed → followed by fast_click_xy — {"diagnostics":["2 non-interactive match(es) — fast_click only fires on buttons/links/inputs/[role]/
- pass 3 mapsdir #13: `fast_wait` (text=Times Square) — failed → followed by fast_snapshot — {"error":"Timed out waiting for \"Times Square\"","headings":["Delays"],"origin":"https://www.google
